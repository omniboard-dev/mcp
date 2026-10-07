import { z } from 'zod';

import { heartbeatRunnerExecution } from '../../services/runner-execution.service.js';
import { runnerExecutionHeartbeatOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const heartbeatAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_heartbeat_agentic_run_workspace',
  description:
    'Compatibility no-op. Workspaces have no heartbeat requirement or time budget. Continue working and finalize when ready.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
  },
  outputSchema: runnerExecutionHeartbeatOutputSchema,
  handler: ({ runKey, projectName }) =>
    heartbeatRunnerExecution(runKey, projectName),
};
