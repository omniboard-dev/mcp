import { GitlabRepositoryAccess } from '../interface.js';
import {
  isLocalTransportAllowed,
  isLoopbackHostname,
} from './url-security.service.js';

interface GitlabMergeRequestResponse {
  id?: number;
  iid?: number;
  web_url?: string;
  state?: string;
  title?: string;
}

interface GitlabProjectResponse {
  archived?: boolean;
  repository_access_level?: string;
  merge_requests_access_level?: string;
  permissions?: {
    project_access?: { access_level?: number } | null;
    group_access?: { access_level?: number } | null;
  };
}

interface GitlabProjectPermissionsResponse {
  data?: {
    project?: {
      userPermissions?: {
        pushCode?: boolean;
        createMergeRequestIn?: boolean;
        createMergeRequestFrom?: boolean;
      };
    } | null;
  };
  errors?: { message?: string }[];
}

export async function validateGitlabProjectAccess(
  access: GitlabRepositoryAccess,
  repositoryUrl: string
) {
  const apiBaseUrl = resolveGitlabApiBaseUrl(access.apiBaseUrl);
  const projectPath = resolveGitlabProjectPath(
    access,
    repositoryUrl,
    apiBaseUrl
  );
  const endpoint = `${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}`;
  const response = await fetch(endpoint, {
    headers: { 'PRIVATE-TOKEN': access.token },
  });

  if (!response.ok) {
    throw new Error(
      `GitLab project access validation failed with ${response.status} ${
        response.statusText
      }: ${await readError(response)}`
    );
  }

  const project = (await response.json()) as GitlabProjectResponse;
  const accessLevel = Math.max(
    project.permissions?.project_access?.access_level ?? 0,
    project.permissions?.group_access?.access_level ?? 0
  );
  if (project.archived) {
    throw new Error('GitLab project is archived and cannot accept changes.');
  }
  if (project.repository_access_level === 'disabled') {
    throw new Error('GitLab repository access is disabled for this project.');
  }
  if (project.merge_requests_access_level === 'disabled') {
    throw new Error('GitLab merge requests are disabled for this project.');
  }

  const graphQlUrl = resolveGitlabGraphQlUrl(apiBaseUrl);
  const permissionResponse = await fetch(graphQlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': access.token,
    },
    body: JSON.stringify({
      query:
        'query RunnerProjectPermissions($projectPath: ID!) { project(fullPath: $projectPath) { userPermissions { pushCode createMergeRequestIn createMergeRequestFrom } } }',
      variables: { projectPath },
    }),
  });
  if (!permissionResponse.ok) {
    throw new Error(
      `GitLab effective permission validation failed with ${
        permissionResponse.status
      } ${permissionResponse.statusText}: ${await readError(
        permissionResponse
      )}`
    );
  }

  const permissionBody =
    (await permissionResponse.json()) as GitlabProjectPermissionsResponse;
  const permissions = permissionBody.data?.project?.userPermissions;
  if (permissionBody.errors?.length || !permissions) {
    throw new Error(
      `GitLab effective permission validation failed: ${
        permissionBody.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ') || 'project permissions were not returned'
      }`
    );
  }
  if (
    !permissions.pushCode ||
    !permissions.createMergeRequestIn ||
    !permissions.createMergeRequestFrom
  ) {
    throw new Error(
      'GitLab token requires effective pushCode, createMergeRequestIn, and createMergeRequestFrom permissions.'
    );
  }

  return { projectPath, accessLevel, permissions };
}

export async function createGitlabMergeRequest(
  access: GitlabRepositoryAccess,
  projectPath: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description?: string
) {
  const apiBaseUrl = resolveGitlabApiBaseUrl(access.apiBaseUrl);
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  const endpoint = `${apiBaseUrl}/projects/${encodeURIComponent(
    normalizedProjectPath
  )}/merge_requests`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': access.token,
    },
    body: JSON.stringify({
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description,
      remove_source_branch: true,
    }),
  });

  if (response.ok) {
    return normalizeMergeRequest(
      (await response.json()) as GitlabMergeRequestResponse
    );
  }

  if (response.status === 409) {
    const existing = await findOpenMergeRequest(
      endpoint,
      access.token,
      sourceBranch,
      targetBranch
    );
    if (existing) {
      return normalizeMergeRequest(existing);
    }
  }

  throw new Error(
    `GitLab merge request creation failed with ${response.status} ${
      response.statusText
    }: ${await readError(response)}`
  );
}

async function findOpenMergeRequest(
  endpoint: string,
  token: string,
  sourceBranch: string,
  targetBranch: string
) {
  const url = new URL(endpoint);
  url.searchParams.set('state', 'opened');
  url.searchParams.set('source_branch', sourceBranch);
  url.searchParams.set('target_branch', targetBranch);
  const response = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
  });

  if (!response.ok) {
    return undefined;
  }

  const mergeRequests = (await response.json()) as GitlabMergeRequestResponse[];
  return mergeRequests[0];
}

function normalizeMergeRequest(response: GitlabMergeRequestResponse) {
  if (!response.web_url) {
    throw new Error('GitLab merge request response did not include web_url.');
  }

  return {
    id: response.id,
    iid: response.iid,
    url: response.web_url,
    state: response.state ?? 'opened',
    title: response.title ?? '',
  };
}

function resolveGitlabProjectPath(
  access: GitlabRepositoryAccess,
  repositoryUrl: string,
  apiBaseUrl: string
) {
  const repositoryProjectPath = resolveRepositoryProjectPath(
    repositoryUrl,
    apiBaseUrl
  );
  if (access.projectPath) {
    const accessProjectPath = normalizeProjectPath(access.projectPath);
    if (
      repositoryProjectPath &&
      accessProjectPath.toLowerCase() !== repositoryProjectPath.toLowerCase()
    ) {
      throw new Error(
        `GitLab project path "${accessProjectPath}" does not match repository URL project "${repositoryProjectPath}".`
      );
    }
    return accessProjectPath;
  }
  if (!repositoryProjectPath) {
    throw new Error(
      'GitLab repository access did not include a canonical projectPath.'
    );
  }
  return repositoryProjectPath;
}

function resolveRepositoryProjectPath(
  repositoryUrl: string,
  apiBaseUrl: string
) {
  if (repositoryUrl.includes('://')) {
    let repository: URL;
    try {
      repository = new URL(repositoryUrl);
    } catch {
      throw new Error(`Invalid GitLab repository URL "${repositoryUrl}".`);
    }
    if (repository.protocol === 'file:' && isLocalTransportAllowed()) {
      return undefined;
    }
    let repositoryPath = decodeURIComponent(repository.pathname);
    const api = new URL(apiBaseUrl);
    const relativeRoot = decodeURIComponent(api.pathname)
      .replace(/\/+$/, '')
      .replace(/\/api\/v4$/, '');
    if (
      relativeRoot &&
      repository.host.toLowerCase() === api.host.toLowerCase() &&
      repositoryPath.startsWith(`${relativeRoot}/`)
    ) {
      repositoryPath = repositoryPath.slice(relativeRoot.length);
    }
    return normalizeProjectPath(repositoryPath);
  }

  const scpPath = /^(?:[^@]+@)?[^:]+:(?<path>.+)$/.exec(repositoryUrl)?.groups
    ?.path;
  if (!scpPath) {
    throw new Error(`Invalid GitLab repository URL "${repositoryUrl}".`);
  }
  return normalizeProjectPath(scpPath);
}

function normalizeProjectPath(projectPath: unknown) {
  if (typeof projectPath !== 'string') {
    throw new Error(
      'GitLab repository access did not include a canonical projectPath.'
    );
  }
  const normalized = projectPath.replace(/^\/+/, '').replace(/\.git$/, '');
  if (!normalized || !normalized.includes('/')) {
    throw new Error(`Invalid GitLab project path "${projectPath}".`);
  }
  return normalized;
}

function resolveGitlabApiBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid GitLab API base URL "${value}".`);
  }

  if (
    url.protocol !== 'https:' &&
    !(
      isLocalTransportAllowed() &&
      url.protocol === 'http:' &&
      isLoopbackHostname(url.hostname)
    )
  ) {
    throw new Error(
      'GitLab API URLs must use HTTPS. Loopback HTTP requires OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS=true.'
    );
  }
  if (url.username || url.password) {
    throw new Error('GitLab API URLs must not contain embedded credentials.');
  }

  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function resolveGitlabGraphQlUrl(apiBaseUrl: string) {
  const url = new URL(apiBaseUrl);
  const restApiSuffix = '/api/v4';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(restApiSuffix)) {
    throw new Error(
      `GitLab API base URL "${apiBaseUrl}" must end with "${restApiSuffix}".`
    );
  }

  url.pathname = `${pathname.slice(0, -restApiSuffix.length)}/api/graphql`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string'
      ? body.message
      : JSON.stringify(body.message ?? body);
  } catch {
    return response.statusText;
  }
}
