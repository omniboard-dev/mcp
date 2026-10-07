import { z } from 'zod';
import { mergeRunnerChange } from '../../services/runner-merge.service.js';
import { McpCliToolDefinition } from '../shared.js';

export const mergeAgenticRunTool: McpCliToolDefinition = {
  name: 'omniboard_runner_merge_agentic_run',
  description:
    'Merge the published migration MR through its Git provider after completing the requested change. The provider enforces its merge requirements. Progress labels never gate this operation. Returns merged=true only after the provider confirms the merge, otherwise returns its reason and current CI diagnostics for repair.',
  inputSchema: { runKey: z.string().min(1), projectName: z.string().min(1) },
  outputSchema: z
    .object({
      merged: z.boolean(),
      mergeRequestUrl: z.string(),
      reason: z.string().optional(),
      instructions: z.array(z.string()),
    })
    .passthrough(),
  handler: ({ runKey, projectName }) => mergeRunnerChange(runKey, projectName),
};
