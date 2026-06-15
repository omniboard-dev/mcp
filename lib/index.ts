#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTool } from './mcp/shared.js';
import { getAgenticRunTool } from './mcp/tools/get-agentic-run.tool.js';
import { listAgenticRunsTool } from './mcp/tools/list-agentic-runs.tool.js';
import { reportAgenticRunProgressTool } from './mcp/tools/report-agentic-run-progress.tool.js';
import { validateAgenticRunTool } from './mcp/tools/validate-agentic-run.tool.js';

const server = new McpServer({
  name: '@omniboard/mcp',
  version: 'VERSION',
});

registerTool(server, listAgenticRunsTool);
registerTool(server, getAgenticRunTool);
registerTool(server, reportAgenticRunProgressTool);
registerTool(server, validateAgenticRunTool);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
