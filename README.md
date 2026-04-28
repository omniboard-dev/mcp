# Omniboard.dev MCP

MCP server that exposes actionable Omniboard checks for the current project to a
local agent.

The server resolves the current project name using the same project-resolution
approach as `@omniboard/analyzer`, retrieves Omniboard settings, then asks the
API for actionable check results for that project.

## Environment

`OMNIBOARD_API_KEY_MCP` is required and should be passed through the MCP client
configuration, not assumed from the shell that starts the agent.

### Optional

`OMNIBOARD_API_URL` is optional and defaults to `https://api.omniboard.dev`

`OMNIBOARD_API_KEY` is optional. Provide it only when agents should be allowed
to run `@omniboard/analyzer` during the actionable-check validation prompt.

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

### `omniboard_list_actionable_checks`

Returns the actionable checks that currently have results for the resolved
project.

### `omniboard_get_actionable_check_results`

Returns the result context for the check. The API owns the result DTO, so the
MCP passes it through as `result`. The response also includes `agentContext`,
which tells the agent to use all returned context to resolve the actionable
check, run relevant local verification, and optionally validate with the
`omniboard_validate_actionable_check_fix` tool when `OMNIBOARD_API_KEY` is
available.

### `omniboard_validate_actionable_check_fix`

Optionally validates whether an attempted fix resolved an actionable check. When
`OMNIBOARD_API_KEY` is not available, the tool returns a skipped result and does
not run validation.

When the key is available, the tool runs:

```sh
npx @omniboard/analyzer --ak <OMNIBOARD_API_KEY> --cp <check-name> --json
```

It then inspects the generated JSON at `./dist/omniboard.json`, returns whether
the check is resolved or still matches, and removes the generated JSON file
before completing.
