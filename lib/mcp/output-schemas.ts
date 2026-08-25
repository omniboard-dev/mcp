import { z } from 'zod';

import {
  AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES,
  AGENTIC_RUN_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_RESOLUTION_VALUES,
  RUNNER_EXECUTION_PHASE_VALUES,
} from '../interface.js';

const unknownObjectSchema = z.object({}).passthrough();
const nullableString = z.string().nullable().optional();
const pipelineFailureJobDiagnosticOutputSchema = z
  .object({
    kind: z.enum(['job', 'bridge']).optional(),
    name: z.string(),
    stage: nullableString,
    status: z.string(),
    failureReason: nullableString,
    url: nullableString,
    traceExcerpt: nullableString,
    traceFetchError: nullableString,
  })
  .passthrough();
const pipelineFailureDiagnosticsOutputSchema = z
  .object({
    pipelineUrl: z.string().nullable(),
    fetchedAt: z.string(),
    jobs: z.array(pipelineFailureJobDiagnosticOutputSchema),
    lastAttemptAt: z.string(),
    lastAttemptError: z.string().nullable(),
  })
  .passthrough();

export const agenticRunSummaryOutputSchema = z
  .object({
    runKey: z.string(),
    checkName: z.string(),
    prompt: nullableString,
    branchName: nullableString,
    commitMessage: nullableString,
    targetFulfillment: z.enum(AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES),
    status: nullableString,
    progress: unknownObjectSchema.nullable().optional(),
    result: z.unknown().optional(),
    isActive: z.boolean(),
    creationDate: nullableString,
    updateDate: nullableString,
  })
  .passthrough();

export const projectProgressOutputSchema = z
  .object({
    status: z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES),
    resolution: z.enum(AGENTIC_RUN_RESOLUTION_VALUES).nullable().optional(),
    resolutionReason: nullableString,
    branch: nullableString,
    commitSha: nullableString,
    mergeRequestUrl: nullableString,
    mergeRequestState: nullableString,
    mergeRequestDetailedStatus: nullableString,
    pipelineStatus: nullableString,
    pipelineUrl: nullableString,
    pipelineFailureSummary: nullableString,
    pipelineFailureDiagnostics: pipelineFailureDiagnosticsOutputSchema
      .nullable()
      .optional(),
    providerSyncError: nullableString,
    error: nullableString,
  })
  .passthrough();

const projectSizeMetricsOutputSchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  byExtension: z.record(z.number().int().nonnegative()),
  linesByExtension: z.record(z.number().int().nonnegative()),
});

const projectSizeOutputSchema = projectSizeMetricsOutputSchema.extend({
  breakdownVersion: z.number().int().nonnegative().optional(),
  source: projectSizeMetricsOutputSchema.optional(),
  others: projectSizeMetricsOutputSchema.optional(),
});

export const matchedProjectOutputSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    lastAnalysisDate: nullableString,
    updateDate: nullableString,
    value: z.union([z.boolean(), z.string()]).nullable().optional(),
    result: z.unknown().optional(),
    repositoryUrl: nullableString,
    repositoryUrls: z.array(z.string()).optional(),
    projectSize: projectSizeOutputSchema.nullable().optional(),
    progress: projectProgressOutputSchema.nullable().optional(),
    fulfillment: z.enum(AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES),
    targetedByRun: z.boolean(),
  })
  .passthrough();

const continuationOutputSchema = z
  .object({
    action: z.enum(['continue', 'wait', 'stop']),
    reason: z.string(),
    instructions: z.array(z.string()),
    diagnostics: z.array(z.string()),
    pipelineRetry: unknownObjectSchema.optional(),
  })
  .passthrough();

const projectStateOutputSchema = z
  .object({
    run: agenticRunSummaryOutputSchema,
    project: unknownObjectSchema,
    progress: projectProgressOutputSchema,
    providerSync: unknownObjectSchema,
  })
  .passthrough();

export const runnerWorkspaceOutputSchema = z
  .object({
    executionKey: z.string(),
    generation: z.number(),
    stateVersion: z.number(),
    phase: z.enum(RUNNER_EXECUTION_PHASE_VALUES),
    runKey: z.string(),
    checkName: z.string(),
    projectName: z.string(),
    repositoryUrl: z.string(),
    localPath: z.string(),
    branch: z.string(),
    commitMessage: z.string().optional(),
    targetBranch: z.string(),
    projectPath: z.string(),
    preparedHeadSha: z.string(),
    commitSha: z.string().optional(),
    provider: z.enum(['gitlab', 'bitbucket_data_center']),
    apiBaseUrl: z.string(),
    recovery: unknownObjectSchema.optional(),
  })
  .passthrough();

export const progressReportOutputSchema = z
  .object({
    ok: z.boolean(),
    skipped: z.boolean().optional(),
    error: z.string().optional(),
    changed: z.boolean().optional(),
    payload: unknownObjectSchema.optional(),
    response: unknownObjectSchema.optional(),
  })
  .passthrough();

export const progressBulkReportOutputSchema = z
  .object({
    total: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    verifiedCount: z.number().int().nonnegative(),
    residualCount: z.number().int().nonnegative(),
    residuals: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        runKey: z.string(),
        projectName: z.string(),
        expectedStatus: z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES),
        actualStatus: z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES).nullable(),
        verificationError: z.string().optional(),
      })
    ),
    results: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          runKey: z.string(),
          projectName: z.string(),
          status: z.enum(['success', 'error']),
          id: z.number().int().nullable().optional(),
          changed: z.boolean().optional(),
          error: z.string().optional(),
        })
        .passthrough()
    ),
  })
  .passthrough();

export const runnerAgenticRunsOutputSchema = z
  .object({
    runs: z.array(agenticRunSummaryOutputSchema),
    total: z.number().int().nonnegative(),
  })
  .passthrough();

export const localAgenticRunsOutputSchema = z
  .object({
    project: unknownObjectSchema,
    runs: z.array(agenticRunSummaryOutputSchema),
    total: z.number().int().nonnegative(),
  })
  .passthrough();

export const matchedProjectsOutputSchema = z
  .object({
    check: unknownObjectSchema,
    run: agenticRunSummaryOutputSchema.nullable(),
    runs: z.array(agenticRunSummaryOutputSchema),
    projects: z.array(matchedProjectOutputSchema),
    total: z.number().int().nonnegative(),
    unfilteredTotal: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    hasMore: z.boolean(),
    view: z.enum(['full', 'summary']),
    statuses: z.array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES)),
    totalsByFulfillment: z.object({
      fulfilled: z.number().int().nonnegative(),
      unfulfilled: z.number().int().nonnegative(),
      unchecked: z.number().int().nonnegative(),
    }),
  })
  .passthrough();

export const agenticRunOutputSchema = z
  .object({
    project: unknownObjectSchema,
    run: agenticRunSummaryOutputSchema,
    result: z.unknown().optional(),
    agentContext: unknownObjectSchema.optional(),
    progressReport: progressReportOutputSchema.optional(),
    projectState: projectStateOutputSchema.optional(),
    continuation: continuationOutputSchema.optional(),
  })
  .passthrough();

export const runnerWorkspacePrepareOutputSchema = z
  .object({
    run: agenticRunSummaryOutputSchema,
    project: matchedProjectOutputSchema,
    result: z.unknown().optional(),
    projectState: projectStateOutputSchema,
    continuation: continuationOutputSchema,
    workspace: runnerWorkspaceOutputSchema.optional(),
    prompt: z.string().nullable(),
    instructions: z.array(z.string()),
    progressReport: progressReportOutputSchema.optional(),
  })
  .passthrough();

export const runnerWorkspaceFinalizeOutputSchema = z
  .object({
    completed: z.boolean(),
    workspace: runnerWorkspaceOutputSchema,
    commitSha: z.string().optional(),
    mergeRequest: unknownObjectSchema.optional(),
    progressReports: z.array(progressReportOutputSchema),
    conflictFiles: z.array(z.string()).optional(),
    instructions: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const agenticRunValidationOutputSchema = z
  .object({
    checkName: z.string(),
    runKey: z.string(),
    run: agenticRunSummaryOutputSchema,
    skipped: z.boolean(),
    skipReason: z.string().optional(),
    command: z.string(),
    outputPath: z.string(),
    value: z.boolean().optional(),
    stillMatches: z.boolean().optional(),
    resolved: z.boolean().optional(),
    result: z.unknown().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    generatedJsonCleanedUp: z.boolean(),
    continuation: continuationOutputSchema.optional(),
    progressReport: progressReportOutputSchema.optional(),
  })
  .passthrough();

export const runnerExecutionHeartbeatOutputSchema = z
  .object({
    runKey: z.string(),
    projectName: z.string(),
    executionKey: z.string(),
    heartbeatAt: z.string(),
    workStaleAfter: z.string(),
    executionBudgetEndsAt: z.string(),
  })
  .passthrough();

export const runnerWorkspaceReleaseOutputSchema = z
  .object({
    runKey: z.string(),
    projectName: z.string(),
    executionKey: z.string().nullable(),
    released: z.boolean(),
  })
  .passthrough();

export const batchPreparationOutputSchema = z
  .object({
    runKey: z.string(),
    requestedStatuses: z.array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES)),
    requestedLimit: z.number().int().positive(),
    candidatesTotal: z.number().int().nonnegative(),
    examined: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    sourceSelection: z.object({
      extensions: z.array(z.string()),
      origin: z.enum([
        'explicit',
        'prompt_and_results',
        'total_project_fallback',
      ]),
      projectsWithSize: z.number().int().nonnegative(),
      projectsWithoutSize: z.number().int().nonnegative(),
    }),
    summary: z.object({
      prepared: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
      stopped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    results: z.array(
      z.object({
        projectName: z.string(),
        initialStatus: z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES).nullable(),
        outcome: z.enum(['prepared', 'waiting', 'stopped', 'failed']),
        sizeRanking: z.object({
          metadataAvailable: z.boolean(),
          relevantExtensions: z.array(z.string()),
          relevantLines: z.number().int().nonnegative().nullable(),
          relevantFiles: z.number().int().nonnegative().nullable(),
          totalLines: z.number().int().nonnegative().nullable(),
          totalFiles: z.number().int().nonnegative().nullable(),
        }),
        preparation: runnerWorkspacePrepareOutputSchema.optional(),
        reason: z
          .enum(['preparation_in_progress', 'execution_lease_active'])
          .optional(),
        error: z.string().optional(),
      })
    ),
  })
  .passthrough();
