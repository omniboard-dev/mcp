import {
  AgenticRunProgressReportResult,
  AgenticRunProgressStatus,
  AgenticRunProgressUpsertInput,
  AgenticRunMatchedProjectsResponse,
  AgenticRunResponse,
  AgenticRunsResponse,
  AgenticRunSummary,
} from '../interface.js';
import * as api from './api.service.js';
import { getOmniboardProject } from './omniboard-context.service.js';

export interface ReportAgenticRunProgressOptions {
  status?: AgenticRunProgressStatus;
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

export async function listAgenticRuns(
  checkName?: string,
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

export async function getAgenticRun(
  runKey: string,
): Promise<AgenticRunResponse> {
  const response = await api.getAgenticRun(await getOmniboardProject(), runKey);
  const progressReport = await reportAgenticRunProgressSafely(runKey, {
    status: 'in_progress',
    notes: `Started agentic run "${runKey}".`,
    metadata: {
      mcpTool: 'omniboard_get_agentic_run',
    },
  });

  return withAgentContext({
    ...response,
    progressReport,
  });
}

export async function reportAgenticRunProgress(
  runKey: string,
  options: ReportAgenticRunProgressOptions = {},
): Promise<AgenticRunProgressReportResult> {
  const payload = await createAgenticRunProgressPayload(runKey, options);
  const response = await api.upsertAgenticRunProgress(payload);

  return {
    ok: true,
    changed: response.changed,
    payload,
    response,
  };
}

export async function reportAgenticRunProgressSafely(
  runKey: string,
  options: ReportAgenticRunProgressOptions = {},
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

export function createAgenticRunAgentContext(run: AgenticRunSummary) {
  return {
    goal: `Complete Omniboard agentic run "${run.runKey}" for check "${run.checkName}".`,
    instructions: [
      'Use the agentic run prompt, check metadata, and result details as the primary context for the change.',
      'Inspect the local codebase before editing and make the smallest coherent change that resolves the agentic check.',
      `Report meaningful progress with \`omniboard_report_agentic_run_progress\` using runKey "${run.runKey}" when work is implemented, needs input, verified, committed, pushed, MR created, merged, blocked, or failed.`,
      'After changing the code, run the relevant project build, test, or lint command when available.',
      `If \`OMNIBOARD_API_KEY\` is available, optionally run \`omniboard_validate_agentic_run\` with runKey "${run.runKey}" to confirm whether the check still matches.`,
      'If `OMNIBOARD_API_KEY` is not available, skip analyzer validation and report that it was skipped.',
    ],
    validation: {
      optional: true,
      requiredEnv: 'OMNIBOARD_API_KEY' as const,
      tool: 'omniboard_validate_agentic_run' as const,
      skipWhenMissingEnv: true,
    },
  };
}

function withAgentContext(response: AgenticRunResponse): AgenticRunResponse {
  return {
    ...response,
    agentContext: createAgenticRunAgentContext(response.run),
  };
}

async function createAgenticRunProgressPayload(
  runKey: string,
  options: ReportAgenticRunProgressOptions,
): Promise<AgenticRunProgressUpsertInput> {
  const project = await getOmniboardProject();

  return withoutUndefined({
    runKey,
    projectName: project.name,
    status: options.status,
    repositoryUrl: options.repositoryUrl ?? project.repository ?? null,
    localPath: options.localPath ?? process.cwd(),
    branch: options.branch ?? project.branch ?? null,
    commitSha: options.commitSha ?? null,
    mergeRequestUrl: options.mergeRequestUrl ?? null,
    mergeRequestState: options.mergeRequestState ?? null,
    mergeRequestDetailedStatus: options.mergeRequestDetailedStatus ?? null,
    pipelineStatus: options.pipelineStatus ?? null,
    pipelineUrl: options.pipelineUrl ?? null,
    pipelineFailureSummary: options.pipelineFailureSummary ?? null,
    error: options.error ?? null,
    notes: options.notes ?? null,
    verification: options.verification ?? null,
    metadata: {
      ...(options.metadata ?? {}),
      projectName: project.name,
      projectType: project.type ?? null,
      projectNames: project.names,
    },
    lastUpdateSource: 'mcp',
  });
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, currentValue]) => currentValue !== undefined,
    ),
  ) as T;
}
