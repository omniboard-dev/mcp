import { z } from 'zod';

import { AGENTIC_RUN_PROGRESS_STATUS_VALUES } from '../../interface.js';
import { prepareNextRunnerProjects } from '../../services/runner-batch-preparation.service.js';
import { batchPreparationOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const prepareNextAgenticRunProjectsTool: McpCliToolDefinition = {
  name: 'omniboard_runner_prepare_next_agentic_run_projects',
  description:
    'Dedicated runner execution: order candidates smallest-first using Analyzer project-size metadata, prioritizing the source extensions most likely to change, then refresh and prepare distinct atomically leased workspaces until the requested limit is reached. The connected agent should pass relevantSourceExtensions after interpreting the run prompt; when omitted, MCP CLI derives extensions from prompt/check text and matched file paths, then falls back to total project size. Projects without size metadata sort after measured projects. Defaults to pending, pending-retry, blocked, and failed projects. Candidates already being prepared, holding an active execution lease in this MCP CLI process, or rejected because another MCP CLI process holds the API lease are reported as waiting while scanning continues. Finalize or explicitly release every returned workspace. Use the agentic-state side-effect-free list tool for discovery; use this tool when ready to acquire and work on the next projects, then list again only when an updated overview is needed.',
  inputSchema: {
    runKey: z.string().min(1),
    statuses: z
      .array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES))
      .min(1)
      .optional(),
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
