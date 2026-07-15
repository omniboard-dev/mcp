import {
  AGENTIC_CHECK_RUN_PROGRESS_ENDPOINT,
  DEFAULT_API_URL,
  MCP_CHECKS_ENDPOINT,
  MCP_RUN_ENDPOINT,
  MCP_RUNS_ENDPOINT,
  MCP_MATCHED_PROJECTS_ENDPOINT,
  MCP_REPOSITORY_ACCESS_ENDPOINT,
  SETTINGS_ENDPOINT,
} from '../consts.js';
import {
  AgenticRunProgressUpsertInput,
  AgenticRunProgressUpsertResponse,
  AgenticRunResponse,
  AgenticRunsResponse,
  AgenticRunMatchedProjectsResponse,
  McpApiAgenticRun,
  McpApiChecksResponse,
  McpApiMatchedProject,
  McpApiMatchedProjectsResponse,
  McpApiProject,
  McpApiRunResponse,
  McpRepositoryAccess,
  ProjectInfo,
  Settings,
  RunnerAgenticRunsResponse,
} from '../interface.js';

let apiUrl: string;
let apiKey: string;

export function createApiService() {
  const key = process.env.OMNIBOARD_API_KEY_MCP;

  if (!key) {
    throw new Error(
      'OMNIBOARD_API_KEY_MCP environment variable is required to run @omniboard/mcp'
    );
  }

  apiKey = key;
  apiUrl = process.argv.includes('--dev')
    ? 'http://localhost:8080'
    : process.env.OMNIBOARD_API_URL ?? DEFAULT_API_URL;
}

export const getSettings = (): Promise<Settings> =>
  request<Settings>(SETTINGS_ENDPOINT);

export const getRunnerAgenticRuns =
  async (): Promise<RunnerAgenticRunsResponse> => {
    const response = await request<{ runs: McpApiAgenticRun[]; total: number }>(
      MCP_RUNS_ENDPOINT
    );
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
  const response = await request<McpApiChecksResponse>(MCP_CHECKS_ENDPOINT, {
    query: {
      projectName: project.name,
    },
  });
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
  const response = await request<McpApiRunResponse>(MCP_RUN_ENDPOINT, {
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
  const response = await request<McpApiMatchedProjectsResponse>(
    MCP_MATCHED_PROJECTS_ENDPOINT,
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

  return {
    check: response.check,
    run: run ? { ...run, check: run.check ?? response.check } : null,
    runs,
    projects: (response.projects ?? []).map(normalizeMatchedProject),
    total: response.total ?? response.projects?.length ?? 0,
  };
};

export const getRepositoryAccess = (
  repositoryUrl: string
): Promise<McpRepositoryAccess> =>
  request<McpRepositoryAccess>(MCP_REPOSITORY_ACCESS_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ repositoryUrl }),
  });

export const upsertAgenticRunProgress = (
  progress: AgenticRunProgressUpsertInput
): Promise<AgenticRunProgressUpsertResponse> =>
  request<AgenticRunProgressUpsertResponse>(
    AGENTIC_CHECK_RUN_PROGRESS_ENDPOINT,
    {
      method: 'PUT',
      body: JSON.stringify(progress),
    }
  );

type QueryValue = string | number | boolean | null | undefined;

async function request<T>(
  endpoint: string,
  init: RequestInit & { query?: Record<string, QueryValue> } = {}
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

  const { query, ...requestInit } = init;
  const response = await fetch(url, {
    ...requestInit,
    headers: {
      'Content-Type': 'application/json',
      'omniboard-api-key': apiKey,
      ...requestInit.headers,
    },
  });

  if (!response.ok) {
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    throw new Error(
      body?.message ??
        `Omniboard API request failed with ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as T;
}

function normalizeAgenticRunsResponse(
  response: McpApiAgenticRun[],
  fallbackCheckName = ''
) {
  return response
    .map((run) => normalizeAgenticRunSummary(run, fallbackCheckName))
    .filter((run): run is NonNullable<typeof run> => Boolean(run));
}

function normalizeAgenticRunSummary(
  run: McpApiAgenticRun,
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
    status,
    progress: run.progress ?? null,
    result: run.result,
    isActive: run.isActive ?? run.active ?? status === 'active',
    creationDate: run.creationDate ?? null,
    updateDate: run.updateDate ?? null,
    raw: run,
  };
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
  project: Partial<McpApiProject> | undefined,
  fallbackName: string
): McpApiProject {
  return {
    id: project?.id ?? 0,
    name: project?.name ?? fallbackName,
    lastAnalysisDate: project?.lastAnalysisDate,
  };
}

function normalizeMatchedProject(
  project: McpApiMatchedProject
): McpApiMatchedProject {
  return {
    id: project.id,
    name: project.name,
    lastAnalysisDate: project.lastAnalysisDate ?? null,
    updateDate: project.updateDate ?? null,
    value: project.value ?? null,
    result: project.result ?? null,
    repositoryUrl: project.repositoryUrl ?? null,
    repositoryUrls: project.repositoryUrls ?? [],
  };
}
