import { z } from 'zod';

import { AGENTIC_RUN_PROGRESS_STATUS_VALUES } from '../../interface.js';
import { listAgenticRunProjects } from '../../services/agentic-runs.service.js';
import { matchedProjectsOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const listAgenticRunProjectsTool: McpCliToolDefinition = {
  name: 'omniboard_runner_list_agentic_run_projects',
  description:
    'Dedicated runner discovery: read stored Omniboard projects and progress without refreshing providers, preparing workspaces, or changing agentic-run state. Use this agentic-state side-effect-free listing to select candidates and inspect results; provider status may be stale until a selected project is prepared. After preparation refreshes selected projects, list again only when an updated overview is needed.',
  inputSchema: {
    checkName: z.string().min(1).optional(),
    runKey: z.string().min(1).optional(),
    statuses: z
      .array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES))
      .min(1)
      .optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional(),
    view: z.enum(['full', 'summary']).optional(),
  },
  outputSchema: matchedProjectsOutputSchema,
  handler: ({ checkName, runKey, statuses, offset, limit, view }) =>
    listAgenticRunProjects({
      checkName,
      runKey,
      statuses,
      offset,
      limit,
      view,
    }),
};
