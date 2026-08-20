import { z } from 'zod';

import { listAgenticRuns } from '../../services/agentic-runs.service.js';
import { localAgenticRunsOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const listAgenticRunsTool: McpCliToolDefinition = {
  name: 'omniboard_local_list_agentic_runs',
  description:
    'Developer-local mode: list Omniboard agentic runs for the resolved current project, optionally scoped to one check name.',
  inputSchema: {
    checkName: z.string().min(1).optional(),
  },
  outputSchema: localAgenticRunsOutputSchema,
  handler: ({ checkName }) => listAgenticRuns(checkName),
};
