import { z } from 'zod';

import {
  AGENTIC_RUN_PROGRESS_STATUS_VALUES,
  AGENTIC_RUN_RESOLUTION_VALUES,
  RUNNER_EXECUTION_PHASE_VALUES,
} from '../interface.js';

const unknownObjectSchema = z.object({}).passthrough();
const nullableString = z.string().nullable().optional();

export const agenticRunSummaryOutputSchema = z
  .object({
    runKey: z.string(),
    checkName: z.string(),
    prompt: nullableString,
    branchName: nullableString,
    commitMessage: nullableString,
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
    providerSyncError: nullableString,
    error: nullableString,
  })
  .passthrough();

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
    progress: projectProgressOutputSchema.nullable().optional(),
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

export const batchPreparationOutputSchema = z
  .object({
    runKey: z.string(),
    requestedStatuses: z.array(z.enum(AGENTIC_RUN_PROGRESS_STATUS_VALUES)),
    requestedLimit: z.number().int().positive(),
    candidatesTotal: z.number().int().nonnegative(),
    examined: z.number().int().nonnegative(),
    hasMore: z.boolean(),
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
        preparation: runnerWorkspacePrepareOutputSchema.optional(),
        reason: z
          .enum(['preparation_in_progress', 'execution_lease_active'])
          .optional(),
        error: z.string().optional(),
      })
    ),
  })
  .passthrough();
