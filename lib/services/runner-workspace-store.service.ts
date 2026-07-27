import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { RunnerWorkspaceState } from '../interface.js';
import { getRepositoryPaths } from './git.service.js';

const RUNNER_ROOT = path.join('.omniboard', 'mcp');
const RUNNER_WORKSPACES_DIRECTORY = 'workspaces';
const RUNNER_STATE_DIRECTORY = 'state';
const RUNNER_GITIGNORE_ENTRIES = ['workspaces/', 'state/'];
const RUNNER_STATE_VERSION = 2;

interface RunnerWorkspaceStateEnvelope {
  version: typeof RUNNER_STATE_VERSION;
  state: RunnerWorkspaceState;
  signature: string;
}

export async function findRunnerWorkspace(runKey: string, projectName: string) {
  const root = path.resolve(process.cwd(), RUNNER_ROOT);
  const workspaces = path.join(root, RUNNER_WORKSPACES_DIRECTORY);
  const stateDirectory = path.join(root, RUNNER_STATE_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(stateDirectory, { withFileTypes: true });
    await Promise.all([
      assertRealDirectory(root),
      assertRealDirectory(workspaces),
      assertRealDirectory(stateDirectory),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const candidates: Array<{
    state: RunnerWorkspaceState;
    localPath: string;
    modifiedAt: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const stateFile = path.join(stateDirectory, entry.name);
    try {
      const [serialized, stats] = await Promise.all([
        fs.readFile(stateFile, 'utf8'),
        fs.stat(stateFile),
      ]);
      const envelope = JSON.parse(serialized) as unknown;
      assertRunnerStateEnvelope(envelope);
      if (
        envelope.state.runKey !== runKey ||
        envelope.state.projectName !== projectName
      ) {
        continue;
      }
      const localPath = await assertRunnerWorkspacePath(
        workspaces,
        envelope.state.localPath
      );
      candidates.push({
        state: envelope.state,
        localPath,
        modifiedAt: stats.mtimeMs,
      });
    } catch {
      // Invalid, deleted, or unauthenticated state is never reused.
    }
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0] ?? null;
}

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
  const state = await ensureCanonicalDirectory(
    path.join(root, RUNNER_STATE_DIRECTORY)
  );
  await ensureRunnerGitignore(path.join(root, '.gitignore'));
  return { root, workspaces, state };
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

export async function writeRunnerState(state: RunnerWorkspaceState) {
  const layout = await ensureRunnerLayout();
  const envelope: RunnerWorkspaceStateEnvelope = {
    version: RUNNER_STATE_VERSION,
    state,
    signature: signRunnerState(state),
  };
  await writeFileAtomically(
    statePath(layout.state, state.localPath),
    JSON.stringify(envelope, null, 2)
  );
}

export async function readRunnerState(localPath: string) {
  const layout = await ensureRunnerLayout();
  const canonicalLocalPath = await assertRunnerWorkspacePath(
    layout.workspaces,
    localPath
  );
  let content: string;
  try {
    content = await fs.readFile(
      statePath(layout.state, canonicalLocalPath),
      'utf8'
    );
  } catch {
    throw new Error(
      `Runner workspace metadata was not found for "${localPath}".`
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new Error('Runner workspace metadata has an invalid format.');
  }
  assertRunnerStateEnvelope(envelope);
  return { state: envelope.state, localPath: canonicalLocalPath };
}

function assertRunnerStateEnvelope(
  value: unknown
): asserts value is RunnerWorkspaceStateEnvelope {
  const envelope = value as Partial<RunnerWorkspaceStateEnvelope> | null;
  if (
    !envelope ||
    envelope.version !== RUNNER_STATE_VERSION ||
    !envelope.state ||
    typeof envelope.state !== 'object' ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('Runner workspace metadata has an invalid format.');
  }

  const expectedSignature = Buffer.from(signRunnerState(envelope.state), 'hex');
  const actualSignature = Buffer.from(envelope.signature, 'hex');
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error('Runner workspace metadata integrity validation failed.');
  }
}

function signRunnerState(state: RunnerWorkspaceState) {
  const key = process.env.OMNIBOARD_API_KEY_MCP;
  if (!key) {
    throw new Error(
      'OMNIBOARD_API_KEY_MCP is required to authenticate runner workspace metadata.'
    );
  }
  return createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
}

function statePath(stateDirectory: string, localPath: string) {
  return path.join(stateDirectory, `${path.basename(localPath)}.json`);
}

async function writeFileAtomically(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function assertRunnerWorkspacePath(
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
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
  if (!missingEntries.length) {
    return;
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = !content || content.endsWith('\n') ? '' : newline;
  await fs.writeFile(
    gitignorePath,
    `${content}${separator}${missingEntries.join(newline)}${newline}`,
    'utf8'
  );
}
