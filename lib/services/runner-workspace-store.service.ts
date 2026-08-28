import fs from 'node:fs/promises';
import path from 'node:path';

import { RunnerWorkspaceState } from '../interface.js';
import { getRepositoryPaths } from './git.service.js';

const RUNNER_ROOT = path.join('.omniboard', 'mcp');
const RUNNER_WORKSPACES_DIRECTORY = 'workspaces';
const RUNNER_GITIGNORE_ENTRIES = ['workspaces/'];

export async function ensureRunnerLayout() {
  const omniboardRoot = await ensureCanonicalDirectory(
    path.resolve(process.cwd(), path.dirname(RUNNER_ROOT))
  );
  const root = await ensureCanonicalDirectory(
    path.join(omniboardRoot, path.basename(RUNNER_ROOT))
  );
  const workspaces = await ensureCanonicalDirectory(
    path.join(root, RUNNER_WORKSPACES_DIRECTORY)
  );
  await ensureRunnerGitignore(path.join(root, '.gitignore'));
  return { root, workspaces };
}

export function runnerWorkspacePath(
  workspaces: string,
  projectName: string,
  executionKey: string,
  generation: number
) {
  const suffix = executionKey.replace(/-/g, '').slice(0, 12);
  return path.join(workspaces, `${slug(projectName)}-${suffix}-g${generation}`);
}

export async function runnerWorkspaceExists(localPath: string) {
  try {
    const stats = await fs.lstat(localPath);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function removeRunnerWorkspaceNodeModules(localPath: string) {
  const layout = await ensureRunnerLayout();
  if (!(await runnerWorkspaceExists(localPath))) return;

  const canonicalLocalPath = await assertRunnerWorkspacePath(
    layout.workspaces,
    localPath
  );
  await fs.rm(path.join(canonicalLocalPath, 'node_modules'), {
    recursive: true,
    force: true,
  });
}

export async function assertRunnerWorkspacePath(
  workspaces: string,
  localPath: string
) {
  if (path.dirname(path.resolve(localPath)) !== path.resolve(workspaces)) {
    throw new Error(
      `Runner workspace "${localPath}" is outside "${workspaces}".`
    );
  }

  const stats = await fs.lstat(localPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Runner workspace "${localPath}" must not be a symlink.`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Runner workspace "${localPath}" is not a directory.`);
  }

  const canonicalLocalPath = await fs.realpath(localPath);
  if (path.dirname(canonicalLocalPath) !== (await fs.realpath(workspaces))) {
    throw new Error(
      `Runner workspace "${localPath}" resolves outside "${workspaces}".`
    );
  }
  return canonicalLocalPath;
}

export function assertWorkspaceIdentity(
  state: RunnerWorkspaceState,
  runKey: string,
  projectName: string,
  localPath: string
) {
  if (
    state.runKey !== runKey ||
    state.projectName !== projectName ||
    path.resolve(state.localPath) !== path.resolve(localPath)
  ) {
    throw new Error('Runner workspace identity does not match the request.');
  }
}

export async function assertGitWorkspaceIdentity(localPath: string) {
  const canonicalWorkspace = await fs.realpath(localPath);
  const repositoryPaths = await getRepositoryPaths(canonicalWorkspace);
  const topLevel = await fs.realpath(repositoryPaths.topLevel);
  if (topLevel !== canonicalWorkspace) {
    throw new Error(
      `Git worktree "${topLevel}" is outside runner workspace "${canonicalWorkspace}".`
    );
  }

  for (const [label, repositoryPath] of [
    ['Git directory', repositoryPaths.gitDirectory],
    ['Git common directory', repositoryPaths.commonDirectory],
  ] as const) {
    const canonicalRepositoryPath = await fs.realpath(repositoryPath);
    if (!isPathInside(canonicalWorkspace, canonicalRepositoryPath)) {
      throw new Error(
        `${label} "${canonicalRepositoryPath}" is outside runner workspace "${canonicalWorkspace}".`
      );
    }
  }
}

async function ensureCanonicalDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  await assertRealDirectory(directory);
  const canonicalDirectory = await fs.realpath(directory);
  if (canonicalDirectory !== path.resolve(directory)) {
    throw new Error(
      `Runner directory "${directory}" must not resolve through a symlink.`
    );
  }
  return canonicalDirectory;
}

function isPathInside(parent: string, candidate: string) {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}

async function assertRealDirectory(directory: string) {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Runner directory "${directory}" must be a real directory.`
    );
  }
}

async function ensureRunnerGitignore(gitignorePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.writeFile(
        gitignorePath,
        `${RUNNER_GITIGNORE_ENTRIES.join('\n')}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      return;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw writeError;
      }
      return ensureRunnerGitignore(gitignorePath);
    }
  }

  const existingEntries = new Set(
    content.split(/\r?\n/).map((entry) => entry.trim())
  );
  const missingEntries = RUNNER_GITIGNORE_ENTRIES.filter(
    (entry) => !existingEntries.has(entry)
  );
  if (!missingEntries.length) return;

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = !content || content.endsWith('\n') ? '' : newline;
  await fs.writeFile(
    gitignorePath,
    `${content}${separator}${missingEntries.join(newline)}${newline}`,
    'utf8'
  );
}

function slug(value: string) {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return result || 'run';
}
