# Omniboard.dev MCP

MCP server that exposes actionable Omniboard checks for the current project to a
local agent.

The server resolves the current project name using the same project-resolution
approach as `@omniboard/analyzer`, retrieves Omniboard settings, then asks the
API for actionable check results for that project.

## Environment

Required:

```sh
OMNIBOARD_API_KEY_MCP=...
```

The MCP server expects this environment variable to be set before the agent is
started. The API key must be an Omniboard API key that is allowed to access the
MCP endpoints.

Optional:

```sh
OMNIBOARD_API_URL=https://api.omniboard.dev
```

## Registering The MCP Server

The server uses the standard MCP stdio transport. Build the package first:

```sh
npm install
npm run build
```

Then register the built executable with your MCP client.

### Generic stdio config

Use this shape for clients that accept MCP server JSON configuration:

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "npx",
      "args": ["@omniboard/mcp"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key"
      }
    }
  }
}
```

For local development from a checkout:

```json
{
  "mcpServers": {
    "omniboard": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "OMNIBOARD_API_KEY_MCP": "your-api-key",
        "OMNIBOARD_API_URL": "https://api.omniboard.dev"
      }
    }
  }
}
```

### Codex `config.toml`

Add an MCP server entry to your Codex config:

```toml
[mcp_servers.omniboard]
command = "npx"
args = ["@omniboard/mcp"]

[mcp_servers.omniboard.env]
OMNIBOARD_API_KEY_MCP = "your-api-key"
```

For local development from a checkout:

```toml
[mcp_servers.omniboard]
command = "node"
args = ["/absolute/path/to/mcp/dist/index.js"]

[mcp_servers.omniboard.env]
OMNIBOARD_API_KEY_MCP = "your-api-key"
OMNIBOARD_API_URL = "https://api.omniboard.dev"
```

Alternatively, set `OMNIBOARD_API_KEY_MCP` in the shell environment before
starting the agent and omit the `env` block from the client config.

Bash:

```sh
export OMNIBOARD_API_KEY_MCP="your-api-key"
codex
```

Fish:

```fish
set -x OMNIBOARD_API_KEY_MCP "your-api-key"
codex
```

PowerShell:

```powershell
$env:OMNIBOARD_API_KEY_MCP = "your-api-key"
codex
```

## Tools

### `omniboard_list_actionable_checks`

Returns the actionable checks that currently have results for the resolved
project.

Response:

```json
{
  "project": {
    "id": 1,
    "name": "example-project",
    "lastAnalysisDate": "2026-04-27T12:00:00.000Z"
  },
  "checks": [
    {
      "name": "UXF",
      "type": "content",
      "description": "UXF usage detected",
      "prompt": "Update the matched usages...",
      "value": true
    }
  ]
}
```

### `omniboard_get_actionable_check_results`

Input:

```json
{
  "name": "UXF"
}
```

Returns the result context for the check. The API owns the result DTO, so the
MCP passes it through as `result`.

Response:

```json
{
  "project": {
    "id": 1,
    "name": "example-project"
  },
  "check": {
    "name": "UXF",
    "type": "content",
    "description": "UXF usage detected",
    "actionable": true,
    "prompt": "Update the matched usages..."
  },
  "result": {}
}
```

## Backend Endpoints

### Checks

```http
GET /mcp/checks?projectName=example-project
```

Expected response:

```json
{
  "project": {
    "id": 1,
    "name": "example-project",
    "lastAnalysisDate": "2026-04-27T12:00:00.000Z"
  },
  "checks": [
    {
      "name": "UXF",
      "type": "content",
      "description": "UXF usage detected",
      "actionable": true,
      "prompt": "Update the matched usages...",
      "value": true
    }
  ]
}
```

### Result

```http
GET /mcp/result?projectName=example-project&checkName=UXF
```

Expected response:

```json
{
  "project": {
    "id": 1,
    "name": "example-project"
  },
  "check": {
    "name": "UXF",
    "type": "content",
    "description": "UXF usage detected",
    "actionable": true,
    "prompt": "Update the matched usages..."
  },
  "result": {}
}
```
