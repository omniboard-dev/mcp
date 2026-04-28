import { listActionableChecks } from '../../services/actionable-checks.service.js';
import { McpToolDefinition } from '../shared.js';

export const listActionableChecksTool: McpToolDefinition = {
  name: 'omniboard_list_actionable_checks',
  description:
    'List actionable Omniboard checks that currently have results for the resolved project.',
  inputSchema: {},
  handler: () => listActionableChecks(),
};
