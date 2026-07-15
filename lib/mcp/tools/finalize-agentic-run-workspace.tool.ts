import { z } from 'zod';

import { finalizeRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { McpToolDefinition } from '../shared.js';

export const finalizeAgenticRunWorkspaceTool: McpToolDefinition = {
  name: 'omniboard_runner_finalize_agentic_run_workspace',
  description:
    'Dedicated runner mode: commit the prepared workspace changes using the prepared run commit message unless overridden, retrieve fresh repository access, push the agentic branch to the validated repository URL, create or reuse a change request, and report committed, pushed, and change-request progress to Omniboard.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    localPath: z.string().min(1),
    commitMessage: z.string().min(1).optional(),
    mergeRequestTitle: z.string().min(1).optional(),
    mergeRequestDescription: z.string().min(1).optional(),
    authorName: z.string().min(1).optional(),
    authorEmail: z.string().email().optional(),
  },
  handler: (options) => finalizeRunnerWorkspace(options),
};
