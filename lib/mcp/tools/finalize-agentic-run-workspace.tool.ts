import { z } from 'zod';

import { finalizeRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { runnerWorkspaceFinalizeOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const finalizeAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_finalize_agentic_run_workspace',
  description:
    'Refresh source and target, continue resolved rebases, commit and push the migration, reusing an open MR or replacing a closed one. Conflicts or a recreated checkout return completed=false for migration work and checks before publication. Successful publication is not a merge: inspect CI, fix failures, and merge when the provider permits it.',
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
  },
  outputSchema: runnerWorkspaceFinalizeOutputSchema,
  handler: (options) => finalizeRunnerWorkspace(options),
};
