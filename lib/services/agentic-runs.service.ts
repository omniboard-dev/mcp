import {
  AgenticRunContinuationDecision,
  AgenticRunPipelineRetryResult,
  AgenticRunProgressReportResult,
  AgenticRunProgressStatus,
  AgenticRunProgressUpsertInput,
  AgenticRunMatchedProjectsResponse,
  AgenticRunProjectState,
  AgenticRunResolution,
  AgenticRunResponse,
  AgenticRunsResponse,
  RunnerAgenticRunsResponse,
  AgenticRunSummary,
} from '../interface.js';
import * as api from './api.service.js';
import { getAgenticRunContinuationDecision } from './agentic-run-continuation.service.js';
import { getOmniboardProject } from './omniboard-context.service.js';
import { retryFailedPipeline } from './source-control.service.js';

const pipelineRetryAttempts = new Map<
  string,
  Promise<AgenticRunPipelineRetryResult>
>();

export interface ReportAgenticRunProgressOptions {
  status?: AgenticRunProgressStatus;
  resolution?: AgenticRunResolution | null;
  resolutionReason?: string | null;
  repositoryUrl?: string | null;
  localPath?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  mergeRequestUrl?: string | null;
  mergeRequestState?: string | null;
  mergeRequestDetailedStatus?: string | null;
  pipelineStatus?: string | null;
  pipelineUrl?: string | null;
  pipelineFailureSummary?: string | null;
  error?: string | null;
  notes?: string | null;
  verification?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListAgenticRunProjectsOptions {
  checkName?: string;
  runKey?: string;
}

export function listRunnerAgenticRuns(): Promise<RunnerAgenticRunsResponse> {
  return api.getRunnerAgenticRuns();
}

export async function listAgenticRuns(
  checkName?: string
): Promise<AgenticRunsResponse> {
  return api.getAgenticRuns(await getOmniboardProject(), checkName);
}

export async function listAgenticRunProjects({
  checkName,
  runKey,
}: ListAgenticRunProjectsOptions): Promise<AgenticRunMatchedProjectsResponse> {
  if (!checkName && !runKey) {
    throw new Error('Either checkName or runKey is required.');
  }

  return api.getAgenticRunMatchedProjects({ checkName, runKey });
}

export async function getRunnerAgenticRun(
  projectName: string,
  runKey: string
): Promise<AgenticRunResponse> {
  return api.getAgenticRun({ name: projectName, names: [projectName] }, runKey);
}

export async function resolveAgenticRunContinuation(
  projectState: AgenticRunProjectState
): Promise<AgenticRunContinuationDecision> {
  const continuation = getAgenticRunContinuationDecision(projectState);
  if (continuation.reason !== 'infrastructure_pipeline_failure') {
    return continuation;
  }

  const pipelineRetry = await retryInfrastructurePipeline(projectState);
  return {
    ...continuation,
    instructions: [
      ...continuation.instructions,
      formatPipelineRetryInstruction(pipelineRetry),
    ],
    pipelineRetry,
  };
}

export async function getAgenticRun(
  runKey: string
): Promise<AgenticRunResponse> {
  const project = await getOmniboardProject();
  const projectState = await api.refreshAgenticRunProjectState(
    runKey,
    project.name
  );
  const continuation = await resolveAgenticRunContinuation(projectState);
  if (continuation.action !== 'continue') {
    return withAgentContext({
      project: {
        id: projectState.project.id,
        name: projectState.project.name,
      },
      run: projectState.run,
      projectState,
      continuation,
    });
  }

  const response = await api.getAgenticRun(project, runKey);
  const progressReport = await reportAgenticRunProgressSafely(runKey, {
    status: 'in_progress',
    notes: `Started or continued agentic run "${runKey}".`,
    metadata: {
      mcpTool: 'omniboard_local_get_agentic_run',
    },
  });

  return withAgentContext({
    ...response,
    projectState,
    continuation,
    progressReport,
  });
}

export async function reportAgenticRunProgress(
  runKey: string,
  options: ReportAgenticRunProgressOptions = {}
): Promise<AgenticRunProgressReportResult> {
  assertValidResolution(options);
  const payload = await createAgenticRunProgressPayload(runKey, options);
  const response = await api.upsertAgenticRunProgress(payload);

  return {
    ok: true,
    changed: response.changed,
    payload,
    response,
  };
}

export async function reportRunnerAgenticRunProgress(
  runKey: string,
  projectName: string,
  options: ReportAgenticRunProgressOptions = {}
): Promise<AgenticRunProgressReportResult> {
  assertValidResolution(options);
  const payload = withoutUndefined({
    runKey,
    projectName,
    status: options.status,
    resolution: options.resolution,
    resolutionReason: options.resolutionReason,
    repositoryUrl: options.repositoryUrl,
    localPath: options.localPath,
    branch: options.branch,
    commitSha: options.commitSha,
    mergeRequestUrl: options.mergeRequestUrl,
    mergeRequestState: options.mergeRequestState,
    mergeRequestDetailedStatus: options.mergeRequestDetailedStatus,
    pipelineStatus: options.pipelineStatus,
    pipelineUrl: options.pipelineUrl,
    pipelineFailureSummary: options.pipelineFailureSummary,
    error: options.error,
    notes: options.notes,
    verification: options.verification,
    metadata: {
      ...(options.metadata ?? {}),
      executionMode: 'dedicated-runner',
      projectName,
    },
    lastUpdateSource: 'mcp',
  });
  const response = await api.upsertAgenticRunProgress(payload);

  return {
    ok: true,
    changed: response.changed,
    payload,
    response,
  };
}

export async function reportRunnerAgenticRunProgressSafely(
  runKey: string,
  projectName: string,
  options: ReportAgenticRunProgressOptions = {}
): Promise<AgenticRunProgressReportResult> {
  try {
    return await reportRunnerAgenticRunProgress(runKey, projectName, options);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function reportAgenticRunProgressSafely(
  runKey: string,
  options: ReportAgenticRunProgressOptions = {}
): Promise<AgenticRunProgressReportResult> {
  try {
    return await reportAgenticRunProgress(runKey, options);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createAgenticRunAgentContext(
  run: AgenticRunSummary,
  continuation?: AgenticRunContinuationDecision
) {
  const canContinue = !continuation || continuation.action === 'continue';
  if (!canContinue) {
    return {
      goal: `Do not continue Omniboard agentic run "${run.runKey}" while its continuation decision is "${continuation.action}".`,
      instructions: continuation.instructions,
      validation: {
        allowed: false,
        optional: true,
        requiredEnv: 'OMNIBOARD_API_KEY' as const,
        tool: 'omniboard_local_validate_agentic_run' as const,
        skipWhenMissingEnv: true,
      },
    };
  }

  return {
    goal: `Complete Omniboard agentic run "${run.runKey}" for check "${run.checkName}".`,
    instructions: [
      ...(continuation?.instructions ?? []),
      'Use the agentic run prompt, check metadata, and result details as the primary context for the change.',
      'Inspect the local codebase before editing and make the smallest coherent change that resolves the agentic check.',
      `Report meaningful progress with \`omniboard_local_report_agentic_run_progress\` using runKey "${run.runKey}" when work is implemented, needs input, verified, committed, pushed, MR created, done with a resolution, blocked, or failed.`,
      'If investigation concludes that no code change is required—for example, the finding is a false positive, expected usage, generated code, or the checked library\'s own implementation—report status "done", resolution "dismissed", and a concise resolutionReason such as "false_positive"; do not leave the project at "verified".',
      'After changing the code, run the relevant project build, test, or lint command when available.',
      `If \`OMNIBOARD_API_KEY\` is available, optionally run \`omniboard_local_validate_agentic_run\` with runKey "${run.runKey}" to confirm whether the check still matches.`,
      'If `OMNIBOARD_API_KEY` is not available, skip analyzer validation and report that it was skipped.',
    ],
    validation: {
      allowed: true,
      optional: true,
      requiredEnv: 'OMNIBOARD_API_KEY' as const,
      tool: 'omniboard_local_validate_agentic_run' as const,
      skipWhenMissingEnv: true,
    },
  };
}

function withAgentContext(response: AgenticRunResponse): AgenticRunResponse {
  return {
    ...response,
    agentContext: createAgenticRunAgentContext(
      response.run,
      response.continuation
    ),
  };
}

function assertValidResolution(options: ReportAgenticRunProgressOptions) {
  if (options.status === 'done' && !options.resolution) {
    throw new Error(
      'A done agentic run progress report requires a resolution.'
    );
  }

  if (options.resolution && options.status !== 'done') {
    throw new Error(
      'An agentic run resolution can only be reported with status "done".'
    );
  }

  if (options.resolutionReason && options.resolution !== 'dismissed') {
    throw new Error(
      'An agentic run resolution reason requires resolution "dismissed".'
    );
  }
}

async function createAgenticRunProgressPayload(
  runKey: string,
  options: ReportAgenticRunProgressOptions
): Promise<AgenticRunProgressUpsertInput> {
  const project = await getOmniboardProject();

  return withoutUndefined({
    runKey,
    projectName: project.name,
    status: options.status,
    resolution: options.resolution,
    resolutionReason: options.resolutionReason,
    repositoryUrl: options.repositoryUrl ?? project.repository ?? null,
    localPath: options.localPath ?? process.cwd(),
    branch: options.branch ?? project.branch ?? null,
    commitSha: options.commitSha,
    mergeRequestUrl: options.mergeRequestUrl,
    mergeRequestState: options.mergeRequestState,
    mergeRequestDetailedStatus: options.mergeRequestDetailedStatus,
    pipelineStatus: options.pipelineStatus,
    pipelineUrl: options.pipelineUrl,
    pipelineFailureSummary: options.pipelineFailureSummary,
    error: options.error,
    notes: options.notes,
    verification: options.verification,
    metadata: {
      ...(options.metadata ?? {}),
      executionMode: 'developer-local',
      projectName: project.name,
      projectType: project.type ?? null,
      projectNames: project.names,
    },
    lastUpdateSource: 'mcp',
  });
}

async function retryInfrastructurePipeline(
  projectState: AgenticRunProjectState
): Promise<AgenticRunPipelineRetryResult> {
  const pipelineUrl = projectState.progress.pipelineUrl ?? undefined;
  if (!pipelineUrl) {
    return {
      attempted: false,
      retried: false,
      reason: 'Provider state did not include a pipeline URL.',
    };
  }
  const repositoryUrl =
    projectState.project.repositoryUrl ??
    projectState.project.repositoryUrls?.[0];
  if (!repositoryUrl) {
    return {
      attempted: false,
      retried: false,
      pipelineUrl,
      reason: 'The project did not include a repository URL.',
    };
  }

  const retryKey = projectState.project.id + ':' + pipelineUrl;
  const existingRetry = pipelineRetryAttempts.get(retryKey);
  if (existingRetry) return existingRetry;

  const retry = (async (): Promise<AgenticRunPipelineRetryResult> => {
    try {
      const access = await api.getRepositoryAccess(repositoryUrl);
      const result = await retryFailedPipeline(
        access,
        repositoryUrl,
        pipelineUrl
      );
      if (!result.supported) {
        return {
          attempted: false,
          retried: false,
          provider: access.provider,
          pipelineUrl,
          reason: result.reason,
        };
      }
      return {
        attempted: true,
        retried: true,
        provider: access.provider,
        pipelineId: result.pipelineId,
        pipelineUrl: result.pipelineUrl,
        status: result.status,
      };
    } catch (error) {
      return {
        attempted: true,
        retried: false,
        pipelineUrl,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })().finally(() => pipelineRetryAttempts.delete(retryKey));
  pipelineRetryAttempts.set(retryKey, retry);
  return retry;
}

function formatPipelineRetryInstruction(
  pipelineRetry: AgenticRunPipelineRetryResult
) {
  if (pipelineRetry.retried) {
    return 'The infrastructure pipeline retry was requested successfully. Wait for its refreshed status.';
  }
  if (pipelineRetry.attempted) {
    return (
      'The infrastructure pipeline retry could not be completed: ' +
      (pipelineRetry.reason ?? 'unknown provider error') +
      ' Wait for provider recovery or retry later.'
    );
  }
  return (
    'Automatic infrastructure pipeline retry is unavailable: ' +
    (pipelineRetry.reason ?? 'the provider does not support it') +
    ' Wait for an external retry or provider update.'
  );
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, currentValue]) => currentValue !== undefined
    )
  ) as T;
}
