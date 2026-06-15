import { z } from 'zod';

import { validateAgenticRun } from '../../services/analyzer-validation.service.js';
import { McpToolDefinition } from '../shared.js';

export const validateAgenticRunTool: McpToolDefinition = {
  name: 'omniboard_validate_agentic_run',
  description:
    'Validate one Omniboard agentic run by runKey using @omniboard/analyzer, then report validation progress.',
  inputSchema: {
    runKey: z.string().min(1),
  },
  handler: ({ runKey }) => validateAgenticRun(runKey),
};
