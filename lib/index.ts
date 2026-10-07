#!/usr/bin/env node

import { McpServer as McpCliSdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { mergeAgenticRunTool } from './mcp/tools/merge-agentic-run.tool.js';
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

const mcpCliServer = new McpCliSdkServer(
  {
    name: '@omniboard/mcp',
    version: 'VERSION',
  },
  {
    instructions: [
      "Prime directive for agentic migrations: deliver the requested change and reach provider-confirmed merge. Within the user's scope and constraints, use this goal to resolve ambiguous next steps. Publication alone is not completion.",
      'For continue or next-N requests, use omniboard_runner_prepare_next_agentic_run_projects without statuses: it prioritizes pending work, then started/published work, then failed/blocked/retry work. Explicit user status filters override that default. Finish each selected migration through implementation, checks, publication, CI repair and merge; do not abandon it just because preparation changed its status.',
      'Resume in_progress work by inspecting and completing the migration before finalization. For an open MR, inspect CI and review feedback, repair actionable failures, and call omniboard_runner_merge_agentic_run when ready. The provider enforces its merge requirements.',
      "Runner checkouts are disposable. Rebuild incompatible local state from the existing MR branch and latest target, or start fresh if the branch is gone. Closed or declined MRs do not finish the migration; publication can create a replacement. Continue using the migration's recorded repository.",
      'Duplicate effort is an accepted efficiency tradeoff, not a reason to stop delivery. Do not require ownership leases or heartbeats. Check progress-report results so failed reporting does not hide the actual Git/provider outcome.',
      'When CI or external approval is pending, continue other actionable projects. Report the concrete blocker and outstanding migrations when external action is required. Claim completion only when the provider confirms the merge; an empty batch or a successful push is not proof that every migration has merged.',
    ].join('\n\n'),
  }
);

registerMcpCliTool(mcpCliServer, listAgenticRunsTool);
registerMcpCliTool(mcpCliServer, listAgenticRunProjectsTool);
registerMcpCliTool(mcpCliServer, listRunnerAgenticRunsTool);
registerMcpCliTool(mcpCliServer, prepareNextAgenticRunProjectsTool);
registerMcpCliTool(mcpCliServer, prepareAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, finalizeAgenticRunWorkspaceTool);
registerMcpCliTool(mcpCliServer, mergeAgenticRunTool);
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
