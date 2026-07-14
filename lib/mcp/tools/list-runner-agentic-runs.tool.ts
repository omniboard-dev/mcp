import { listRunnerAgenticRuns } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const listRunnerAgenticRunsTool: McpToolDefinition = {
  name: 'omniboard_runner_list_agentic_runs',
  description:
    'Dedicated runner mode: list all active Omniboard agentic runs available to the MCP key before selecting a run and matching project.',
  inputSchema: {},
  handler: () => listRunnerAgenticRuns(),
};
