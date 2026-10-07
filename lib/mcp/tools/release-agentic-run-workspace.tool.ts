import { z } from 'zod';

import { releaseRunnerExecutionByIdentity } from '../../services/runner-execution.service.js';
import { runnerWorkspaceReleaseOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const releaseAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_release_agentic_run_workspace',
  description:
    "Optional compatibility operation that forgets this process's cached checkout context. It preserves the checkout, edits and dependencies. No release step is required.",
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
  },
  outputSchema: runnerWorkspaceReleaseOutputSchema,
  handler: ({ runKey, projectName }) =>
    releaseRunnerExecutionByIdentity(runKey, projectName),
};
