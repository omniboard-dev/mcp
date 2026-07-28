import { z } from 'zod';

import { validateAgenticRun } from '../../services/analyzer-validation.service.js';
import { agenticRunValidationOutputSchema } from '../output-schemas.js';
import { McpToolDefinition } from '../shared.js';

export const validateAgenticRunTool: McpToolDefinition = {
  name: 'omniboard_local_validate_agentic_run',
  description:
    'Developer-local mode: validate one Omniboard agentic run by runKey using @omniboard/analyzer, then report validation progress.',
  inputSchema: {
    runKey: z.string().min(1),
  },
  outputSchema: agenticRunValidationOutputSchema,
  handler: ({ runKey }) => validateAgenticRun(runKey),
};
