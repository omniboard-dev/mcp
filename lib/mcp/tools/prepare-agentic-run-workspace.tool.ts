import { z } from 'zod';

import { prepareRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { runnerWorkspacePrepareOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const prepareAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_prepare_agentic_run_workspace',
  description:
    'Required before starting or resuming migration work, including an existing local checkout. Check the recorded MR with the provider before touching the checkout; a merged MR returns stop/change_merged without a workspace. Work only when continuation.action=continue and a workspace is returned. Prepare one migration: refresh Git/provider facts, reuse a compatible checkout or rebuild a disposable one, fetch the latest source and target, and rebase while preserving local edits. Return the prompt, CI diagnostics and any conflicts to resolve. The workflow outcome controls whether work proceeds; milestone labels remain detail. Run relevant checks, finalize, then follow the MR through CI and merge.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Use this runner checkout, rebuilding it if its local state is incompatible.'
      ),
    repositoryUrl: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  },
  outputSchema: runnerWorkspacePrepareOutputSchema,
  handler: (options) => prepareRunnerWorkspace(options),
};
