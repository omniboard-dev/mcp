# Omniboard.dev MCP

MCP server that exposes Omniboard agentic check runs to coding agents.

One agentic run consists of one prompt and its tracked progress. Tools identify a
run with its `runKey`.

## Repository layout

- `lib/` contains the MCP runtime implementation in TypeScript.
- `test/` contains TypeScript integration tests.
- `tooling/` contains repository and release chores only.
- `dist/` contains generated runtime output.

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
milestones. Local and dedicated modes use the same provider-refreshed
continuation decision and agent instructions; they differ only in how the
working checkout is obtained. Analyzer validation is available only when
`OMNIBOARD_API_KEY` is configured and the continuation decision permits work.

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

Reports a workflow milestone for one run. Supported milestones include
`implemented`, `needs_input`, `verified`, `committed`, `pushed`,
`mr_created`, `done`, `blocked`, and `failed`. A `done` progress report
includes the resolution `merged` or `dismissed`; dismissed findings can include
a `resolutionReason` such as `false_positive`. The legacy `merged` status
remains accepted for backward compatibility.

The tool can also report repository, commit, merge request, pipeline,
verification, error, note, and metadata details. The optional `notes` field accepts
Markdown; plain text remains valid Markdown.

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

The MCP server prepares and finalizes runner-owned checkouts. Before preparation,
it refreshes the selected run and project against its Git provider and decides
whether to continue from the canonical Omniboard progress status and provider
metadata. The connected coding agent performs the requested code change inside
the returned workspace and runs the relevant project verification before
finalization.

### Workspace layout

The MCP process working directory is the root of the consumer's automation
project. On first preparation, the server creates:

```text
.omniboard/
  mcp/
    .gitignore
    workspaces/
```

The generated `.gitignore` excludes `workspaces/`. If the file already
exists, its content is preserved and only the missing runtime entry is added.

Each checkout is created under `workspaces/` at a deterministic path derived
from the DB execution key and generation. MCP does not write accompanying JSON
state. Prepared and committed SHAs, branch and repository identity, recovery
metadata, lifecycle phase, and optimistic state version are stored by the
Omniboard API. Repository credentials and local filesystem paths are never
stored in execution state.

An execution has a short renewable lease. The lease token exists only in MCP
process memory; the API stores only its hash. DB execution state is
authoritative; runner checkouts are disposable local working copies. If a
checkout disappears or no longer matches its DB checkpoint, the next
preparation increments the DB generation and recreates a fresh checkout at a
new path from the authoritative repository and execution state. Uncheckpointed
local state is never used as recovery state.

### Workflow

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
   prepares leased workspaces until its requested limit is reached.
4. Give the returned prompt, result context, and workspace path to the connected
   coding agent.
5. Run the relevant tests, lint, or build commands inside that workspace.
6. Call `omniboard_runner_finalize_agentic_run_workspace` separately for each
   prepared workspace, with the commit and merge request wording.
7. Retain the checkout for inspection, or remove it after downstream
   processing completes. A later preparation recreates a missing checkout from
   DB execution state at a new generation.

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
written to DB execution state, or returned from MCP tools.

Finalization retrieves fresh repository access, validates the effective Git
repository and workspace paths, disables repository-controlled credential
helpers and Git hooks, and pushes to the validated repository URL rather than a
mutable remote.

### Tools

Every tool declares an output schema and returns the same JSON object in both
MCP `structuredContent` and a JSON text content block. New clients can consume
and validate `structuredContent` directly. Existing clients that parse the text
block remain compatible.

#### `omniboard_runner_list_agentic_runs`

Lists every active agentic run available to the MCP key. Use it when an external
scheduler has not already selected a run.

#### `omniboard_runner_list_agentic_run_projects`

Lists Omniboard projects matching an agentic check or run. Pass `runKey` to
target one run, or `checkName` to discover matching projects and active runs
for a check. This operation does not resolve the MCP process working directory
or report progress.

Pass `statuses` to filter by canonical stored progress status. Pass `offset`
and `limit` to page the filtered result. `view: "summary"` omits project result
payloads and expanded run metadata while retaining repository, progress, merge
request, pipeline, and error details. The response distinguishes filtered
`total`, API `unfilteredTotal`, page `returned`, and `hasMore`.

Listing is side-effect free with respect to agentic-run and project state: it
reads stored progress and does not refresh providers, record snapshots, prepare
workspaces, or report progress. Stored provider details can therefore be stale.

Use the tools in this order:

1. List runs and projects for read-only discovery and candidate selection.
2. Prepare one selected project, or call the batch preparation tool when ready
   to acquire work. Preparation refreshes only the selected candidates before
   deciding whether work can continue.
3. List again only when an updated stored overview is needed after preparation.

Do not prepare every project merely to refresh discovery data; preparation can
acquire a lease and create or resume an actionable workspace.

#### `omniboard_runner_prepare_next_agentic_run_projects`

Scans projects for one run and prepares workspaces until the requested `limit`
is reached. `statuses` defaults to `blocked` and `failed`; callers can provide
any supported canonical progress statuses. The limit defaults to one and is
bounded at ten.

Each candidate is refreshed and classified through the normal preparation
path. Actionable candidates acquire the existing atomic per-project DB
execution lease. Candidates already being prepared or holding an active
execution lease in the same MCP process are reported as waiting, and scanning
continues so concurrent or stale overlapping batch calls do not return the same
workspace. Other waiting, stopped, and failed candidates are also included while
scanning continues for an actionable workspace. The response contains counts and
per-project preparation results, including the prompts and
workspace paths needed by coding agents.

The operation does not dispatch coding agents or finalize work. Every returned
workspace must be edited, verified, and finalized individually.

#### `omniboard_runner_prepare_agentic_run_workspace`

Resolves one matching project and run, refreshes its merge request and pipeline
state, and applies the shared continuation logic to canonical progress. If
work should continue, it verifies repository access, acquires the DB execution
lease, safely reuses its validated checkout or recreates a missing or
inconsistent checkout at a new generation, reports `in_progress`,
and returns the prompt, result context, provider diagnostics, workspace path,
and agent instructions. Merged or otherwise non-actionable state returns without
a workspace. Failed application pipelines remain actionable; infrastructure-only
pipeline failures remain non-actionable for code changes. When provider metadata and
credentials permit it, MCP requests a pipeline retry and returns `wait` until
the refreshed provider status becomes actionable.

The branch name uses an explicit tool input first, then the agentic run
definition, a labeled value in the prompt, and finally a generated agentic
branch name. The commit message uses the run definition, a labeled prompt
value, and then a run-key-based default. Both resolved values are stored in the
DB execution checkpoint.

An optional repository URL is accepted only when it identifies a registered
repository URL for the matched Omniboard project.

When a previously green change request becomes stale, preparation uses the
provider-refreshed detailed merge status as the recovery trigger. A provider
`need_rebase` state first requests the provider-native rebase and returns
`wait`; the external coordinator should prepare the project again after the
provider finishes. If native rebase is unavailable or the change request has
actual conflicts, MCP fetches the authoritative source and target branches,
starts a local rebase in the leased runner workspace, reports the project as
`blocked`, and returns the exact conflict files and resolution instructions.

The coding agent resolves only those files, stages them, and calls finalization;
it must not commit, rebase, or push manually. A multi-commit rebase can expose
another conflict set, in which case finalization returns `completed: false` and
the caller repeats the resolution/finalization step. Once clean, MCP refetches
both branches, retries against a newly advanced target up to a bounded limit,
and pushes the rebased source with `force-with-lease` bound to the source SHA
that recovery started from. If the source branch advanced concurrently, no push
is attempted; the retained workspace is reset to that remote source and must be
prepared again. Recovery phase, attempt, source and target SHAs, and conflict
files are checkpointed in DB execution state after every recoverable transition. Another
MCP process can continue after the previous lease expires by recreating or
validating the checkout from that checkpoint.

#### `omniboard_runner_finalize_agentic_run_workspace`

Finalizes a prepared workspace after the connected coding agent has applied and
verified the change. It creates or resumes the runner commit, retrieves fresh
repository access, pushes the prepared branch, creates or reuses the GitLab
merge request, and reports `committed`, `pushed`, and `mr_created`
milestones.

Before touching the checkout, finalization refreshes provider state and applies
the same continuation decision used by preparation and local execution. It also
verifies that the refreshed branch and repository still match the leased DB
execution and its deterministic checkout generation. A `wait` or `stop`
decision aborts finalization before Git or provider state is changed.

Callers must inspect the returned `completed` field. Normal finalization and a
finished recovery return `completed: true`. Unresolved or newly surfaced rebase
conflicts return `completed: false`, `conflictFiles`, and updated instructions
without pushing. A successful recovery reports `pushed`, clears its DB recovery
checkpoint, releases the execution lease, and asks Omniboard to refresh provider state
immediately.

The prepared commit message is used by default. The caller may override it and
may also supply the merge request title, description, and Git author identity.

A successful push is not terminal because review, pipeline, or rebase recovery
may still continue. When refreshed continuation state later says the change is
finished, MCP marks the execution `completed`; a dismissed change is marked
`abandoned`. The API cleanup cron removes completed rows after 30 days and
abandoned rows after 7 days in bounded batches. Foreign-key cascades also remove
execution rows when their owning run, project, group, or organization is removed.

#### `omniboard_runner_report_agentic_run_progress`

Reports a dedicated-runner milestone for an explicit `runKey` and
`projectName` without resolving the MCP process working directory as an
Omniboard project. It supports the same repository, commit, merge request,
pipeline, verification, error, note, and metadata details as developer-local
progress reporting, including Markdown in the optional `notes` field.
