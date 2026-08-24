import { z } from 'zod';

import {
  AGENTIC_RUN_REPORTABLE_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_RESOLUTION_VALUES,
} from '../../interface.js';
import { reportAgenticRunProgress } from '../../services/agentic-runs.service.js';
import { progressReportOutputSchema } from '../output-schemas.js';
import { McpCliToolDefinition } from '../shared.js';

export const reportAgenticRunProgressTool: McpCliToolDefinition = {
  name: 'omniboard_local_report_agentic_run_progress',
  description:
    'Developer-local mode: report progress for one Omniboard agentic run using its runKey.',
  inputSchema: {
    runKey: z.string().min(1),
    status: z.enum(AGENTIC_RUN_REPORTABLE_PROGRESS_STATUS_VALUES),
    resolution: z.enum(AGENTIC_RUN_RESOLUTION_VALUES).nullable().optional(),
    resolutionReason: z.string().min(1).max(255).nullable().optional(),
    repositoryUrl: z.string().min(1).max(1024).optional(),
    branch: z.string().min(1).max(512).optional(),
    commitSha: z.string().min(1).max(64).optional(),
    mergeRequestUrl: z.string().min(1).max(1024).optional(),
    mergeRequestState: z.string().min(1).max(64).optional(),
    mergeRequestDetailedStatus: z.string().min(1).max(128).optional(),
    pipelineStatus: z.string().min(1).max(64).optional(),
    pipelineUrl: z.string().min(1).max(1024).optional(),
    pipelineFailureSummary: z.string().min(1).optional(),
    error: z.string().min(1).nullable().optional(),
    notes: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Optional Markdown-formatted progress notes. Plain text is valid Markdown.'
      ),
    verification: z.record(z.unknown()).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  },
  outputSchema: progressReportOutputSchema,
  handler: ({ runKey, ...progress }) =>
    reportAgenticRunProgress(runKey, progress),
};
