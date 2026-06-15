import { z } from 'zod';

import { listAgenticRuns } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const listAgenticRunsTool: McpToolDefinition = {
  name: 'omniboard_list_agentic_runs',
  description:
    'List Omniboard agentic runs for the resolved project, optionally scoped to one check name.',
  inputSchema: {
    checkName: z.string().min(1).optional(),
  },
  handler: ({ checkName }) => listAgenticRuns(checkName),
};
