import { z } from 'zod';

import { prepareRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { McpToolDefinition } from '../shared.js';

export const prepareAgenticRunWorkspaceTool: McpToolDefinition = {
  name: 'omniboard_runner_prepare_agentic_run_workspace',
  description:
    'Dedicated runner mode: reconcile one run and project with its Git provider, stop when canonical progress does not permit work, otherwise safely reuse a retained checkout or resume the existing remote branch, and return the prompt, diagnostics, workspace, and instructions.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    repositoryUrl: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  },
  handler: (options) => prepareRunnerWorkspace(options),
};
