# Omniboard MCP CLI

Omniboard MCP CLI is a local stdio MCP server that exposes agentic check runs
to coding agents. It calls the independently reusable
Agentic Runner workflow through the Omniboard API's `/mcp-cli` endpoints.

This package is separate from the MCP Hosted server exposed directly by the
Omniboard API at `/mcp-hosted`. MCP Hosted uses bearer authentication and scoped
`mcp-hosted` API keys; this package uses a full-access `mcp-cli` API key.

In this document, **MCP Hosted** and **MCP CLI** name the two Omniboard
integrations. A **coding client** is the external MCP host, such as Codex, Claude
Code, or Cursor; protocol terms such as stdio and `structuredContent` describe
the transport and wire format rather than another Omniboard component.

One agentic run consists of one prompt and its tracked progress. Tools identify a
run with its `runKey`.

## Delivery goal

The MCP server sends its prime directive to the coding client during initialization:
deliver the requested migration until an open, green, mergeable MR exists. Use that goal
to resolve ambiguous next steps within the user's scope and constraints.
After publication, wait for running CI and repair failed CI or conflicts. Once
the MR is green and mergeable, no further agent work remains. Merging belongs to
the user or consuming team. Recover disposable runner state and closed MRs as needed. Duplicate effort
is an accepted efficiency tradeoff. When external requirements prevent progress,
report the concrete blocker and continue other actionable projects.

## Environment

`OMNIBOARD_API_KEY_MCP_CLI` is required and should be passed through the coding
client's MCP server configuration. MCP CLI uses it to read agentic runs,
retrieve repository access when required, and report run progress.

### Optional

- `OMNIBOARD_API_URL`: overrides the Omniboard API URL. It defaults to
  `https://api.omniboard.dev`.
- `OMNIBOARD_API_KEY`: enables analyzer validation in developer-local mode.
  Omit it when connected agents should not run `@omniboard/analyzer`.
- `OMNIBOARD_MCP_CLI_ALLOW_LOCAL_TRANSPORTS=true`: permits local `file:`
  repositories and loopback HTTP Git/GitLab endpoints for isolated local tests.
  Leave it unset in normal runner deployments.

## Registering the MCP CLI server

The server uses the stdio transport defined by MCP. Instantiate it only in
projects that use Omniboard MCP CLI. Do not add it to a user-level or global
configuration: coding harnesses may start the server for every project, wasting
resources and exposing irrelevant tools. Keep the API key in the
harness-specific project or local configuration and do not commit it.

### Claude Code

From the relevant project root, add a local-scoped server. See the [Claude Code
MCP configuration](https://code.claude.com/docs/en/mcp) for scope and management
options.

```sh
claude mcp add --env OMNIBOARD_API_KEY_MCP_CLI=your-api-key --scope local omniboard -- npx -y @omniboard/mcp
```

### Cursor

Create `.cursor/mcp.json` in the relevant project. See the [Cursor MCP
configuration](https://docs.cursor.com/context/model-context-protocol) for
project and global configuration locations.

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": { "OMNIBOARD_API_KEY_MCP_CLI": "your-api-key" }
    }
  }
}
```

### Codex

Create `.codex/config.toml` in the relevant project, not `~/.codex/config.toml`.
See the [Codex project configuration](https://developers.openai.com/codex/config-basic/)
and [MCP configuration](https://developers.openai.com/codex/mcp/) documentation.

```toml
[mcp_servers.omniboard]
command = "npx"
args = ["-y", "@omniboard/mcp"]

[mcp_servers.omniboard.env]
OMNIBOARD_API_KEY_MCP_CLI = "your-api-key"
```

## Developer-local mode

Developer-local mode is for an agent already working inside the repository that
should be changed. The server resolves the current directory as an Omniboard
project, exposes agentic runs for that project, and reports progress against the
local workspace.

This mode does not create or manage another checkout. The connected agent owns
the normal development workflow:

1. Inspect the project.
2. Edit the current workspace.
3. Run the relevant verification.
4. Use the local progress tools to report milestones.

Local and dedicated modes use the same provider-refreshed continuation decision
and agent instructions. They differ only in how the working checkout is
obtained. Analyzer validation is available only when `OMNIBOARD_API_KEY` is
configured and the continuation decision permits work.

### Tools

#### `omniboard_local_list_agentic_runs`

Lists agentic runs for the resolved current project. Pass `checkName` to scope
the list to one agentic check.

#### `omniboard_local_get_agentic_run`

Returns one agentic run by `runKey`, including its prompt, progress, and agent
instructions. It refreshes provider state, returns the shared continuation
decision, and reports the run as `in_progress` idempotently only when that
decision permits work.

#### `omniboard_local_report_agentic_run_progress`

Reports a workflow milestone for one run. Supported milestones are:

- `implemented`
- `needs_input`
- `verified`
- `committed`
- `pushed`
- `mr_created`
- `done`
- `blocked`
- `failed`

A `done` progress report includes one of these resolutions:

- `merged`
- `dismissed`, optionally with a `resolutionReason` such as
  `false_positive`

The legacy `merged` status remains accepted for backward compatibility.

The tool can also report repository, commit, merge request, pipeline,
verification, error, note, and metadata details. The optional `notes` field accepts
Markdown; plain text remains valid Markdown.

#### `omniboard_local_validate_agentic_run`

Validates one run by `runKey`. The server resolves the check name, runs the
analyzer when `OMNIBOARD_API_KEY` is available, and evaluates whether the check
still matches.

Reported progress statuses are:

- `implemented`: validation started, or it was skipped because
  `OMNIBOARD_API_KEY` is not configured.
- `verified`: the check no longer matches.
- `needs_input`: the check still matches.
- `failed`: analyzer validation failed.

Explicit retries create an instruction with a separate disposition. The API
reassesses current applicability and provider facts; only accepted guidance is
included in prepared workspace instructions. MCP reports `in_progress` only after the
workspace is successfully acquired and prepared. Every matched-project response
includes fulfilled, unfulfilled, and unchecked projects. Each project carries
its current fulfillment group so the run prompt can add, remove, or otherwise
change code for the relevant result variant.

If the continuation decision does not permit validation, the tool returns
`skipped: true` without reporting another progress status.

## Dedicated runner mode

Dedicated runner mode is for a consumer-operated automation process that handles
agentic work across projects. A scheduler, queue worker, CI job, cron process, or
similar coordinator selects runs and projects. Scheduling and concurrency stay
outside the MCP CLI server.

The MCP CLI server prepares and finalizes runner-owned checkouts. Before preparation,
it refreshes the selected run and project against its Git provider and decides
whether to continue from the canonical Omniboard progress status and provider
metadata. The connected coding agent performs the requested code change inside
the returned workspace and runs the relevant project verification before
finalization.

### Workspace layout

The MCP CLI process working directory is the root of the consumer's automation
project. On first preparation, the server creates:

```text
.omniboard/
  mcp/
    .gitignore
    workspaces/
```

The generated `.gitignore` excludes `workspaces/`. If the file already
exists, its content is preserved and only the missing runtime entry is added.

Each migration uses a stable checkout under `workspaces/`. Compatible checkouts
retain local edits and dependencies across restart. Runner checkouts are disposable:
missing or incompatible metadata causes a fresh clone from the existing source
branch, or from the latest target when that branch no longer exists. Older
checkouts are not required for recovery.

Git and the provider supply current facts. Progress is reporting, not permission
to work. There are no execution API calls, renewable leases, heartbeat deadlines,
or work budgets. Small metadata under `.git/omniboard-runner.json` retains the
source SHA and any preserved stash so interrupted Git operations can resume.

### Git commit identity

Finalization resolves Git commit identity in this order:

1. The generated checkout's repository-local `user.name` and `user.email`.
2. The global Git configuration for the operating-system user that runs MCP CLI.

Generated checkouts do not inherit repository-local Git configuration from the
automation project that contains `.omniboard/`.

For local use, a global Git identity is normally sufficient:

```sh
git config --global user.name "Tomas Trajan"
git config --global user.email "tomas@example.com"
```

CI jobs commonly start with a clean home directory, so configure the identity
before starting MCP CLI. Run the configuration as the same user and with the same
`HOME` as the MCP CLI process:

```sh
git config --global user.name "Omniboard Automation"
git config --global user.email "automation@example.com"
git config --global --get user.name
git config --global --get user.email
```

If neither checkout-local nor global identity is available, Git rejects the
commit and workspace finalization fails. MCP CLI does not accept author-name or
author-email tool inputs and does not provide a hard-coded fallback identity.

#### GitLab CI

Configure a bot identity in `before_script` before the command that starts MCP CLI:

```yaml
variables:
  OMNIBOARD_GIT_USER_NAME: 'Omniboard Automation'
  OMNIBOARD_GIT_USER_EMAIL: 'automation@example.com'

default:
  before_script:
    - git config --global user.name "$OMNIBOARD_GIT_USER_NAME"
    - git config --global user.email "$OMNIBOARD_GIT_USER_EMAIL"
```

The values may instead come from protected GitLab CI/CD variables when the
identity should not be repeated in the pipeline file.

#### GitHub Actions

Add an identity configuration step before the step that starts MCP CLI:

```yaml
- name: Configure Git identity for Omniboard MCP CLI
  shell: bash
  run: |
    git config --global user.name "Omniboard Automation"
    git config --global user.email "automation@example.com"
```

Repository or organization variables can be substituted for the literal values
when the same automation identity is shared by multiple workflows.

### Workflow

See [the four-outcome workflow and flowcharts](docs/migration-workflow.md).
The API supplies the canonical decision; preparation adds local workspace facts.

1. Call `omniboard_runner_list_agentic_runs` to select an active run unless
   the scheduler already supplies a run key.
2. For manual selection, call `omniboard_runner_list_agentic_run_projects` for
   the selected run. Use status filters, pagination, and `view: "summary"` for
   compact discovery.
3. Select one project and call
   `omniboard_runner_prepare_agentic_run_workspace`. Preparation refreshes
   only that run and project against its Git provider before deciding whether
   work should continue. For batch selection, call
   `omniboard_runner_prepare_next_agentic_run_projects` instead; it scans and
   prepares migration workspaces until its requested limit is reached.
4. Give the returned prompt, result context, and workspace path to the connected
   coding agent.
5. Run the relevant tests, lint, or build commands inside that workspace.
6. Call `omniboard_runner_finalize_agentic_run_workspace` separately for each
   prepared workspace, with the commit and merge request wording.
7. MCP CLI retains the Git checkout for inspection and recovery but removes its
   root `node_modules` whenever work stops. A later preparation reinstalls
   dependencies as needed, or recreates a missing checkout from DB execution
   state at a new generation.

### Repository access and safety

MCP CLI applies repository safeguards in this order:

1. Preparation performs a read-only GitLab permission preflight before creating
   a workspace. It verifies project visibility, repository and merge request
   availability, archive state, and effective push and merge request
   permissions.
2. MCP CLI retrieves repository access only for credentialed Git operations.
   Repository and GitLab API URLs must use HTTPS by default. Local `file:`
   repositories and loopback HTTP endpoints require the explicit local-test
   setting described above.
3. MCP CLI supplies credentials through a temporary Git askpass helper. Credentials
   are never embedded in clone URLs, written to DB execution state, or returned
   from MCP CLI tools.
4. Finalization retrieves fresh repository access, validates the effective
   repository and workspace paths, disables repository-controlled credential
   helpers and Git hooks, and pushes to the validated repository URL rather than
   a mutable remote.

Project policy or branch protection can still change after the permission
preflight.

### Tools

Every MCP CLI tool declares an output schema and returns the same JSON object in
both the MCP protocol's `structuredContent` and a JSON text content block. New
clients can consume and validate `structuredContent` directly. Existing clients
that parse the text block remain compatible.

#### `omniboard_runner_list_agentic_runs`

Lists every active agentic run available to the MCP CLI key. Use it when an external
scheduler has not already selected a run.

#### `omniboard_runner_list_agentic_run_projects`

Lists checked Omniboard projects for an agentic check or run. Pass `runKey` to
target one run, or `checkName` to discover projects and active runs for a check.
Fulfilled projects are returned by default. This operation does not resolve the
MCP CLI process working directory or report progress.

Available query controls are:

- `statuses`: filters by canonical stored progress status.
- Fulfilled, unfulfilled, and unchecked projects are returned together. Each
  project carries its `fulfillment` value and `targetedByRun` flag so discovery
  and batch preparation apply the run definition to the correct result variant.
- `offset` and `limit`: page the filtered result.
- `view: "summary"`: omits project result payloads and expanded run metadata
  while retaining repository, progress, merge request, pipeline, and error
  details.

Pagination fields are:

- `total`: number of filtered projects.
- `unfilteredTotal`: total returned by the API before filtering.
- `returned`: number of projects on the current page.
- `hasMore`: whether another page is available.

Listing is side-effect free with respect to agentic-run and project state: it
reads stored progress and does not refresh providers, record snapshots, prepare
workspaces, or report progress. Stored provider details can therefore be stale.
Workspace preparation and batch execution select every project whose current
result variant is targeted by the run, including unfulfilled and unchecked
projects when the run definition targets those variants.

Use the tools in this order:

1. List runs and projects for read-only discovery and candidate selection.
2. Prepare one selected project, or call the batch preparation tool when ready
   to acquire work. The API handles pending retry assessments and dismissed-MR
   cleanup independently, then refreshes candidates before authorizing work.
3. List again only when an updated stored overview is needed after preparation.

#### Project state and retry tools

- `omniboard_runner_get_project_state`: read stored facts and the API decision.
- `omniboard_runner_refresh_project_state`: refresh provider facts and reconcile
  applicability, retries, and dismissal cleanup without preparing a checkout.
- `omniboard_runner_request_project_retry`: record explicit operator guidance for
  reassessment; it does not force work on a ready MR.

This release requires the matching API and manual database migration described in
[the workflow contract](docs/migration-workflow.md). Missing API workflow decisions
are contract errors; MCP does not derive a fallback decision.

#### `omniboard_runner_prepare_next_agentic_run_projects`

Prepare up to `limit` actionable migrations (default one, maximum ten). For
"continue" or "do the next 10", fill the batch in this order:

1. Pending projects, including those without stored progress.
2. Started or published work: in_progress, implemented, verified, committed,
   pushed, mr_created.
3. Recovery work: failed, blocked, needs_input.

Merged and dismissed migrations are excluded. Request an explicit retry to
reconsider dismissed work; progress reports cannot reopen terminal migrations.

Within each group, order by Analyzer source size. Failed preparations, merged
changes, green mergeable MRs, and work waiting for CI or approval do not consume the actionable
limit; keep scanning the remaining groups. Waiting returns before checkout operations and preserves retained local edits.
Failed CI or conflicts make published work actionable again.
Already-merged progress is excluded.

Explicit `statuses` replace the default groups and use source-size ordering:
`["pending"]` requests only new work; `["failed", "blocked"]` requests repairs.
Existing work remains selectable after its analyzer result changes. A prepared
batch is not a completed migration batch: continue each selected project until an open, green, mergeable MR exists, and report remaining waits or blockers.

#### `omniboard_runner_prepare_agentic_run_workspace`

1. Read the run, repository access, MR and CI diagnostics.
2. Reuse its checkout or clone the source branch if none exists.
3. Fetch the current source and target (normally main), preserve edits, and rebase.
4. Return the workspace, prompt and any conflicts for the agent to resolve.

Complete and dismissed decisions stop before checkout work. Waiting decisions
report their reason. Green mergeable MRs and CI/approval waits leave the checkout untouched. An unfinished closed/declined MR can be replaced;
dismissed work first requires an explicit retry. A conflicting rebase returns
the same workspace for repair.

An existing MR supplies the source branch; otherwise use retained progress,
explicit input, the run/prompt, or a stable run-key default. The commit message
comes from the run/prompt or run key. Continue using the repository already
recorded for the migration even when the project lists several repositories.
Only repositories registered for the selected project may be used.

#### `omniboard_runner_finalize_agentic_run_workspace`

After resolving conflicts and running relevant checks, finalize the checkout.
Finalization refreshes source and target, continues pending rebases, commits local
changes and pushes the same branch. Rewritten history uses Git's expected-source
SHA check to avoid overwriting a push that arrived while publication was running.
It reuses an open MR or creates a replacement when the previous MR is closed or
declined. A conflict returns `completed: false` with files to resolve. If the
checkout had to be recreated or synchronization changed HEAD, finalization returns `completed: false` so the agent
can reapply the prompt and run checks before publishing. Successful publication
returns `completed: true, published: true`.

After publication, wait while CI runs. Repair failed CI and rebase conflicts on the
existing MR until it is green and mergeable, then no further agent work remains.
Keep the mr_created milestone and derive waiting from provider facts. The MCP does
not expose a merge tool; merging belongs to the user or consuming team. A later
human merge is recorded only after provider confirmation.

#### Compatibility heartbeat and release tools

Heartbeat is a no-op. Release only forgets in-process context. Neither is required;
neither deletes the checkout or dependencies. Restarting preparation resumes the
same checkout using Git and the retained stash/source references.

#### `omniboard_runner_report_agentic_run_progress`

Reports a dedicated-runner milestone for an explicit `runKey` and
`projectName` without resolving the MCP CLI process working directory as an
Omniboard project. It supports the same repository, commit, merge request,
pipeline, verification, error, note, and metadata details as developer-local
progress reporting, including Markdown in the optional `notes` field.
