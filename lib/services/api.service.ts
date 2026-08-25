import {
  DEFAULT_API_URL,
  MCP_CLI_CHECKS_ENDPOINT,
  MCP_CLI_MATCHED_PROJECTS_ENDPOINT,
  MCP_CLI_PROGRESS_BULK_ENDPOINT,
  MCP_CLI_PROGRESS_ENDPOINT,
  MCP_CLI_REPOSITORY_ACCESS_ENDPOINT,
  MCP_CLI_RUN_ENDPOINT,
  MCP_CLI_RUN_EXECUTIONS_ENDPOINT,
  MCP_CLI_RUN_PROJECT_PROVIDER_SNAPSHOT_ENDPOINT,
  MCP_CLI_RUN_PROJECT_STATE_REFRESH_ENDPOINT,
  MCP_CLI_RUNS_ENDPOINT,
  MCP_CLI_SETTINGS_ENDPOINT,
} from '../consts.js';
import {
  AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES,
  AgenticRunMatchedProject,
  AgenticRunProgressBulkResponse,
  AgenticRunProgressUpsertInput,
  AgenticRunProgressUpsertResponse,
  AgenticRunProjectFulfillment,
  AgenticRunProjectState,
  AgenticRunProviderSnapshot,
  AgenticRunResponse,
  AgenticRunsResponse,
  AgenticRunMatchedProjectsResponse,
  McpCliApiAgenticRun,
  McpCliApiChecksResponse,
  McpCliApiMatchedProject,
  McpCliApiMatchedProjectsResponse,
  McpCliApiProject,
  McpCliApiRunResponse,
  RepositoryAccess,
  ProjectInfo,
  Settings,
  RunnerAgenticRunsResponse,
  RunnerExecution,
  RunnerExecutionLeaseResponse,
  RunnerExecutionPhase,
  RunnerWorkspaceRebaseRecovery,
} from '../interface.js';

let apiUrl: string;
let apiKey: string;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_IDEMPOTENT_RETRIES = 2;
const MAX_PROGRESS_BULK_PAGE_SIZE = 25;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createApiService() {
  const key = process.env.OMNIBOARD_API_KEY_MCP_CLI;

  if (!key) {
    throw new Error(
      'OMNIBOARD_API_KEY_MCP_CLI environment variable is required to run @omniboard/mcp'
    );
  }

  apiKey = key;
  apiUrl = process.argv.includes('--dev')
    ? 'http://localhost:8080'
    : process.env.OMNIBOARD_API_URL ?? DEFAULT_API_URL;
}

export const getSettings = (): Promise<Settings> =>
  request<Settings>(MCP_CLI_SETTINGS_ENDPOINT);

export const getRunnerAgenticRuns =
  async (): Promise<RunnerAgenticRunsResponse> => {
    const response = await request<{
      runs: McpCliApiAgenticRun[];
      total: number;
    }>(MCP_CLI_RUNS_ENDPOINT);
    const runs = normalizeAgenticRunsResponse(response.runs ?? []);
    return {
      runs,
      total: response.total ?? runs.length,
    };
  };

export const getAgenticRuns = async (
  project: ProjectInfo,
  checkName?: string
): Promise<AgenticRunsResponse> => {
  const response = await request<McpCliApiChecksResponse>(
    MCP_CLI_CHECKS_ENDPOINT,
    {
      query: {
        projectName: project.name,
      },
    }
  );
  const projectResponse = normalizeApiProject(response.project, project.name);
  const runs = response.checks
    .filter((check) => !checkName || check.name === checkName)
    .flatMap((check) =>
      normalizeAgenticRunsResponse(check.agenticRuns ?? [], check.name).map(
        (run) => ({
          ...run,
          check: run.check ?? check,
          project: run.project ?? projectResponse,
          result: run.result,
        })
      )
    );

  return {
    project: projectResponse,
    runs,
    total: runs.length,
  };
};

export const getAgenticRun = async (
  project: ProjectInfo,
  runKey: string
): Promise<AgenticRunResponse> => {
  const response = await request<McpCliApiRunResponse>(MCP_CLI_RUN_ENDPOINT, {
    query: {
      projectName: project.name,
      runKey,
    },
  });
  const run = normalizeAgenticRunSummary(
    {
      ...response.run,
      check: response.run.check ?? response.check,
      project: response.run.project ?? response.project,
      result: response.run.result ?? response.result,
    },
    response.check.name
  );

  if (!run) {
    throw new Error(`Agentic run "${runKey}" was not found.`);
  }

  return {
    project: response.project,
    run,
    result: response.result,
  };
};

export const getAgenticRunMatchedProjects = async ({
  checkName,
  runKey,
}: {
  checkName?: string;
  runKey?: string;
}): Promise<AgenticRunMatchedProjectsResponse> => {
  const response = await request<McpCliApiMatchedProjectsResponse>(
    MCP_CLI_MATCHED_PROJECTS_ENDPOINT,
    {
      query: {
        checkName,
        runKey,
      },
    }
  );
  const runs = normalizeAgenticRunsResponse(
    response.runs ?? [],
    response.check.name
  ).map((run) => ({
    ...run,
    check: run.check ?? response.check,
  }));
  const run = response.run
    ? normalizeAgenticRunSummary(
        {
          ...response.run,
          check: response.run.check ?? response.check,
        },
        response.check.name
      )
    : null;

  const projects = AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES.flatMap(
    (fulfillment) =>
      response.projectGroups[fulfillment].map((project) => ({
        ...normalizeMatchedProject(project),
        fulfillment,
      }))
  );

  return {
    check: response.check,
    run: run ? { ...run, check: run.check ?? response.check } : null,
    runs,
    projects,
    total: response.total ?? projects.length,
    totalsByFulfillment: response.totalsByFulfillment,
  };
};

export const refreshAgenticRunProjectState = (
  runKey: string,
  projectName: string
): Promise<AgenticRunProjectState> =>
  request<AgenticRunProjectState>(MCP_CLI_RUN_PROJECT_STATE_REFRESH_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ runKey, projectName }),
  });

export const applyAgenticRunProjectProviderSnapshot = (
  runKey: string,
  projectName: string,
  snapshot: AgenticRunProviderSnapshot
): Promise<AgenticRunProjectState> =>
  request<AgenticRunProjectState>(
    MCP_CLI_RUN_PROJECT_PROVIDER_SNAPSHOT_ENDPOINT,
    {
      method: 'POST',
      body: JSON.stringify({ runKey, projectName, ...snapshot }),
    }
  );

export const getRepositoryAccess = (
  repositoryUrl: string
): Promise<RepositoryAccess> =>
  request<RepositoryAccess>(MCP_CLI_REPOSITORY_ACCESS_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ repositoryUrl }),
  });

export const upsertAgenticRunProgress = (
  progress: AgenticRunProgressUpsertInput
): Promise<AgenticRunProgressUpsertResponse> =>
  request<AgenticRunProgressUpsertResponse>(MCP_CLI_PROGRESS_ENDPOINT, {
    method: 'PUT',
    body: JSON.stringify(progress),
  });

export async function upsertAgenticRunProgressBulk(
  items: AgenticRunProgressUpsertInput[]
): Promise<AgenticRunProgressBulkResponse> {
  const results: AgenticRunProgressBulkResponse['results'] = [];
  const ambiguousIndexes = new Set<number>();
  let successCount = 0;
  let errorCount = 0;

  for (
    let offset = 0;
    offset < items.length;
    offset += MAX_PROGRESS_BULK_PAGE_SIZE
  ) {
    const pageItems = items.slice(offset, offset + MAX_PROGRESS_BULK_PAGE_SIZE);
    try {
      const page = await request<
        Pick<
          AgenticRunProgressBulkResponse,
          'successCount' | 'errorCount' | 'results'
        >
      >(MCP_CLI_PROGRESS_BULK_ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify({ items: pageItems }),
      });
      successCount += page.successCount;
      errorCount += page.errorCount;
      results.push(
        ...page.results.map((result) => ({
          ...result,
          index: offset + result.index,
        }))
      );
    } catch (error) {
      errorCount += pageItems.length;
      if (isAmbiguousBulkRequestFailure(error)) {
        pageItems.forEach((_item, index) =>
          ambiguousIndexes.add(offset + index)
        );
      }
      results.push(
        ...pageItems.map((item, index) => ({
          index: offset + index,
          runKey: item.runKey,
          projectName: item.projectName,
          status: 'error' as const,
          error: error instanceof Error ? error.message : String(error),
        }))
      );
    }
  }

  const verification = await verifyBulkProgress(
    items,
    results,
    ambiguousIndexes
  );
  successCount += verification.recoveredCount;
  errorCount -= verification.recoveredCount;
  successCount -= verification.regressedCount;
  errorCount += verification.regressedCount;

  return {
    total: items.length,
    successCount,
    errorCount,
    pageCount: Math.ceil(items.length / MAX_PROGRESS_BULK_PAGE_SIZE),
    verifiedCount: verification.verifiedCount,
    residualCount: verification.residuals.length,
    residuals: verification.residuals,
    results,
  };
}

async function verifyBulkProgress(
  items: AgenticRunProgressUpsertInput[],
  results: AgenticRunProgressBulkResponse['results'],
  ambiguousIndexes: Set<number>
) {
  const residuals: AgenticRunProgressBulkResponse['residuals'] = [];
  const itemsByRun = new Map<
    string,
    Array<{
      index: number;
      item: AgenticRunProgressUpsertInput;
    }>
  >();
  items.forEach((item, index) => {
    if (!item.status) return;
    const runItems = itemsByRun.get(item.runKey) ?? [];
    runItems.push({ index, item });
    itemsByRun.set(item.runKey, runItems);
  });

  let verifiedCount = 0;
  let recoveredCount = 0;
  let regressedCount = 0;
  for (const [runKey, runItems] of itemsByRun) {
    let projects: AgenticRunMatchedProject[];
    try {
      projects = (await getAgenticRunMatchedProjects({ runKey })).projects;
    } catch (error) {
      const verificationError =
        error instanceof Error ? error.message : String(error);
      residuals.push(
        ...runItems.map(({ index, item }) => ({
          index,
          runKey,
          projectName: item.projectName,
          expectedStatus: normalizeReportedStatus(item.status!),
          actualStatus: null,
          verificationError,
        }))
      );
      continue;
    }

    const statusByProject = new Map(
      projects.map((project) => [
        project.name,
        project.progress?.status ?? null,
      ])
    );
    for (const { index, item } of runItems) {
      const expectedStatus = normalizeReportedStatus(item.status!);
      const actualStatus = statusByProject.get(item.projectName) ?? null;
      const result = results.find((candidate) => candidate.index === index);
      if (actualStatus === expectedStatus) {
        if (result?.status === 'success') {
          verifiedCount += 1;
        } else if (result && ambiguousIndexes.has(index)) {
          verifiedCount += 1;
          result.status = 'success';
          delete result.error;
          recoveredCount += 1;
        } else {
          residuals.push({
            index,
            runKey,
            projectName: item.projectName,
            expectedStatus,
            actualStatus,
            verificationError:
              'The bulk item was explicitly rejected; matching status alone cannot verify its other fields.',
          });
        }
        continue;
      }

      residuals.push({
        index,
        runKey,
        projectName: item.projectName,
        expectedStatus,
        actualStatus,
      });
      if (result?.status === 'success') {
        result.status = 'error';
        result.error = `Progress verification expected "${expectedStatus}" but found "${
          actualStatus ?? 'missing'
        }".`;
        delete result.changed;
        regressedCount += 1;
      }
    }
  }

  return { verifiedCount, recoveredCount, regressedCount, residuals };
}

function normalizeReportedStatus(
  status: NonNullable<AgenticRunProgressUpsertInput['status']>
) {
  return status === 'merged' ? 'done' : status;
}

function isAmbiguousBulkRequestFailure(error: unknown) {
  return (
    error instanceof OmniboardApiError &&
    (error.status === 0 || RETRYABLE_HTTP_STATUSES.has(error.status))
  );
}

export const acquireRunnerExecution = (input: {
  runKey: string;
  projectName: string;
  repositoryUrl: string;
  sourceControlProvider: RepositoryAccess['provider'];
  sourceControlRepositoryId: string;
  branch: string;
  commitMessage?: string | null;
  leaseOwner: string;
  leaseToken?: string;
}): Promise<RunnerExecutionLeaseResponse> =>
  request<RunnerExecutionLeaseResponse>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT + '/acquire',
    { method: 'POST', body: JSON.stringify(input) }
  );

export const renewRunnerExecution = (
  executionKey: string,
  leaseToken: string
): Promise<RunnerExecutionLeaseResponse> =>
  request<RunnerExecutionLeaseResponse>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT +
      '/' +
      encodeURIComponent(executionKey) +
      '/renew',
    { method: 'POST', body: JSON.stringify({ leaseToken }) }
  );

export const checkpointRunnerExecution = (
  executionKey: string,
  input: {
    leaseToken: string;
    expectedStateVersion: number;
    phase: RunnerExecutionPhase;
    targetBranch?: string | null;
    commitMessage?: string | null;
    preparedHeadSha?: string | null;
    commitSha?: string | null;
    recovery?: RunnerWorkspaceRebaseRecovery | null;
  }
): Promise<RunnerExecution> =>
  request<RunnerExecution>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT +
      '/' +
      encodeURIComponent(executionKey) +
      '/checkpoint',
    { method: 'PATCH', body: JSON.stringify(input) }
  );

export const reinitializeRunnerExecution = (
  executionKey: string,
  input: { leaseToken: string; expectedStateVersion: number }
): Promise<RunnerExecution> =>
  request<RunnerExecution>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT +
      '/' +
      encodeURIComponent(executionKey) +
      '/reinitialize',
    { method: 'POST', body: JSON.stringify(input) }
  );

export const completeRunnerExecutionByIdentity = (input: {
  runKey: string;
  projectName: string;
  phase: 'completed' | 'abandoned';
}): Promise<{ completed: boolean; execution: RunnerExecution | null }> =>
  request<{ completed: boolean; execution: RunnerExecution | null }>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT + '/complete-by-identity',
    { method: 'POST', body: JSON.stringify(input) }
  );

export const completeRunnerExecution = (
  executionKey: string,
  input: {
    leaseToken: string;
    expectedStateVersion: number;
    phase: 'completed' | 'abandoned';
  }
): Promise<RunnerExecution> =>
  request<RunnerExecution>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT +
      '/' +
      encodeURIComponent(executionKey) +
      '/complete',
    { method: 'POST', body: JSON.stringify(input) }
  );

export const releaseRunnerExecution = (
  executionKey: string,
  leaseToken: string
): Promise<RunnerExecution> =>
  request<RunnerExecution>(
    MCP_CLI_RUN_EXECUTIONS_ENDPOINT +
      '/' +
      encodeURIComponent(executionKey) +
      '/release',
    { method: 'POST', body: JSON.stringify({ leaseToken }) }
  );

type QueryValue = string | number | boolean | null | undefined;

export class OmniboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'OmniboardApiError';
  }
}

type ApiRequestInit = RequestInit & {
  query?: Record<string, QueryValue>;
  retry?: boolean;
  timeoutMs?: number;
};

async function request<T>(
  endpoint: string,
  init: ApiRequestInit = {}
): Promise<T> {
  if (!apiKey || !apiUrl) {
    createApiService();
  }

  const url = new URL(endpoint, `${apiUrl}/`);
  Object.entries(init.query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const { query, retry, timeoutMs, ...requestInit } = init;
  const method = requestInit.method?.toUpperCase() ?? 'GET';
  const operation = `${method} ${url.origin}${url.pathname}`;
  const shouldRetry = retry ?? ['GET', 'HEAD', 'PUT'].includes(method);
  const maxAttempts =
    1 +
    (shouldRetry
      ? readNonNegativeInteger(
          process.env.OMNIBOARD_API_IDEMPOTENT_RETRIES,
          DEFAULT_IDEMPOTENT_RETRIES
        )
      : 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const requestTimeoutMs =
      timeoutMs ??
      readPositiveInteger(
        process.env.OMNIBOARD_API_REQUEST_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS
      );
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref();

    let response: Response;
    try {
      response = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'omniboard-api-key': apiKey,
          ...requestInit.headers,
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      if (attempt < maxAttempts) {
        await waitBeforeRetry(attempt);
        continue;
      }
      const reason = controller.signal.aborted
        ? `timed out after ${requestTimeoutMs}ms`
        : describeTransportError(error);
      throw new OmniboardApiError(
        `Omniboard API ${operation} transport failed: ${reason}`,
        0
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('x-cloud-trace-context') ??
        undefined;
      let body: any;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const detail =
        body?.message ??
        `request failed with ${response.status} ${response.statusText}`;
      const error = new OmniboardApiError(
        `Omniboard API ${operation}: ${detail} (HTTP ${response.status}${
          requestId ? `, request ${requestId}` : ''
        })`,
        response.status,
        requestId
      );
      if (
        attempt < maxAttempts &&
        RETRYABLE_HTTP_STATUSES.has(response.status)
      ) {
        await waitBeforeRetry(attempt);
        continue;
      }
      throw error;
    }

    return (await response.json()) as T;
  }

  throw new Error(`Omniboard API ${operation} exhausted its retry budget`);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitBeforeRetry(attempt: number) {
  const baseDelayMs = Math.min(2_000, 250 * 2 ** (attempt - 1));
  const jitterMs = Math.floor(Math.random() * 100);
  return new Promise<void>((resolve) =>
    setTimeout(resolve, baseDelayMs + jitterMs)
  );
}

function describeTransportError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string } | undefined;
  return cause?.code ? `${error.message} (${cause.code})` : error.message;
}

function normalizeAgenticRunsResponse(
  response: McpCliApiAgenticRun[],
  fallbackCheckName = ''
) {
  return response
    .map((run) => normalizeAgenticRunSummary(run, fallbackCheckName))
    .filter((run): run is NonNullable<typeof run> => Boolean(run));
}

function normalizeAgenticRunSummary(
  run: McpCliApiAgenticRun,
  fallbackCheckName: string
) {
  const runKey = normalizeString(run.runKey ?? run.key ?? run.id);

  if (!runKey) {
    return undefined;
  }

  const status = normalizeString(run.status ?? run.progress?.status) ?? null;
  const checkName =
    normalizeString(run.checkName ?? run.check?.name) ?? fallbackCheckName;

  return {
    runKey,
    checkName,
    check: run.check ?? null,
    project: run.project ?? null,
    prompt: normalizeString(run.prompt ?? run.check?.prompt) ?? null,
    branchName: normalizeString(run.branchName) ?? null,
    commitMessage: normalizeString(run.commitMessage) ?? null,
    targetFulfillment: normalizeProjectFulfillment(run.targetFulfillment),
    status,
    progress: run.progress ?? null,
    result: run.result,
    isActive: run.isActive ?? run.active ?? status === 'active',
    creationDate: run.creationDate ?? null,
    updateDate: run.updateDate ?? null,
    raw: run,
  };
}

function normalizeProjectFulfillment(
  value: unknown
): AgenticRunProjectFulfillment {
  return AGENTIC_RUN_PROJECT_FULFILLMENT_VALUES.includes(
    value as AgenticRunProjectFulfillment
  )
    ? (value as AgenticRunProjectFulfillment)
    : 'fulfilled';
}

function normalizeString(value: unknown) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

function normalizeApiProject(
  project: Partial<McpCliApiProject> | undefined,
  fallbackName: string
): McpCliApiProject {
  return {
    id: project?.id ?? 0,
    name: project?.name ?? fallbackName,
    lastAnalysisDate: project?.lastAnalysisDate,
  };
}

function normalizeMatchedProject(
  project: McpCliApiMatchedProject
): McpCliApiMatchedProject & { targetedByRun: boolean } {
  return {
    id: project.id,
    name: project.name,
    lastAnalysisDate: project.lastAnalysisDate ?? null,
    updateDate: project.updateDate ?? null,
    value: project.value ?? null,
    result: project.result ?? null,
    repositoryUrl: project.repositoryUrl ?? null,
    repositoryUrls: project.repositoryUrls ?? [],
    projectSize: project.projectSize ?? null,
    progress: project.progress ?? null,
    targetedByRun: project.targetedByRun ?? false,
  };
}
