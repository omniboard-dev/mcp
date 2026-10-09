import fs from 'node:fs/promises';
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

const MCP_STARTUP_DIRECTORY = process.cwd();
let mcpStartupGitIdentityPromise: Promise<GitIdentity> | undefined;

export interface GitIdentity {
  name: string;
  email: string;
}

export function getMcpStartupGitIdentity(): Promise<GitIdentity> {
  mcpStartupGitIdentityPromise ??= resolveGitIdentity(MCP_STARTUP_DIRECTORY);
  return mcpStartupGitIdentityPromise;
}

export async function applyGitIdentity(
  identity: GitIdentity,
  targetDir: string
): Promise<void> {
  await runGit(['config', '--local', 'user.name', identity.name], targetDir);
  await runGit(['config', '--local', 'user.email', identity.email], targetDir);
}

async function resolveGitIdentity(targetDir: string): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    readGitConfigValue('user.name', targetDir),
    readGitConfigValue('user.email', targetDir),
  ]);
  if (!name || !email) {
    throw new Error(
      `MCP startup project "${targetDir}" must configure Git user.name and user.email before runner workspaces can be prepared.`
    );
  }
  return { name, email };
}

async function readGitConfigValue(
  key: 'user.name' | 'user.email',
  targetDir: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ['config', '--local', '--get', key],
      targetDir
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

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

export async function createBranchAt(
  branch: string,
  ref: string,
  targetDir: string
) {
  validateBranch(branch);
  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', branch, ref],
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
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    targetDir,
    env
  );
}

export async function fetchBranchIfExists(
  repositoryUrl: string,
  branch: string,
  targetDir: string,
  env: NodeJS.ProcessEnv
) {
  validateBranch(branch);
  const { stdout } = await runGit(
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      'ls-remote',
      '--heads',
      '--',
      repositoryUrl,
      `refs/heads/${branch}`,
    ],
    targetDir,
    env
  );
  if (!stdout.trim()) return null;
  await fetchBranch(repositoryUrl, branch, targetDir, env);
  return getRemoteBranchCommit(branch, targetDir);
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

export async function resetBranchToRemote(branch: string, targetDir: string) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      'reset',
      '--hard',
      `refs/remotes/origin/${branch}`,
    ],
    targetDir
  );
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

export async function startRebase(branch: string, targetDir: string) {
  validateBranch(branch);
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'sequence.editor=true',
      'rebase',
      `refs/remotes/origin/${branch}`,
    ],
    targetDir
  );
}

export async function continueRebase(targetDir: string) {
  await runGit(['-c', 'core.fsmonitor=false', 'add', '--all'], targetDir);
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.editor=true',
      'rebase',
      '--continue',
    ],
    targetDir
  );
}

export async function skipRebase(targetDir: string) {
  await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.editor=true',
      'rebase',
      '--skip',
    ],
    targetDir
  );
}

export async function isRebaseInProgress(targetDir: string) {
  const rebasePaths = await Promise.all(
    ['rebase-merge', 'rebase-apply'].map(async (name) => {
      const { stdout } = await runGit(
        ['rev-parse', '--git-path', name],
        targetDir
      );
      return path.resolve(targetDir, stdout.trim());
    })
  );
  for (const rebasePath of rebasePaths) {
    try {
      await fs.access(rebasePath);
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
  return false;
}

export async function getConflictedFiles(targetDir: string) {
  const { stdout } = await runGit(
    ['diff', '--name-only', '--diff-filter=U'],
    targetDir
  );
  return stdout
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

export async function hasBranchChanges(
  targetBranch: string,
  commitSha: string,
  targetDir: string
) {
  validateBranch(targetBranch);
  const { stdout } = await runGit(
    [
      'diff',
      '--name-only',
      '--no-ext-diff',
      `refs/remotes/origin/${targetBranch}...${commitSha}`,
      '--',
    ],
    targetDir
  );
  return stdout.trim().length > 0;
}

export async function getWorkingTreeStatus(targetDir: string) {
  const { stdout } = await runGit(
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain'],
    targetDir
  );
  return stdout.trimEnd();
}

export async function stashWorkingTree(targetDir: string) {
  await runGit(
    [
      '-c',
      'core.fsmonitor=false',
      'stash',
      'push',
      '--include-untracked',
      '--message',
      'omniboard-runner-target-sync',
    ],
    targetDir
  );
  const stashCommit = await getRefCommit('stash@{0}', targetDir);
  if (!stashCommit) {
    throw new Error(
      'Git created a working-tree stash but its exact commit could not be resolved.'
    );
  }
  return stashCommit;
}

// A successful Git restore and the API checkpoint are separate writes. Retain a
// local receipt until the exact stash is dropped so checkpoint retries are safe.
export async function applyStash(stashRef: string, targetDir: string) {
  const sha = await getRefCommit(stashRef, targetDir);
  if (!sha) throw new Error('The preserved stash cannot be resolved.');
  const receipt = 'refs/omniboard/applied-stashes/' + sha;
  if (await getRefCommit(receipt, targetDir)) return;
  try {
    await applyStashOnce(sha, targetDir);
  } catch (error) {
    if ((await getConflictedFiles(targetDir)).length) {
      await runGit(['update-ref', receipt, sha], targetDir);
    }
    throw error;
  }
  await runGit(['update-ref', receipt, sha], targetDir);
}

async function applyStashOnce(stashRef: string, targetDir: string) {
  try {
    await runGit(
      ['-c', 'core.fsmonitor=false', 'stash', 'apply', '--index', stashRef],
      targetDir,
      { LC_ALL: 'C' }
    );
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('stderr' in error) ||
      !String(error.stderr).includes('conflicts in index. Try without --index.')
    ) {
      throw error;
    }
    // Git could not restore the saved index and has not applied the stash.
    // Use its three-way merge to expose ordinary, resolvable file conflicts.
    await runGit(
      ['-c', 'core.fsmonitor=false', 'stash', 'apply', stashRef],
      targetDir
    );
  }
}

export async function getStashEntry(
  stashRef: string,
  targetDir: string
): Promise<{ commitSha: string; ref: string; message: string } | null> {
  const { stdout } = await runGit(
    ['stash', 'list', '--format=%H%x00%gd%x00%gs'],
    targetDir
  );
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [commitSha, ref, message] = line.split('\0');
    if (commitSha === stashRef || ref === stashRef) {
      return { commitSha, ref, message };
    }
  }
  return null;
}

export async function dropStash(stashCommitSha: string, targetDir: string) {
  const stashEntry = await getStashEntry(stashCommitSha, targetDir);
  if (!stashEntry) {
    throw new Error(
      `The preserved working-tree stash "${stashCommitSha}" is no longer available.`
    );
  }
  await runGit(['stash', 'drop', stashEntry.ref], targetDir);
  await runGit(
    [
      'update-ref',
      '-d',
      'refs/omniboard/applied-stashes/' + stashEntry.commitSha,
    ],
    targetDir
  );
}

export async function commitAll(message: string, targetDir: string) {
  await runGit(['-c', 'core.fsmonitor=false', 'add', '--all'], targetDir);
  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', message],
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

export async function pushBranchWithLease(
  repositoryUrl: string,
  branch: string,
  expectedRemoteCommit: string,
  targetDir: string,
  env: NodeJS.ProcessEnv
) {
  validateBranch(branch);
  validateCommit(expectedRemoteCommit);
  await runGit(
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--no-verify',
      `--force-with-lease=refs/heads/${branch}:${expectedRemoteCommit}`,
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

function validateCommit(commit: string) {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new Error(`Invalid Git commit "${commit}".`);
  }
}
