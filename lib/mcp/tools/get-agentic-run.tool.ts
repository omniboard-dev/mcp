import { z } from 'zod';

import { getAgenticRun } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const getAgenticRunTool: McpToolDefinition = {
  name: 'omniboard_local_get_agentic_run',
  description:
    'Developer-local mode: get one Omniboard agentic run by runKey, including prompt, progress, and agent instructions.',
  inputSchema: {
    runKey: z.string().min(1),
  },
  handler: ({ runKey }) => getAgenticRun(runKey),
};
