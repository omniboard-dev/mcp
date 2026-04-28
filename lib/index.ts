#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTool } from './mcp/shared.js';
import { getActionableCheckResultsTool } from './mcp/tools/get-actionable-check-results.tool.js';
import { listActionableChecksTool } from './mcp/tools/list-actionable-checks.tool.js';
import { validateActionableCheckFixTool } from './mcp/tools/validate-actionable-check-fix.tool.js';

const server = new McpServer({
  name: '@omniboard/mcp',
  version: 'VERSION',
});

registerTool(server, listActionableChecksTool);
registerTool(server, getActionableCheckResultsTool);
registerTool(server, validateActionableCheckFixTool);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
