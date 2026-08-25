import { z } from 'zod';

import { heartbeatRunnerExecution } from '../../services/runner-execution.service.js';
import { runnerExecutionHeartbeatOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const heartbeatAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_heartbeat_agentic_run_workspace',
  description:
    'Record meaningful worker activity for a prepared runner workspace. Call at least every 10 minutes during long edits or validations; this does not extend the overall 60-minute work budget.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
  },
  outputSchema: runnerExecutionHeartbeatOutputSchema,
  handler: ({ runKey, projectName }) =>
    heartbeatRunnerExecution(runKey, projectName),
};
