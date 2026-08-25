import { z } from 'zod';

import { reportRunnerAgenticRunProgressBulk } from '../../services/agentic-runs.service.js';
import { progressBulkReportOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';
import { runnerProgressInputSchema } from './report-runner-agentic-run-progress.tool.js';

export const reportRunnerAgenticRunProgressBulkTool: McpCliToolDefinition = {
  name: 'omniboard_runner_report_agentic_run_progress_bulk',
  description:
    'Dedicated runner mode: report or reset progress for up to 500 explicit run/project items. The MCP sends sequential API pages of at most 25 items and returns per-item results.',
  inputSchema: {
    items: z
      .array(z.object(runnerProgressInputSchema))
      .min(1)
      .max(500)
      .describe(
        'Logical bulk operation. Requests are sent to Omniboard in sequential pages of at most 25 items.'
      ),
  },
  outputSchema: progressBulkReportOutputSchema,
  handler: ({ items }) => reportRunnerAgenticRunProgressBulk(items),
};
