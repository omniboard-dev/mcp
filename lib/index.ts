#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTool } from './mcp/shared.js';
import { finalizeAgenticRunWorkspaceTool } from './mcp/tools/finalize-agentic-run-workspace.tool.js';
import { getAgenticRunTool } from './mcp/tools/get-agentic-run.tool.js';
import { listAgenticRunsTool } from './mcp/tools/list-agentic-runs.tool.js';
import { listRunnerAgenticRunsTool } from './mcp/tools/list-runner-agentic-runs.tool.js';
import { prepareAgenticRunWorkspaceTool } from './mcp/tools/prepare-agentic-run-workspace.tool.js';
import { listAgenticRunProjectsTool } from './mcp/tools/list-agentic-run-projects.tool.js';
import { reportAgenticRunProgressTool } from './mcp/tools/report-agentic-run-progress.tool.js';
import { reportRunnerAgenticRunProgressTool } from './mcp/tools/report-runner-agentic-run-progress.tool.js';
import { validateAgenticRunTool } from './mcp/tools/validate-agentic-run.tool.js';

const server = new McpServer({
  name: '@omniboard/mcp',
  version: 'VERSION',
});

registerTool(server, listAgenticRunsTool);
registerTool(server, listAgenticRunProjectsTool);
registerTool(server, listRunnerAgenticRunsTool);
registerTool(server, prepareAgenticRunWorkspaceTool);
registerTool(server, finalizeAgenticRunWorkspaceTool);
registerTool(server, reportRunnerAgenticRunProgressTool);
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
