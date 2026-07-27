import { BitbucketDataCenterRepositoryAccess } from '../interface.js';
import {
  isLocalTransportAllowed,
  isLoopbackHostname,
} from './url-security.service.js';

interface BitbucketRepositoryResponse {
  archived?: boolean;
  state?: string;
}

interface BitbucketPullRequestResponse {
  id?: number;
  state?: string;
  title?: string;
  version?: number;
  fromRef?: { id?: string; latestCommit?: string | null };
  toRef?: { id?: string; latestCommit?: string | null };
  links?: { self?: Array<{ href?: string }> };
}

export async function validateBitbucketRepositoryAccess(
  access: BitbucketDataCenterRepositoryAccess,
  repositoryUrl: string
) {
  const apiBaseUrl = resolveBitbucketApiBaseUrl(access.apiBaseUrl);
  const identity = resolveBitbucketRepositoryIdentity(repositoryUrl);
  const response = await fetch(repositoryEndpoint(apiBaseUrl, identity), {
    headers: bitbucketHeaders(access),
  });

  if (!response.ok) {
    throw new Error(
      `Bitbucket Data Center repository access validation failed with ${
        response.status
      } ${response.statusText}: ${await readError(response)}`
    );
  }

  const repository = (await response.json()) as BitbucketRepositoryResponse;
  if (repository.archived || repository.state === 'ARCHIVED') {
    throw new Error(
      'Bitbucket Data Center repository is archived and cannot accept changes.'
    );
  }
  if (repository.state && repository.state !== 'AVAILABLE') {
    throw new Error(
      `Bitbucket Data Center repository is not available (state: ${repository.state}).`
    );
  }

  return { repositoryId: identity.id, ...identity };
}

export async function createBitbucketPullRequest(
  access: BitbucketDataCenterRepositoryAccess,
  repositoryId: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description?: string
) {
  const apiBaseUrl = resolveBitbucketApiBaseUrl(access.apiBaseUrl);
  const identity = parseRepositoryId(repositoryId);
  const endpoint = `${repositoryEndpoint(apiBaseUrl, identity)}/pull-requests`;
  const repository = {
    slug: identity.repositorySlug,
    project: { key: identity.projectKey },
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...bitbucketHeaders(access),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description,
      fromRef: { id: `refs/heads/${sourceBranch}`, repository },
      toRef: { id: `refs/heads/${targetBranch}`, repository },
    }),
  });

  if (response.ok) {
    return normalizePullRequest(
      (await response.json()) as BitbucketPullRequestResponse
    );
  }

  if (response.status === 409) {
    const existing = await findOpenPullRequest(
      endpoint,
      access,
      sourceBranch,
      targetBranch
    );
    if (existing) return normalizePullRequest(existing);
  }

  throw new Error(
    `Bitbucket Data Center pull request creation failed with ${
      response.status
    } ${response.statusText}: ${await readError(response)}`
  );
}

export async function getBitbucketPullRequestDetails(
  access: BitbucketDataCenterRepositoryAccess,
  repositoryId: string,
  mergeRequestUrl: string
) {
  const apiBaseUrl = resolveBitbucketApiBaseUrl(access.apiBaseUrl);
  const identity = parseRepositoryId(repositoryId);
  const pullRequestId = resolveBitbucketPullRequestId(access, mergeRequestUrl);
  const endpoint = `${repositoryEndpoint(
    apiBaseUrl,
    identity
  )}/pull-requests/${pullRequestId}`;
  const response = await fetch(endpoint, { headers: bitbucketHeaders(access) });
  if (!response.ok) {
    throw new Error(
      `Bitbucket Data Center pull request lookup failed with ${
        response.status
      } ${response.statusText}: ${await readError(response)}`
    );
  }
  const pullRequest = (await response.json()) as BitbucketPullRequestResponse;
  const sourceBranch = normalizeBranchRef(pullRequest.fromRef?.id);
  const targetBranch = normalizeBranchRef(pullRequest.toRef?.id);
  if (!sourceBranch || !targetBranch) {
    throw new Error(
      'Bitbucket Data Center pull request response did not include source and target branches.'
    );
  }
  return {
    id: pullRequest.id ?? pullRequestId,
    url: resolvePullRequestUrl(pullRequest) ?? mergeRequestUrl,
    state: pullRequest.state?.toLowerCase() ?? 'open',
    title: pullRequest.title ?? '',
    sourceBranch,
    targetBranch,
    sourceHeadSha: pullRequest.fromRef?.latestCommit ?? null,
    targetHeadSha: pullRequest.toRef?.latestCommit ?? null,
    version: pullRequest.version ?? null,
    detailedStatus: null,
    rebaseInProgress: false,
    rebaseError: null,
  };
}

export async function requestBitbucketPullRequestRebase(
  access: BitbucketDataCenterRepositoryAccess,
  repositoryId: string,
  mergeRequestUrl: string
) {
  const details = await getBitbucketPullRequestDetails(
    access,
    repositoryId,
    mergeRequestUrl
  );
  if (details.version === null) {
    return {
      requested: false as const,
      reason: 'Bitbucket Data Center pull request did not include a version.',
    };
  }
  const apiBaseUrl = resolveBitbucketApiBaseUrl(access.apiBaseUrl);
  const identity = parseRepositoryId(repositoryId);
  const gitApiBaseUrl = apiBaseUrl.replace(
    /\/rest\/api\/(?:latest|1\.0)$/,
    '/rest/git/latest'
  );
  const endpoint = `${repositoryEndpoint(
    gitApiBaseUrl,
    identity
  )}/pull-requests/${details.id}/rebase`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...bitbucketHeaders(access),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version: details.version }),
  });
  if (!response.ok) {
    return {
      requested: false as const,
      reason: `Bitbucket Data Center pull request rebase failed with ${
        response.status
      } ${response.statusText}: ${await readError(response)}`,
    };
  }
  return { requested: true as const, inProgress: false };
}

function resolveBitbucketRepositoryIdentity(repositoryUrl: string) {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error(
      `Invalid Bitbucket Data Center repository URL "${repositoryUrl}".`
    );
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
      'Bitbucket Data Center repositories using HTTP access tokens must use HTTPS.'
    );
  }

  const match = /\/scm\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    decodeURIComponent(url.pathname)
  );
  if (!match) {
    throw new Error(
      `Bitbucket Data Center repository URL "${repositoryUrl}" must use /scm/{projectKey}/{repositorySlug}.git.`
    );
  }

  const projectKey = match[1];
  const repositorySlug = match[2];
  return {
    id: `${projectKey}/${repositorySlug}`,
    projectKey,
    repositorySlug,
  };
}

function parseRepositoryId(repositoryId: string) {
  const separator = repositoryId.indexOf('/');
  if (separator <= 0 || separator === repositoryId.length - 1) {
    throw new Error(
      `Invalid Bitbucket Data Center repository identity "${repositoryId}".`
    );
  }
  return {
    id: repositoryId,
    projectKey: repositoryId.slice(0, separator),
    repositorySlug: repositoryId.slice(separator + 1),
  };
}

function repositoryEndpoint(
  apiBaseUrl: string,
  identity: { projectKey: string; repositorySlug: string }
) {
  return `${apiBaseUrl}/projects/${encodeURIComponent(
    identity.projectKey
  )}/repos/${encodeURIComponent(identity.repositorySlug)}`;
}

function bitbucketHeaders(access: BitbucketDataCenterRepositoryAccess) {
  const authorization = Buffer.from(
    `${access.username}:${access.token}`,
    'utf8'
  ).toString('base64');
  return {
    Accept: 'application/json',
    Authorization: `Basic ${authorization}`,
  };
}

async function findOpenPullRequest(
  endpoint: string,
  access: BitbucketDataCenterRepositoryAccess,
  sourceBranch: string,
  targetBranch: string
) {
  const url = new URL(endpoint);
  url.searchParams.set('state', 'OPEN');
  url.searchParams.set('at', `refs/heads/${targetBranch}`);
  while (true) {
    const response = await fetch(url, { headers: bitbucketHeaders(access) });
    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      values?: BitbucketPullRequestResponse[];
      isLastPage?: boolean;
      nextPageStart?: number;
    };
    const pullRequest = body.values?.find(
      (candidate) =>
        candidate.fromRef?.id === `refs/heads/${sourceBranch}` &&
        candidate.toRef?.id === `refs/heads/${targetBranch}`
    );
    if (pullRequest) return pullRequest;
    if (body.isLastPage !== false || body.nextPageStart === undefined) {
      return undefined;
    }
    url.searchParams.set('start', String(body.nextPageStart));
  }
}

function resolveBitbucketPullRequestId(
  access: BitbucketDataCenterRepositoryAccess,
  mergeRequestUrl: string
) {
  let url: URL;
  try {
    url = new URL(mergeRequestUrl);
  } catch {
    throw new Error(
      `Invalid Bitbucket Data Center pull request URL "${mergeRequestUrl}".`
    );
  }
  if (url.username || url.password) {
    throw new Error(
      'Bitbucket Data Center pull request URLs must not contain credentials.'
    );
  }
  const credentialHost = new URL(
    access.host.includes('://') ? access.host : `https://${access.host}`
  ).host;
  if (url.host.toLowerCase() !== credentialHost.toLowerCase()) {
    throw new Error(
      `Bitbucket Data Center pull request host "${url.host}" does not match credential host "${access.host}".`
    );
  }
  const match = /\/pull-requests\/(\d+)(?:\/|$)/i.exec(url.pathname);
  if (!match) {
    throw new Error(
      `Bitbucket Data Center pull request URL "${mergeRequestUrl}" does not include a numeric pull request ID.`
    );
  }
  return Number(match[1]);
}

function normalizeBranchRef(ref?: string) {
  return ref?.replace(/^refs\/heads\//, '') || null;
}

function resolvePullRequestUrl(response: BitbucketPullRequestResponse) {
  return response.links?.self?.find((link) => link.href)?.href;
}
function normalizePullRequest(response: BitbucketPullRequestResponse) {
  const url = resolvePullRequestUrl(response);
  if (!url) {
    throw new Error(
      'Bitbucket Data Center pull request response did not include a self link.'
    );
  }
  return {
    id: response.id,
    url,
    state: response.state?.toLowerCase() ?? 'open',
    title: response.title ?? '',
  };
}

function resolveBitbucketApiBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Bitbucket Data Center API base URL "${value}".`);
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
      'Bitbucket Data Center API URLs must use HTTPS. Loopback HTTP requires OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS=true.'
    );
  }
  if (url.username || url.password) {
    throw new Error(
      'Bitbucket Data Center API URLs must not contain embedded credentials.'
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    return (
      body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join('; ') ||
      body.message ||
      JSON.stringify(body)
    );
  } catch {
    return response.statusText;
  }
}
