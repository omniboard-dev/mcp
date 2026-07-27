import { z } from 'zod';

import { finalizeRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { McpToolDefinition } from '../shared.js';

export const finalizeAgenticRunWorkspaceTool: McpToolDefinition = {
  name: 'omniboard_runner_finalize_agentic_run_workspace',
  description:
    'Dedicated runner mode: finalize normal work or continue a prepared merge-conflict recovery. Normal work is committed, pushed, and linked to a change request. Recovery may return completed=false with the next exact conflict files; when complete it rebases onto the latest target and updates the validated source branch with force-with-lease.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    localPath: z.string().min(1),
    commitMessage: z.string().min(1).optional(),
    mergeRequestTitle: z.string().min(1).optional(),
    mergeRequestDescription: z
      .string()
      .min(1)
      .describe(
        'Markdown change-request description. Use real line breaks rather than literal \\n sequences.'
      )
      .optional(),
    authorName: z.string().min(1).optional(),
    authorEmail: z.string().email().optional(),
  },
  handler: (options) => finalizeRunnerWorkspace(options),
};
