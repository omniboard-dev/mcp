import { z } from 'zod';

import { getActionableCheckResults } from '../../services/actionable-checks.service.js';
import { McpToolDefinition } from '../shared.js';

export const getActionableCheckResultsTool: McpToolDefinition = {
  name: 'omniboard_get_actionable_check_results',
  description:
    'Get actionable prompt, check results, and agent instructions for an actionable Omniboard check by name.',
  inputSchema: {
    name: z.string().min(1),
  },
  handler: ({ name }) => getActionableCheckResults(name),
};
