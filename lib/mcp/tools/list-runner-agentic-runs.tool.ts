import { listRunnerAgenticRuns } from '../../services/agentic-runs.service.js';
import { runnerAgenticRunsOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const listRunnerAgenticRunsTool: McpCliToolDefinition = {
  name: 'omniboard_runner_list_agentic_runs',
  description:
    'Dedicated runner mode: list all active Omniboard agentic runs available to the MCP CLI key before selecting a run and matching project.',
  inputSchema: {},
  outputSchema: runnerAgenticRunsOutputSchema,
  handler: () => listRunnerAgenticRuns(),
};
