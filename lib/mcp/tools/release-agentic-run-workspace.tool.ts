import { z } from 'zod';

import { releaseRunnerExecutionByIdentity } from '../../services/runner-execution.service.js';
import { runnerWorkspaceReleaseOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const releaseAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_release_agentic_run_workspace',
  description:
    'Release a prepared workspace lease owned by this MCP CLI process when the caller will not finalize that workspace. Renewal stops immediately, while the DB execution and local workspace remain resumable. The operation is idempotent and never releases a lease owned by another MCP CLI process.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
  },
  outputSchema: runnerWorkspaceReleaseOutputSchema,
  handler: ({ runKey, projectName }) =>
    releaseRunnerExecutionByIdentity(runKey, projectName),
};
