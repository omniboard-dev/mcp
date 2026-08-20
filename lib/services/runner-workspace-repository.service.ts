import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepositoryAccess } from '../interface.js';
import { getGitNetworkEnvironment } from './git.service.js';
import { resolveGitUsername } from './source-control.service.js';
import {
  isLocalTransportAllowed,
  isLoopbackHostname,
} from './url-security.service.js';

export async function withGitCredentials<T>(
  access: RepositoryAccess,
  targetDir: string,
  action: (env: NodeJS.ProcessEnv) => Promise<T>
) {
  const askPassDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'omniboard-git-')
  );
  const askPassPath = path.join(
    askPassDirectory,
    process.platform === 'win32'
      ? 'omniboard-askpass.cmd'
      : 'omniboard-askpass.sh'
  );
  const username = resolveGitUsername(access);
  const script =
    process.platform === 'win32'
      ? [
          '@echo off',
          'echo %~1 | findstr /I "Username" >nul',
          'if %errorlevel%==0 (echo %OMNIBOARD_GIT_USERNAME%) else (echo %OMNIBOARD_GIT_TOKEN%)',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          'case "$1" in',
          '  *Username*) printf "%s\\n" "$OMNIBOARD_GIT_USERNAME" ;;',
          '  *) printf "%s\\n" "$OMNIBOARD_GIT_TOKEN" ;;',
          'esac',
          '',
        ].join('\n');

  await fs.writeFile(askPassPath, script, { mode: 0o700 });
  try {
    return await action({
      ...getGitNetworkEnvironment(),
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0',
      OMNIBOARD_GIT_TOKEN: access.token,
      OMNIBOARD_GIT_USERNAME: username,
    });
  } finally {
    await fs.rm(askPassDirectory, { recursive: true, force: true });
  }
}

export function resolveProjectRepositoryUrl(
  project: {
    repositoryUrl?: string | null;
    repositoryUrls?: string[];
  },
  requestedRepositoryUrl?: string
) {
  const availableRepositoryUrls = [
    project.repositoryUrl,
    ...(project.repositoryUrls ?? []),
  ].filter((value): value is string => Boolean(value));

  if (!availableRepositoryUrls.length) {
    throw new Error('The matched project does not expose a repository URL.');
  }
  if (!requestedRepositoryUrl) {
    const preferredRepositoryUrl = findPreferredRepositoryUrl(
      availableRepositoryUrls
    );
    if (!preferredRepositoryUrl) {
      throw new Error(
        'The matched project does not expose a secure HTTPS repository URL compatible with token authentication.'
      );
    }
    return preferredRepositoryUrl;
  }

  const requestedIdentity = repositoryIdentity(requestedRepositoryUrl);
  const matchingRepositoryUrls = availableRepositoryUrls.filter(
    (value) => repositoryIdentity(value) === requestedIdentity
  );
  const matchedRepositoryUrl =
    matchingRepositoryUrls.find(
      (value) =>
        value === requestedRepositoryUrl && isSecureRepositoryUrl(value)
    ) ?? findPreferredRepositoryUrl(matchingRepositoryUrls);
  if (!matchedRepositoryUrl) {
    throw new Error(
      matchingRepositoryUrls.length
        ? 'The requested repository does not expose a secure URL compatible with token authentication.'
        : 'The requested repository URL is not registered on the matched Omniboard project.'
    );
  }
  return matchedRepositoryUrl;
}

function findPreferredRepositoryUrl(repositoryUrls: string[]) {
  const httpsRepositoryUrl = repositoryUrls.find(
    (value) => repositoryProtocol(value) === 'https:'
  );
  if (httpsRepositoryUrl || !isLocalTransportAllowed()) {
    return httpsRepositoryUrl;
  }
  return (
    repositoryUrls.find(
      (value) =>
        repositoryProtocol(value) === 'http:' &&
        isLoopbackHostname(parseRepositoryUrl(value).hostname)
    ) ?? repositoryUrls.find((value) => repositoryProtocol(value) === 'file:')
  );
}

function isSecureRepositoryUrl(repositoryUrl: string) {
  const protocol = repositoryProtocol(repositoryUrl);
  return (
    protocol === 'https:' ||
    (isLocalTransportAllowed() &&
      (protocol === 'file:' ||
        (protocol === 'http:' &&
          isLoopbackHostname(parseRepositoryUrl(repositoryUrl).hostname))))
  );
}

export function assertAuthorizedRepositoryUrl(
  access: RepositoryAccess,
  repositoryUrl: string,
  effectiveRepositoryUrl: string
) {
  if (
    repositoryIdentity(repositoryUrl) !==
    repositoryIdentity(effectiveRepositoryUrl)
  ) {
    throw new Error(
      'Git configuration rewrites the repository URL to a different repository.'
    );
  }

  const url = parseRepositoryUrl(effectiveRepositoryUrl);
  if (url.protocol === 'file:' && isLocalTransportAllowed()) {
    return;
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
      'Credentialed repository URLs must use HTTPS. Local file and loopback HTTP transports require OMNIBOARD_MCP_CLI_ALLOW_LOCAL_TRANSPORTS=true.'
    );
  }
  if (url.username || url.password) {
    throw new Error('Repository URLs must not contain embedded credentials.');
  }

  const accessHost = normalizeAccessHost(access.host);
  if (url.host.toLowerCase() !== accessHost) {
    throw new Error(
      `Repository host "${url.host}" does not match credential host "${access.host}".`
    );
  }
}

function repositoryProtocol(repositoryUrl: string) {
  try {
    return parseRepositoryUrl(repositoryUrl).protocol;
  } catch {
    return undefined;
  }
}

function parseRepositoryUrl(repositoryUrl: string) {
  if (!repositoryUrl.includes('://')) {
    throw new Error(
      `Repository URL "${repositoryUrl}" must use HTTP(S) for token authentication.`
    );
  }
  try {
    return new URL(repositoryUrl);
  } catch {
    throw new Error(`Invalid repository URL "${repositoryUrl}".`);
  }
}

function normalizeAccessHost(host: string) {
  try {
    return new URL(
      host.includes('://') ? host : `https://${host}`
    ).host.toLowerCase();
  } catch {
    throw new Error(`Invalid repository credential host "${host}".`);
  }
}

export function repositoryIdentity(repositoryUrl: string) {
  if (repositoryUrl.includes('://')) {
    const url = new URL(repositoryUrl);
    return `${url.host.toLowerCase()}/${normalizeRepositoryPath(url.pathname)}`;
  }

  const match = /^(?:[^@]+@)?(?<host>[^:]+):(?<path>.+)$/.exec(
    repositoryUrl
  )?.groups;
  if (!match) {
    throw new Error(`Invalid repository URL "${repositoryUrl}".`);
  }
  return `${match.host.toLowerCase()}/${normalizeRepositoryPath(match.path)}`;
}

function normalizeRepositoryPath(value: string) {
  return value
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}
