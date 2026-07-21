import path from 'node:path';

import { runFile } from './shell.service.js';

const GIT_BASE_ENVIRONMENT_VARIABLES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_CONFIG_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
] as const;

const GIT_NETWORK_ENVIRONMENT_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

export function getGitNetworkEnvironment(): NodeJS.ProcessEnv {
  return selectProcessEnvironment(GIT_NETWORK_ENVIRONMENT_VARIABLES);
}

export async function getCurrentBranch(
  targetDir: string = '.'
): Promise<string> {
  try {
    const { stdout } = await runGit(['branch', '--show-current'], targetDir);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function cloneRepository(
  repositoryUrl: string,
  localPath: string,
  targetDir: string,
  env: NodeJS.ProcessEnv
) {
  await runGit(
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      'clone',
      '--origin',
      'origin',
      '--',
      repositoryUrl,
      localPath,
    ],
    targetDir,
    env
  );
}

export async function getEffectiveRepositoryUrl(
  repositoryUrl: string,
  targetDir: string
) {
  const { stdout } = await runGit(
    ['ls-remote', '--get-url', repositoryUrl],
    targetDir
  );
  return stdout.trim();
}

export async function getRepositoryPaths(targetDir: string) {
  const [topLevel, gitDirectory, commonDirectory] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel'], targetDir),
    runGit(['rev-parse', '--absolute-git-dir'], targetDir),
    runGit(['rev-parse', '--git-common-dir'], targetDir),
  ]);

  return {
    topLevel: topLevel.stdout.trim(),
    gitDirectory: gitDirectory.stdout.trim(),
    commonDirectory: path.resolve(targetDir, commonDirectory.stdout.trim()),
  };
}

export async function getDefaultBranch(targetDir: string) {
  try {
    const { stdout } = await runGit(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      targetDir
    );
    return stdout.trim().replace(/^origin\//, '');
  } catch {
    const currentBranch = await getCurrentBranch(targetDir);
    return currentBranch || 'main';
  }
}

export async function createBranch(branch: string, targetDir: string) {
  validateBranch(branch);
  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', branch],
    targetDir
  );
}

export async function fetchBranch(
  repositoryUrl: string,
  branch: string,
  targetDir: string,
  env: NodeJS.ProcessEnv
) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      'fetch',
      '--no-tags',
      '--',
      repositoryUrl,
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    targetDir,
    env
  );
}

export async function getRefCommit(
  ref: string,
  targetDir: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', ref], targetDir);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function getRemoteBranchCommit(branch: string, targetDir: string) {
  validateBranch(branch);
  return getRefCommit(`refs/remotes/origin/${branch}`, targetDir);
}

export async function isAncestor(
  ancestor: string,
  descendant: string,
  targetDir: string
) {
  try {
    await runGit(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      targetDir
    );
    return true;
  } catch {
    return false;
  }
}

export async function fastForwardBranch(branch: string, targetDir: string) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--ff-only',
      `refs/remotes/origin/${branch}`,
    ],
    targetDir
  );
}

export async function checkoutRemoteBranch(branch: string, targetDir: string) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '-b',
      branch,
      '--track',
      `origin/${branch}`,
    ],
    targetDir
  );
}

export async function getWorkingTreeStatus(targetDir: string) {
  const { stdout } = await runGit(
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain'],
    targetDir
  );
  return stdout.trim();
}

export async function commitAll(
  message: string,
  targetDir: string,
  authorName: string,
  authorEmail: string
) {
  await runGit(['-c', 'core.fsmonitor=false', 'add', '--all'], targetDir);
  await runGit(
    [
      '-c',
      `user.name=${authorName}`,
      '-c',
      `user.email=${authorEmail}`,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    targetDir
  );
  const { stdout } = await runGit(['rev-parse', 'HEAD'], targetDir);
  return stdout.trim();
}

export async function getHeadCommit(targetDir: string) {
  const { stdout } = await runGit(
    ['log', '-1', '--format=%H%n%P%n%B'],
    targetDir
  );
  const [sha, parents, ...messageLines] = stdout.trim().split('\n');
  return {
    sha,
    parentShas: parents ? parents.split(' ') : [],
    message: messageLines.join('\n').trim(),
  };
}

export async function pushBranch(
  repositoryUrl: string,
  branch: string,
  targetDir: string,
  env: NodeJS.ProcessEnv
) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--no-verify',
      '--',
      repositoryUrl,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    targetDir,
    env
  );
}

function runGit(
  args: string[],
  targetDir: string,
  environmentOverrides: NodeJS.ProcessEnv = {}
) {
  const environment = selectProcessEnvironment(GIT_BASE_ENVIRONMENT_VARIABLES);
  Object.assign(environment, environmentOverrides);
  return runFile('git', args, targetDir, environment);
}

function selectProcessEnvironment(
  variables: readonly string[]
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const variable of variables) {
    const value = process.env[variable];
    if (value !== undefined) {
      environment[variable] = value;
    }
  }
  return environment;
}

function validateBranch(branch: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new Error(`Invalid Git branch name "${branch}".`);
  }
}
