#!/usr/bin/env node

import { McpServer as McpCliSdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerMcpCliTool } from './mcp/shared.js';
import { finalizeAgenticRunWorkspaceTool } from './mcp/tools/finalize-agentic-run-workspace.tool.js';
import { getAgenticRunTool } from './mcp/tools/get-agentic-run.tool.js';
import { heartbeatAgenticRunWorkspaceTool } from './mcp/tools/heartbeat-agentic-run-workspace.tool.js';
import { listAgenticRunsTool } from './mcp/tools/list-agentic-runs.tool.js';
import { listRunnerAgenticRunsTool } from './mcp/tools/list-runner-agentic-runs.tool.js';
import { prepareAgenticRunWorkspaceTool } from './mcp/tools/prepare-agentic-run-workspace.tool.js';
import { prepareNextAgenticRunProjectsTool } from './mcp/tools/prepare-next-agentic-run-projects.tool.js';
import { releaseAgenticRunWorkspaceTool } from './mcp/tools/release-agentic-run-workspace.tool.js';
import { listAgenticRunProjectsTool } from './mcp/tools/list-agentic-run-projects.tool.js';
import { reportRunnerAgenticRunProgressBulkTool } from './mcp/tools/report-runner-agentic-run-progress-bulk.tool.js';
import { reportAgenticRunProgressTool } from './mcp/tools/report-agentic-run-progress.tool.js';
import { reportRunnerAgenticRunProgressTool } from './mcp/tools/report-runner-agentic-run-progress.tool.js';
import { validateAgenticRunTool } from './mcp/tools/validate-agentic-run.tool.js';
import { releaseAllRunnerExecutions } from './services/runner-execution.service.js';

const mcpCliServer = new McpCliSdkServer({
  name: '@omniboard/mcp',
  version: 'VERSION',
});

registerMcpCliTool(mcpCliServer, listAgenticRunsTool);
registerMcpCliTool(mcpCliServer, listAgenticRunProjectsTool);
registerMcpCliTool(mcpCliServer, listRunnerAgenticRunsTool);
registerMcpCliTool(mcpCliServer, prepareNextAgenticRunProjectsTool);
registerMcpCliTool(mcpCliServer, prepareAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, finalizeAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, releaseAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, heartbeatAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, reportRunnerAgenticRunProgressTool);
registerMcpCliTool(mcpCliServer, reportRunnerAgenticRunProgressBulkTool);
registerMcpCliTool(mcpCliServer, getAgenticRunTool);
registerMcpCliTool(mcpCliServer, reportAgenticRunProgressTool);
registerMcpCliTool(mcpCliServer, validateAgenticRunTool);

async function main() {
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      let cleanupError: unknown;
      try {
        await releaseAllRunnerExecutions();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await mcpCliServer.close();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        console.error(
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        );
        process.exitCode = 1;
      }
    })();
    return shutdownPromise;
  };

  transport.onclose = () => {
    void shutdown();
  };
  process.stdin.once('end', () => {
    void shutdown();
  });
  process.stdin.once('close', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await mcpCliServer.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
