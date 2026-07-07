import { z } from 'zod';

import { listAgenticRunProjects } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const listAgenticRunProjectsTool: McpToolDefinition = {
  name: 'omniboard_runner_list_agentic_run_projects',
  description:
    'Dedicated runner mode: list Omniboard projects matching an agentic check or run without resolving the current workspace or reporting progress.',
  inputSchema: {
    checkName: z.string().min(1).optional(),
    runKey: z.string().min(1).optional(),
  },
  handler: ({ checkName, runKey }) =>
    listAgenticRunProjects({
      checkName,
      runKey,
    }),
};
