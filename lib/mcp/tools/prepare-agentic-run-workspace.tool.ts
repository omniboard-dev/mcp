import { z } from 'zod';

import { prepareRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { runnerWorkspacePrepareOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const prepareAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_prepare_agentic_run_workspace',
  description:
    'Dedicated runner execution: after selecting one project from the agentic-state side-effect-free project list, refresh that selected project against its Git provider and stop when canonical progress does not permit work. Otherwise, safely reuse a retained checkout or resume the existing remote branch and return the prompt, diagnostics, workspace, and instructions. Finalize the returned workspace, or explicitly release it if work stops. Do not use preparation as broad discovery: list first, prepare selected work, then list again only when an updated overview is needed.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    repositoryUrl: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  },
  outputSchema: runnerWorkspacePrepareOutputSchema,
  handler: (options) => prepareRunnerWorkspace(options),
};
