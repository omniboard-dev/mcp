import { z } from 'zod';

import { AGENTIC_RUN_PROGRESS_STATUS_VALUES } from '../../interface.js';
import { prepareNextRunnerProjects } from '../../services/runner-batch-preparation.service.js';
import { batchPreparationOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const prepareNextAgenticRunProjectsTool: McpCliToolDefinition = {
  name: 'omniboard_runner_prepare_next_agentic_run_projects',
  description:
    'Continue delivering migrations through merge. By default, fill the batch from pending projects first, then started/published work, then failed/blocked/retry work; order by source size within each group. Skip work that is only waiting on CI or approval and continue scanning. Explicit statuses override the default groups and use source-size ordering. Resume and verify started work before finalizing; follow published MRs through CI repair and provider-confirmed merge. Existing work remains selectable after analyzer results change.',
  inputSchema: {
    runKey: z.string().min(1),
    statuses: z
      .array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES))
      .min(1)
      .optional()
      .describe(
        'Omit for pending-first, started/published-second, failed/blocked/retry-last fallback. Supply statuses to override the default, for example ["pending"] for new work only or ["failed", "blocked"] for repairs only.'
      ),
    limit: z.number().int().positive().max(10).optional(),
    relevantSourceExtensions: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional(),
  },
  outputSchema: batchPreparationOutputSchema,
  handler: ({ runKey, statuses, limit, relevantSourceExtensions }) =>
    prepareNextRunnerProjects({
      runKey,
      statuses,
      limit,
      relevantSourceExtensions,
    }),
};
