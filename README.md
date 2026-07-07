# Omniboard.dev MCP

MCP server that exposes Omniboard agentic check runs to agents.

The server is organized around two execution modes:

- Developer-local mode runs inside the current project workspace. It resolves
  the local project using the same project-resolution approach as
  `@omniboard/analyzer`, exposes matching agentic runs, validates changes in
  that workspace, and reports progress for the local work.
- Dedicated runner mode is for a long-lived or scheduled Omniboard-managed
  process. Its runner-prefixed tools discover matching projects by check or run.
  Follow-up runner tools can own workspace preparation, execution, and progress
  reporting for scheduled work. The scheduling mechanism is intentionally
  external to the MCP protocol and can be a loop, cron, queue worker, CI job, or
  another runner.

One agentic run is one prompt plus tracked progress. Progress reports use
`runKey`.

## Environment

`OMNIBOARD_API_KEY_MCP` is required and should be passed through the MCP client
configuration, not assumed from the shell that starts the agent. The key is
used to read agentic check runs and to write agentic run progress.

### Optional

`OMNIBOARD_API_URL` is optional and defaults to `https://api.omniboard.dev`

`OMNIBOARD_API_KEY` is optional. Provide it only when agents should be allowed
to run `@omniboard/analyzer` during the validation prompt.

## API Contract

The MCP client reads project-scoped runs from `mcp/checks` and `mcp/run`, then
reads dedicated-runner discovery lists from `mcp/matched-projects`, and
reports progress to `agentic-check-run-progress`.

## Registering The MCP Server

The server uses the standard MCP stdio transport. Configure your agent to run
the package with `npx` and pass `OMNIBOARD_API_KEY_MCP` in the MCP server env.

### Claude Desktop, Cursor, and other JSONC clients

Use this shape for clients that accept MCP server JSONC configuration, including
Claude Desktop and Cursor:

```jsonc
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key",
        "OMNIBOARD_API_KEY": "your-api-key", // optional, enables analyzer validation
      },
    },
  },
}
```

### Codex `config.toml`

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.omniboard]
command = "npx"
args = ["-y", "@omniboard/mcp"]
startup_timeout_sec = 30

[mcp_servers.omniboard.env]
OMNIBOARD_API_KEY_MCP = "your-api-key"
OMNIBOARD_API_KEY = "your-api-key" # optional, enables analyzer validation
```

## Tools

### Developer-local Mode

### `omniboard_local_list_agentic_runs`

Lists agentic runs for the resolved current project. Pass `checkName` to scope
the list to one agentic check.

### `omniboard_local_get_agentic_run`

Returns one agentic run by `runKey`, including prompt, progress, and agent
instructions. This also reports the run as `in_progress` idempotently.

### `omniboard_local_report_agentic_run_progress`

Reports progress for one agentic run using `runKey`. Use it when a run reaches
a workflow milestone such as `implemented`, `needs_input`, `verified`,
`committed`, `pushed`, `mr_created`, `merged`, `blocked`, or `failed`.
The tool can also send MR URLs, commit SHAs, pipeline status, concise errors,
notes, verification metadata, and extra metadata.

### `omniboard_local_validate_agentic_run`

Validates one agentic run by `runKey`. The tool resolves the check name from the
run, reports validation progress to that run, and returns the analyzer result.
When `OMNIBOARD_API_KEY` is not available, the tool returns a skipped result and
reports `implemented`. When the key is available, the tool runs:

```sh
npx @omniboard/analyzer --ak <OMNIBOARD_API_KEY> --cp <check-name> --json
```

It then inspects `./dist/omniboard.json`, reports `verified` when the
check is resolved or `needs_input` when it still matches, and removes the
generated JSON file before completing.

### Dedicated Runner Mode

### `omniboard_runner_list_agentic_run_projects`

Lists Omniboard projects that currently match an agentic check or run. Pass
`runKey` to target one run, or `checkName` to discover matching projects and all
active runs for that check. This tool is read-only and does not resolve the
current workspace or report progress.
