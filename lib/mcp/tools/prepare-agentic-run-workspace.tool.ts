import { z } from 'zod';

import { prepareRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { McpToolDefinition } from '../shared.js';

export const prepareAgenticRunWorkspaceTool: McpToolDefinition = {
  name: 'omniboard_runner_prepare_agentic_run_workspace',
  description:
    'Dedicated runner mode: resolve one matching project, retrieve its source-control credential securely, clone it into the runner-owned .omniboard/mcp workspace, resolve branch and commit values from the run definition or prompt with safe defaults, create the branch, and return the run prompt and local path.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    repositoryUrl: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  },
  handler: (options) => prepareRunnerWorkspace(options),
};
