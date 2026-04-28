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

## Registering The MCP Server

The server uses the standard MCP stdio transport. Configure your agent to run
the package with `npx` and pass `OMNIBOARD_API_KEY_MCP` in the MCP server env.

### Generic stdio config

Use this shape for clients that accept MCP server JSON configuration:

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key"
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
```

### Claude Desktop

Add this to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add this to your Cursor MCP config:

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["-y", "@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key"
      }
    }
  }
}
```

## Tools

### `omniboard_list_actionable_checks`

Returns the actionable checks that currently have results for the resolved
project.


### `omniboard_get_actionable_check_results`

Returns the result context for the check. The API owns the result DTO, so the
MCP passes it through as `result`.
