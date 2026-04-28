import { z } from 'zod';

import { validateActionableCheckFix } from '../../services/analyzer-validation.service.js';
import { McpToolDefinition } from '../shared.js';

export const validateActionableCheckFixTool: McpToolDefinition = {
  name: 'omniboard_validate_actionable_check_fix',
  description:
    'Optionally validate whether an attempted fix resolved an actionable Omniboard check by running @omniboard/analyzer when OMNIBOARD_API_KEY is available.',
  inputSchema: {
    name: z.string().min(1),
  },
  handler: ({ name }) => validateActionableCheckFix(name),
};
