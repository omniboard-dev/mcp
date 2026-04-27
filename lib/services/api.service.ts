import {
  DEFAULT_API_URL,
  MCP_CHECKS_ENDPOINT,
  MCP_RESULT_ENDPOINT,
  SETTINGS_ENDPOINT,
} from '../consts.js';
import {
  ActionableCheckResultResponse,
  ActionableChecksResponse,
  ActionableCheckSummary,
  McpApiCheckResultResponse,
  McpApiCheckSummary,
  McpApiChecksResponse,
  McpApiProject,
  ProjectInfo,
  Settings,
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

export const getActionableChecks = async (
  project: ProjectInfo
): Promise<ActionableChecksResponse> => {
  const response = await request<McpApiChecksResponse>(MCP_CHECKS_ENDPOINT, {
    query: {
      projectName: project.name,
    },
  });

  return {
    project: normalizeApiProject(response.project, project.name),
    checks: normalizeActionableChecksResponse(response.checks),
  };
};

export const getActionableCheckResult = async (
  project: ProjectInfo,
  checkName: string
): Promise<ActionableCheckResultResponse> => {
  const response = await request<McpApiCheckResultResponse>(
    MCP_RESULT_ENDPOINT,
    {
      query: {
        projectName: project.name,
        checkName,
      },
    }
  );

  return {
    project: response.project,
    check: response.check,
    result: response.result,
  };
};

async function request<T>(
  endpoint: string,
  init: RequestInit & { query?: Record<string, string> } = {}
): Promise<T> {
  if (!apiKey || !apiUrl) {
    createApiService();
  }

  const url = new URL(endpoint, `${apiUrl}/`);
  Object.entries(init.query ?? {}).forEach(([key, value]) => {
    url.searchParams.set(key, value);
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

function normalizeActionableChecksResponse(
  response: unknown
): ActionableCheckSummary[] {
  if (Array.isArray(response)) {
    return response
      .map((check) => normalizeActionableCheckSummary(check))
      .filter((check): check is ActionableCheckSummary => Boolean(check.name));
  }

  if (
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { checks?: unknown }).checks)
  ) {
    return normalizeActionableChecksResponse(
      (response as { checks: unknown[] }).checks
    );
  }

  if (response && typeof response === 'object') {
    return Object.entries(response as Record<string, unknown>).map(
      ([name, check]) =>
        normalizeActionableCheckSummary({
          name,
          ...((check ?? {}) as object),
        })
    );
  }

  return [];
}

function normalizeActionableCheckSummary(
  check: unknown
): ActionableCheckSummary {
  if (typeof check === 'string') {
    return {
      name: check,
      type: 'unknown',
      description: null,
      prompt: null,
      value: null,
    };
  }

  const currentCheck = check as Partial<McpApiCheckSummary>;

  return {
    name: currentCheck.name ?? '',
    type: currentCheck.type ?? 'unknown',
    description: currentCheck.description ?? null,
    prompt: currentCheck.prompt ?? null,
    value: currentCheck.value ?? null,
  };
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
