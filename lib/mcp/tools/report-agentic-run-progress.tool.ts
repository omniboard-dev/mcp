import { z } from 'zod';

import {
  AGENTIC_RUN_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_RESOLUTION_VALUES,
} from '../../interface.js';
import { reportAgenticRunProgress } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const reportAgenticRunProgressTool: McpToolDefinition = {
  name: 'omniboard_local_report_agentic_run_progress',
  description:
    'Developer-local mode: report progress for one Omniboard agentic run using its runKey.',
  inputSchema: {
    runKey: z.string().min(1),
    status: z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES),
    resolution: z.enum(AGENTIC_RUN_RESOLUTION_VALUES).nullable().optional(),
    resolutionReason: z.string().min(1).nullable().optional(),
    repositoryUrl: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    mergeRequestUrl: z.string().min(1).optional(),
    mergeRequestState: z.string().min(1).optional(),
    mergeRequestDetailedStatus: z.string().min(1).optional(),
    pipelineStatus: z.string().min(1).optional(),
    pipelineUrl: z.string().min(1).optional(),
    pipelineFailureSummary: z.string().min(1).optional(),
    error: z.string().min(1).nullable().optional(),
    notes: z.string().min(1).nullable().optional(),
    verification: z.record(z.unknown()).nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  },
  handler: ({ runKey, ...progress }) =>
    reportAgenticRunProgress(runKey, progress),
};
