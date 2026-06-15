# Omniboard.dev MCP

MCP server that exposes Omniboard agentic check runs for the current project to
a local agent.

The server resolves the current project name using the same project-resolution
approach as `@omniboard/analyzer`, retrieves Omniboard settings, then asks the
API for agentic runs. One agentic run is one prompt plus tracked progress.
Progress reports use `runKey`.

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
        "OMNIBOARD_API_KEY": "your-api-key" // optional, enables analyzer validation
      }
    }
  }
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

### `omniboard_list_agentic_runs`

Lists agentic runs for the resolved project. Pass `checkName` to scope the list
to one agentic check.

### `omniboard_get_agentic_run`

Returns one agentic run by `runKey`, including prompt, progress, and agent
instructions. This also reports the run as `in_progress` idempotently.

### `omniboard_report_agentic_run_progress`

Reports progress for one agentic run using `runKey`. Use it when a run reaches
a workflow milestone such as `blocked`, `skipped`, `ready_to_commit`,
`ready_to_mr`, or `done`. The tool can also send MR URLs, commit SHAs, pipeline
status, concise errors, notes, verification metadata, and extra metadata.

### `omniboard_validate_agentic_run`

Validates one agentic run by `runKey`. The tool resolves the check name from the
run, reports validation progress to that run, and returns the analyzer result.
When `OMNIBOARD_API_KEY` is not available, the tool returns a skipped result and
reports `ready_to_verify`. When the key is available, the tool runs:

```sh
npx @omniboard/analyzer --ak <OMNIBOARD_API_KEY> --cp <check-name> --json
```

It then inspects `./dist/omniboard.json`, reports `ready_to_commit` when the
check is resolved or `needs_model_work` when it still matches, and removes the
generated JSON file before completing.
