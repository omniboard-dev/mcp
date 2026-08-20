import { z } from 'zod';

import {
  AGENTIC_RUN_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES,
} from '../../interface.js';
import { listAgenticRunProjects } from '../../services/agentic-runs.service.js';
import { matchedProjectsOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const listAgenticRunProjectsTool: McpCliToolDefinition = {
  name: 'omniboard_runner_list_agentic_run_projects',
  description:
    'Dedicated runner discovery: read stored fulfilled or unfulfilled Omniboard projects and progress without refreshing providers, preparing workspaces, or changing agentic-run state. Fulfilled projects are returned by default. Use fulfillment "unfulfilled" for checked projects whose result is false; unchecked projects are excluded. Provider status may be stale until a selected fulfilled project is prepared.',
  inputSchema: {
    checkName: z.string().min(1).optional(),
    runKey: z.string().min(1).optional(),
    fulfillment: z.enum(AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES).optional(),
    statuses: z
      .array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES))
      .min(1)
      .optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional(),
    view: z.enum(['full', 'summary']).optional(),
  },
  outputSchema: matchedProjectsOutputSchema,
  handler: ({
    checkName,
    runKey,
    fulfillment,
    statuses,
    offset,
    limit,
    view,
  }) =>
    listAgenticRunProjects({
      checkName,
      runKey,
      fulfillment,
      statuses,
      offset,
      limit,
      view,
    }),
};
