import { z } from 'zod';

import { AGENTIC_RUN_PROGRESS_STATUS_VALUES } from '../../interface.js';
import { prepareNextRunnerProjects } from '../../services/runner-batch-preparation.service.js';
import { batchPreparationOutputSchema } from '../output-schemas.js';
import { McpToolDefinition } from '../shared.js';

export const prepareNextAgenticRunProjectsTool: McpToolDefinition = {
  name: 'omniboard_runner_prepare_next_agentic_run_projects',
  description:
    'Dedicated runner execution: use stored progress to scan candidates from one run, then refresh each selected candidate against its provider and prepare distinct atomically leased workspaces until the requested limit is reached. Defaults to blocked and failed projects. Candidates already being prepared or holding an active execution lease in this MCP process are reported as waiting while scanning continues. Use the agentic-state side-effect-free list tool for discovery; use this tool when ready to acquire and work on the next projects, then list again only when an updated overview is needed.',
  inputSchema: {
    runKey: z.string().min(1),
    statuses: z
      .array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES))
      .min(1)
      .optional(),
    limit: z.number().int().positive().max(10).optional(),
  },
  outputSchema: batchPreparationOutputSchema,
  handler: ({ runKey, statuses, limit }) =>
    prepareNextRunnerProjects({
      runKey,
      statuses,
      limit,
    }),
};
