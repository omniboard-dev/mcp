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

Projects explicitly returned by a user for another attempt use
`pending_retry`. The latest immutable retry instruction is included in the
prepared workspace instructions, and MCP reports `in_progress` only after the
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

Each checkout is created under `workspaces/` at a deterministic path derived
from the DB execution key and generation.

Execution state is handled as follows:

- The Omniboard API stores prepared and committed SHAs, branch and repository
  identity, recovery metadata, lifecycle phase, and optimistic state version.
- MCP CLI does not write accompanying JSON state.
- Repository credentials and local filesystem paths are never stored in
  execution state.
- The execution has a short renewable lease. Its token exists only in MCP CLI
  process memory; the API stores only its hash.
- DB execution state is authoritative, and runner checkouts are disposable
  local working copies.
- If a checkout disappears or no longer matches its DB checkpoint, the next
  preparation increments the generation and creates a fresh checkout.
- Uncheckpointed local state is never used as recovery state.

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
- `fulfillment`: selects `"fulfilled"` (the default) or `"unfulfilled"`
  projects. Unchecked projects are not part of this query.
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
Unfulfilled selection is currently for discovery; workspace preparation and
batch execution continue to select fulfilled projects.

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
is reached.

Batch controls are:

- `statuses`: defaults to `pending_retry`, `blocked`, and `failed`, and accepts any supported
  canonical progress statuses.
- `limit`: defaults to one and is bounded at ten.
- `relevantSourceExtensions`: lets the coding agent identify likely edited
  source types after interpreting the run prompt, for example `["json"]` for a
  registry migration.

Candidates are ordered smallest-first:

1. MCP CLI uses explicitly supplied relevant source extensions when available.
2. Otherwise, it derives extensions from prompt/check text and matched paths.
3. It prefers the Analyzer-reported line count for the selected extensions.
4. Relevant file count, total lines, total files, and project name provide
   deterministic tie-breakers.
5. If no relevant extension can be inferred, MCP CLI ranks by total project size.
6. Projects without `projectSize` metadata remain eligible but follow measured
   projects.

Each candidate is refreshed through the normal preparation path and classified:

- Actionable candidates acquire the atomic per-project DB execution lease and
  return a prepared workspace.
- Candidates already being prepared or holding an active lease in the same MCP CLI
  process are reported as waiting.
- Other waiting, stopped, and failed candidates remain in the response while
  scanning continues for actionable work.

The response includes aggregate counts, source selection, and per-project
results with selected extensions, size ranking, prompts, and workspace paths.

The operation does not dispatch coding agents or finalize work. Every returned
workspace must be edited, verified, and finalized individually, or explicitly
released when the caller will not finish it.

#### `omniboard_runner_prepare_agentic_run_workspace`

Preparation follows this sequence:

1. Resolve the matching project and run.
2. Refresh merge request and pipeline state.
3. Apply the shared continuation logic to canonical progress.
4. When work can continue, verify repository access and acquire the DB execution
   lease.
5. Reuse a validated checkout or recreate a missing or inconsistent checkout at
   a new generation.
6. Report `in_progress`, or `blocked` when recovery has unresolved conflicts.
7. Return the prompt, result context, provider diagnostics, workspace path, and
   agent instructions.

Continuation outcomes include:

- Actionable work returns a prepared workspace.
- Merged or otherwise non-actionable work returns without a workspace.
- Failed application pipelines remain actionable.
- Infrastructure-only pipeline failures remain non-actionable for code changes.
- When provider metadata and credentials permit a retry, MCP CLI requests one and
  returns `wait` until refreshed provider status becomes actionable.

Branch-name precedence is:

1. Explicit tool input.
2. Agentic run definition.
3. Labeled value in the prompt.
4. Generated agentic branch name.

Commit-message precedence is:

1. Agentic run definition.
2. Labeled value in the prompt.
3. Run-key-based default.

Both resolved values are stored in the DB execution checkpoint.

An optional repository URL is accepted only when it identifies a registered
repository URL for the matched Omniboard project.

When a previously green change request becomes stale, recovery proceeds as
follows:

1. Preparation uses the provider-refreshed detailed merge status as the recovery
   trigger.
2. For `need_rebase`, MCP CLI requests a provider-native rebase and returns `wait`.
   The coordinator prepares the project again after the provider finishes.
3. If native rebase is unavailable or conflicts exist, MCP CLI fetches the
   authoritative source and target branches and starts a local rebase.
4. MCP CLI reports `blocked` and returns the exact conflict files and resolution
   instructions.
5. The coding agent resolves and stages only those files, then calls
   finalization. It must not commit, rebase, or push manually.
6. If another conflict set appears, finalization returns `completed: false` and
   the caller repeats the resolution and finalization steps.
7. Once clean, MCP CLI refetches both branches and retries against a newly advanced
   target up to a bounded limit.
8. MCP CLI pushes the rebased source with `force-with-lease` bound to the source SHA
   where recovery started.

Recovery safeguards are:

- If the source branch advances concurrently, MCP CLI does not push. It resets the
  retained workspace to that remote source and requires another preparation.
- Recovery phase, attempt, source and target SHAs, and conflict files are
  checkpointed after every recoverable transition.
- Another MCP CLI process can continue from the checkpoint after the previous lease
  expires.

#### `omniboard_runner_release_agentic_run_workspace`

Use this tool for every prepared workspace that will not be finalized.

Release behavior is:

- A lease owned by the current MCP CLI process is released.
- The renewal timer stops immediately.
- The execution record and local workspace remain available for a later runner.
- Repeated calls, or calls from a process that does not own the lease, return
  `released: false` without changing another process's lease.
- Agentic-run progress is unchanged.
- The execution is not marked completed or abandoned.

#### `omniboard_runner_finalize_agentic_run_workspace`

Before normal finalization or recovery, MCP CLI:

1. Refreshes provider state and applies the same continuation decision used by
   preparation and local execution.
2. Stops before changing Git or provider state when the decision is `wait` or
   `stop`.
3. Verifies that the refreshed branch and repository still match the leased DB
   execution and deterministic checkout generation.

After the coding agent applies and verifies a normal change, MCP CLI:

1. Creates or resumes the runner commit.
2. Retrieves fresh repository access and pushes the prepared branch.
3. Creates or reuses the GitLab merge request.
4. Reports `committed`, `pushed`, and `mr_created` milestones.

Callers must inspect `completed`:

- `completed: true`: normal finalization or recovery finished successfully.
- `completed: false`: recovery requires another action or remains blocked. The
  response provides applicable errors, instructions, and conflict files. MCP CLI
  does not push when its recovery safety checks fail.

A successful recovery also:

- Reports `pushed`.
- Clears the DB recovery checkpoint.
- Releases the execution lease.
- Requests an immediate Omniboard provider-state refresh.

The prepared commit message is used by default. The caller may override it and
may also supply the merge request title and description. Commit identity comes
from the checkout-local or global Git configuration described above.

A successful push is not terminal because review, pipeline, or rebase recovery
may still continue. Execution lifecycle outcomes are:

- `completed`: refreshed continuation state says the change is finished.
- `abandoned`: the change was dismissed.
- The API cleanup cron removes completed rows after 30 days and abandoned rows
  after 7 days in bounded batches.
- Foreign-key cascades remove rows when their owning run, project, group, or
  organization is removed.

#### `omniboard_runner_report_agentic_run_progress`

Reports a dedicated-runner milestone for an explicit `runKey` and
`projectName` without resolving the MCP CLI process working directory as an
Omniboard project. It supports the same repository, commit, merge request,
pipeline, verification, error, note, and metadata details as developer-local
progress reporting, including Markdown in the optional `notes` field.
