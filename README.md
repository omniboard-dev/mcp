# Omniboard.dev MCP

MCP server that exposes Omniboard agentic check runs to coding agents.

One agentic run consists of one prompt and its tracked progress. Tools identify a
run with its `runKey`.

## Environment

`OMNIBOARD_API_KEY_MCP` is required and should be passed through the MCP client
configuration. The server uses it to read agentic runs, retrieve repository
access when required, and report run progress.

### Optional

`OMNIBOARD_API_URL` overrides the Omniboard API URL. It defaults to
`https://api.omniboard.dev`.

`OMNIBOARD_API_KEY` enables analyzer validation in developer-local mode. Omit
it when connected agents should not run `@omniboard/analyzer`.

`OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS=true` permits local `file:`
repositories and loopback HTTP Git/GitLab endpoints for isolated local tests.
Leave it unset in normal runner deployments.

## Registering the MCP server

The server uses the standard MCP stdio transport. Configure the MCP client to run
the package with `npx` and pass the MCP key in the server environment.

### Claude Desktop, Cursor, and other JSONC clients

```jsonc
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key",
        "OMNIBOARD_API_KEY": "your-api-key" // optional
      }
    }
  }
}
```

### Codex `config.toml`

```toml
[mcp_servers.omniboard]
command = "npx"
args = ["-y", "@omniboard/mcp"]
startup_timeout_sec = 30

[mcp_servers.omniboard.env]
OMNIBOARD_API_KEY_MCP = "your-api-key"
OMNIBOARD_API_KEY = "your-api-key" # optional
```

## Developer-local mode

Developer-local mode is for an agent already working inside the repository that
should be changed. The server resolves the current directory as an Omniboard
project, exposes agentic runs for that project, and reports progress against the
local workspace.

This mode does not create or manage another checkout. The connected agent owns
the normal development workflow: inspect the project, edit the current
workspace, run verification, and use the local progress tools to report
milestones. Analyzer validation is available only when
`OMNIBOARD_API_KEY` is configured.

### Tools

#### `omniboard_local_list_agentic_runs`

Lists agentic runs for the resolved current project. Pass `checkName` to scope
the list to one agentic check.

#### `omniboard_local_get_agentic_run`

Returns one agentic run by `runKey`, including its prompt, progress, and agent
instructions. It also reports the run as `in_progress` idempotently.

#### `omniboard_local_report_agentic_run_progress`

Reports a workflow milestone for one run. Supported milestones include
`implemented`, `needs_input`, `verified`, `committed`, `pushed`,
`mr_created`, `merged`, `blocked`, and `failed`.

The tool can also report repository, commit, merge request, pipeline,
verification, error, note, and metadata details.

#### `omniboard_local_validate_agentic_run`

Validates one run by `runKey`. The server resolves the check name, runs the
analyzer when `OMNIBOARD_API_KEY` is available, evaluates whether the check
still matches, and reports either `verified` or `needs_input`.

When the analyzer key is absent, validation is skipped and the tool reports
`implemented`.

## Dedicated runner mode

Dedicated runner mode is for a consumer-operated automation process that handles
agentic work across projects. A scheduler, queue worker, CI job, cron process, or
similar coordinator selects runs and projects. Scheduling and concurrency stay
outside the MCP server.

The MCP server prepares and finalizes runner-owned checkouts. The connected
coding agent performs the requested code change inside the returned workspace
and runs the relevant project verification before finalization.

### Workspace layout

The MCP process working directory is the root of the consumer's automation
project. On first preparation, the server creates:

```text
.omniboard/
  mcp/
    .gitignore
    state/
    workspaces/
```

The generated `.gitignore` excludes `state/` and `workspaces/`. If the
file already exists, its content is preserved and only missing runtime entries
are added.

Each checkout is created under `workspaces/`. Retry metadata is stored
separately under `state/`, records the prepared HEAD and completed commit SHA,
and never contains repository credentials. The metadata is authenticated and
finalization rejects modified state. Retained workspaces must be finalized with
the same MCP key that prepared them.

### Workflow

1. Call `omniboard_runner_list_agentic_runs` to select an active run unless
   the scheduler already supplies a run key.
2. Call `omniboard_runner_list_agentic_run_projects` for the selected run.
3. Select a project and call
   `omniboard_runner_prepare_agentic_run_workspace`.
4. Give the returned prompt, result context, and workspace path to the connected
   coding agent.
5. Run the relevant tests, lint, or build commands inside that workspace.
6. Call `omniboard_runner_finalize_agentic_run_workspace` with the commit and
   merge request wording.
7. Retain the workspace and state for inspection, or remove both after
   downstream processing completes.

### Repository access and safety

Preparation performs a read-only GitLab permission preflight before creating a
workspace. It verifies project visibility, repository and merge request
availability, archive state, and effective push and merge request permissions.
Project policy or branch protection can still change after the preflight.

Repository access is retrieved only when a credentialed Git operation is
required. Repository and GitLab API URLs must use HTTPS by default. Local
`file:` repositories and loopback HTTP endpoints are rejected unless the
explicit local-test setting described above is enabled. Credentials are supplied
through a temporary Git askpass helper and are never embedded in clone URLs,
written to runner state, or returned from MCP tools.

Finalization retrieves fresh repository access, validates the effective Git
repository and workspace paths, disables repository-controlled credential
helpers and Git hooks, and pushes to the validated repository URL rather than a
mutable remote.

### Tools

#### `omniboard_runner_list_agentic_runs`

Lists every active agentic run available to the MCP key. Use it when an external
scheduler has not already selected a run.

#### `omniboard_runner_list_agentic_run_projects`

Lists Omniboard projects matching an agentic check or run. Pass `runKey` to
target one run, or `checkName` to discover matching projects and active runs
for a check. This operation does not resolve the MCP process working directory
or report progress.

#### `omniboard_runner_prepare_agentic_run_workspace`

Resolves one matching project and run, verifies repository access, clones the
project into the runner-owned workspace, resolves the branch name and commit
message, creates the branch, reports `in_progress`, and returns the prompt,
result context, workspace path, and agent instructions.

The branch name uses an explicit tool input first, then the agentic run
definition, a labeled value in the prompt, and finally a generated agentic
branch name. The commit message uses the run definition, a labeled prompt
value, and then a run-key-based default. Both resolved values are stored in the
signed workspace state.

An optional repository URL is accepted only when it identifies a registered
repository URL for the matched Omniboard project.

#### `omniboard_runner_finalize_agentic_run_workspace`

Finalizes a prepared workspace after the connected coding agent has applied and
verified the change. It creates or resumes the runner commit, retrieves fresh
repository access, pushes the prepared branch, creates or reuses the GitLab
merge request, and reports `committed`, `pushed`, and `mr_created`
milestones.

The prepared commit message is used by default. The caller may override it and
may also supply the merge request title, description, and Git author identity.

#### `omniboard_runner_report_agentic_run_progress`

Reports a dedicated-runner milestone for an explicit `runKey` and
`projectName` without resolving the MCP process working directory as an
Omniboard project. It supports the same repository, commit, merge request,
pipeline, verification, error, note, and metadata details as developer-local
progress reporting.
