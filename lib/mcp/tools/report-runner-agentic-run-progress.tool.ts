import { z } from 'zod';

import {
  AGENTIC_RUN_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_RESOLUTION_VALUES,
} from '../../interface.js';
import { reportRunnerAgenticRunProgress } from '../../services/agentic-runs.service.js';
import { McpToolDefinition } from '../shared.js';

export const reportRunnerAgenticRunProgressTool: McpToolDefinition = {
  name: 'omniboard_runner_report_agentic_run_progress',
  description:
    'Dedicated runner mode: report progress for an explicit run and project without resolving the MCP process working directory.',
  inputSchema: {
    runKey: z.string().min(1),
    projectName: z.string().min(1),
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
  handler: ({ runKey, projectName, ...progress }) =>
    reportRunnerAgenticRunProgress(runKey, projectName, progress),
};
