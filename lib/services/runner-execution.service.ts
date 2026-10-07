import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  RepositoryAccess,
  RunnerExecution,
  RunnerWorkspaceState,
} from '../interface.js';
import {
  getCurrentBranch,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getStashEntry,
  isRebaseInProgress,
} from './git.service.js';
import { repositoryIdentity } from './runner-workspace-repository.service.js';
import {
  assertGitWorkspaceIdentity,
  assertRunnerWorkspacePath,
  ensureRunnerLayout,
  runnerWorkspaceExists,
  runnerWorkspacePath,
} from './runner-workspace-store.service.js';

// Local Git context only. No API execution records, leases, timers, or transition
// validation. Git/provider facts are refreshed by prepare/finalize on every call.
const contexts = new Map<
  string,
  { execution: RunnerExecution; localPath?: string }
>();
const identity = (runKey: string, projectName: string) =>
  JSON.stringify([runKey, projectName]);
const metadataPath = (localPath: string) =>
  path.join(localPath, '.git', 'omniboard-runner.json');

export interface AcquireRunnerExecutionInput {
  runKey: string;
  projectName: string;
  repositoryUrl: string;
  sourceControlProvider: RepositoryAccess['provider'];
  sourceControlRepositoryId: string;
  branch: string;
  commitMessage?: string;
}

export async function acquireRunnerExecution(
  input: AcquireRunnerExecutionInput,
  requestedLocalPath?: string
) {
  const key = identity(input.runKey, input.projectName);
  const executionKey = createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 32);
  const layout = await ensureRunnerLayout();
  let localPath = runnerWorkspacePath(
    layout.workspaces,
    input.projectName,
    executionKey,
    1
  );
  const retainedPath = contexts.get(key)?.localPath;
  if (requestedLocalPath ?? retainedPath)
    localPath = path.resolve((requestedLocalPath ?? retainedPath)!);
  let saved: Partial<RunnerExecution> = {};
  let exists = await runnerWorkspaceExists(localPath);
  if (exists) {
    localPath = await assertRunnerWorkspacePath(layout.workspaces, localPath);
    let compatible = false;
    try {
      await assertGitWorkspaceIdentity(localPath);
      saved = JSON.parse(await fs.readFile(metadataPath(localPath), 'utf8'));
      compatible =
        saved?.runKey === input.runKey &&
        saved.projectName === input.projectName &&
        saved.branch === input.branch &&
        saved.sourceControlProvider === input.sourceControlProvider &&
        saved.sourceControlRepositoryId === input.sourceControlRepositoryId &&
        repositoryIdentity(saved.repositoryUrl!) ===
          repositoryIdentity(input.repositoryUrl) &&
        repositoryIdentity(
          await getEffectiveRepositoryUrl('origin', localPath)
        ) === repositoryIdentity(input.repositoryUrl) &&
        ((await isRebaseInProgress(localPath))
          ? Boolean(saved.recovery)
          : (await getCurrentBranch(localPath)) === input.branch) &&
        (!saved.recovery?.stashRef ||
          saved.recovery.stashApplied === true ||
          Boolean(await getStashEntry(saved.recovery.stashRef, localPath)));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        throw error;
    }
    if (!compatible) {
      await fs.rm(localPath, { recursive: true, force: true });
      saved = {};
      exists = false;
    }
  } else if (path.dirname(localPath) !== layout.workspaces) {
    throw new Error('Runner workspace is outside ' + layout.workspaces);
  }
  const execution: RunnerExecution = {
    executionKey,
    generation: 1,
    stateVersion: 1,
    phase: exists ? 'prepared' : 'preparing',
    checkName: '',
    targetBranch: null,
    preparedHeadSha: exists ? (await getHeadCommit(localPath)).sha : null,
    commitSha: null,
    recovery: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    completedAt: null,
    cleanupAfter: null,
    creationDate: null,
    updateDate: null,
    ...saved,
    ...input,
    commitMessage: input.commitMessage ?? saved.commitMessage ?? null,
  };
  contexts.set(key, { execution, localPath });
  return execution;
}

export function runnerExecutionLocalPath(execution: RunnerExecution) {
  return contexts.get(identity(execution.runKey, execution.projectName))
    ?.localPath;
}

export async function checkpointRunnerExecution(
  execution: RunnerExecution,
  patch: Partial<RunnerExecution>
) {
  Object.assign(execution, patch);
  const context = contexts.get(
    identity(execution.runKey, execution.projectName)
  );
  if (context?.localPath && (await runnerWorkspaceExists(context.localPath))) {
    await assertGitWorkspaceIdentity(context.localPath);
    // Atomic local replacement preserves stash/source refs over a process restart.
    // This is not a workflow checkpoint and has no remote phase prerequisites.
    const file = metadataPath(context.localPath);
    await fs.writeFile(file + '.tmp', JSON.stringify(execution) + '\n', {
      mode: 0o600,
    });
    await fs.rename(file + '.tmp', file);
  }
  return execution;
}

export async function registerRunnerWorkspace(
  executionKey: string,
  localPath: string
) {
  const context = [...contexts.values()].find(
    (item) => item.execution.executionKey === executionKey
  );
  if (context) context.localPath = localPath;
}

export async function writeRunnerState(
  state: RunnerWorkspaceState,
  phase = state.recovery?.phase === 'conflicts'
    ? 'recovery_conflicts'
    : state.recovery?.phase === 'ready_to_push'
    ? 'recovery_ready_to_push'
    : state.commitSha
    ? 'committed'
    : 'prepared'
) {
  const context = contexts.get(identity(state.runKey, state.projectName));
  if (!context) throw new Error('Prepare this checkout before publishing it.');
  const execution = await checkpointRunnerExecution(context.execution, {
    phase: phase as RunnerExecution['phase'],
    targetBranch: state.targetBranch,
    preparedHeadSha: state.preparedHeadSha,
    commitSha: state.commitSha ?? null,
    commitMessage: state.commitMessage ?? null,
    recovery: state.recovery ?? null,
  });
  state.phase = execution.phase;
}

export function createRunnerWorkspaceState(
  execution: RunnerExecution,
  localPath: string,
  access: RepositoryAccess
): RunnerWorkspaceState {
  return {
    executionKey: execution.executionKey,
    generation: execution.generation,
    stateVersion: execution.stateVersion,
    phase: execution.phase,
    runKey: execution.runKey,
    checkName: execution.checkName,
    projectName: execution.projectName,
    repositoryUrl: execution.repositoryUrl,
    localPath,
    branch: execution.branch,
    commitMessage: execution.commitMessage ?? undefined,
    targetBranch: execution.targetBranch ?? 'main',
    projectPath: execution.sourceControlRepositoryId,
    preparedHeadSha: execution.preparedHeadSha ?? '',
    commitSha: execution.commitSha ?? undefined,
    provider: access.provider,
    apiBaseUrl: access.apiBaseUrl,
    recovery: execution.recovery ?? undefined,
  };
}

export function getActiveRunnerExecution(runKey: string, projectName: string) {
  return contexts.get(identity(runKey, projectName))?.execution;
}

// Compatibility for older callers. Stopping never deletes dependencies or edits.
export async function releaseRunnerExecution(_executionKey: string) {}
export async function releaseAllRunnerExecutions() {
  contexts.clear();
}
export async function releaseRunnerExecutionByIdentity(
  runKey: string,
  projectName: string
) {
  contexts.delete(identity(runKey, projectName));
  return { runKey, projectName, executionKey: null, released: false };
}
export async function completeRunnerExecutionByIdentity(
  runKey: string,
  projectName: string,
  _phase: string
) {
  contexts.delete(identity(runKey, projectName));
  return { completed: true, execution: null };
}
export async function completeRunnerState(
  state: RunnerWorkspaceState,
  _phase?: string
) {
  return completeRunnerExecutionByIdentity(
    state.runKey,
    state.projectName,
    'completed'
  );
}
export async function reinitializeRunnerExecution(execution: RunnerExecution) {
  return execution;
}
export function heartbeatRunnerExecution(runKey: string, projectName: string) {
  return {
    runKey,
    projectName,
    executionKey: '',
    heartbeatAt: new Date().toISOString(),
    workStaleAfter: '',
    executionBudgetEndsAt: '',
    required: false,
  };
}
