import { z } from 'zod';

import { finalizeRunnerWorkspace } from '../../services/runner-workspace.service.js';
import { runnerWorkspaceFinalizeOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const finalizeAgenticRunWorkspaceTool: McpCliToolDefinition = {
  name: 'omniboard_runner_finalize_agentic_run_workspace',
  description:
    'Once all applicable local build, lint, unit-test and end-to-end checks pass, call this tool to publish the verified migration. While checks fail, diagnose and repair migration-related code or tests, then rerun the checks. When a check requires unavailable access, report the blocker and leave publication pending. Refresh source and target, continue resolved rebases, commit and push the migration, reusing an open MR or replacing a closed one. An empty branch diff blocks publication and returns completed=false: apply missing work and retry, or explicitly dismiss with a reason after confirming nothing is needed. Conflicts or a recreated checkout return completed=false for migration work and checks before publication. After publication, wait for running CI and repair failed CI or conflicts. Stop agent work when the open MR is green and mergeable; do not merge it.',
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
