import { z } from 'zod';
import {
  readAgenticRunProjectState,
  refreshAgenticRunProjectState,
  requestAgenticRunRetry,
} from '../../services/api.service.js';
import {
  projectStateOutputSchema,
  projectProgressOutputSchema,
} from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';
const identity = { runKey: z.string().min(1), projectName: z.string().min(1) };
export const readAgenticRunStateTool: McpCliToolDefinition = {
  name: 'omniboard_runner_get_project_state',
  description:
    'Read stored OMNIBOARD migration facts and the derived workflow decision. Does not refresh providers or write state.',
  outputSchema: projectStateOutputSchema.omit({ providerSync: true }),
  inputSchema: identity,
  handler: ({ runKey, projectName }) =>
    readAgenticRunProjectState(runKey as string, projectName as string),
};
export const refreshAgenticRunStateTool: McpCliToolDefinition = {
  name: 'omniboard_runner_refresh_project_state',
  outputSchema: projectStateOutputSchema,
  description:
    'Refresh provider facts and reconcile applicability, retry assessment and dismissal cleanup. Writes the reconciled state; returns the API workflow decision without preparing a workspace.',
  inputSchema: identity,
  handler: ({ runKey, projectName }) =>
    refreshAgenticRunProjectState(runKey as string, projectName as string),
};
export const retryAgenticRunStateTool: McpCliToolDefinition = {
  name: 'omniboard_runner_request_project_retry',
  description:
    'Record an explicit operator retry instruction and clear its human hold. Refresh to assess the request; this never forces work on a ready MR or changes check results.',
  outputSchema: z.object({
    row: projectProgressOutputSchema,
    retryInstruction: z
      .object({
        id: z.number(),
        disposition: z.string(),
        instruction: z.string(),
      })
      .passthrough(),
  }),
  inputSchema: { ...identity, instruction: z.string().min(1).max(4000) },
  handler: ({ runKey, projectName, instruction }) =>
    requestAgenticRunRetry(
      runKey as string,
      projectName as string,
      instruction as string
    ),
};
