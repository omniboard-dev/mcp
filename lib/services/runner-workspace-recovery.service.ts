import {
  RepositoryAccess,
  RunnerWorkspaceState,
  RunnerWorkspaceFinalizeResult,
  AgenticRunProgressReportResult,
} from '../interface.js';
import * as api from './api.service.js';
import {
  applyStash,
  continueRebase,
  dropStash,
  fetchBranch,
  fetchBranchIfExists,
  getConflictedFiles,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getRemoteBranchCommit,
  getStashEntry,
  getWorkingTreeStatus,
  isAncestor,
  isRebaseInProgress,
  stashWorkingTree,
  startRebase,
} from './git.service.js';
import { writeRunnerState } from './runner-execution.service.js';
import { assertCurrentRunnerBranch } from './runner-workspace-git.service.js';
import {
  assertAuthorizedRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import { assertGitWorkspaceIdentity } from './runner-workspace-store.service.js';

// The same Git loop handles fresh migrations, retained edits and conflict repair.
// Recovery data contains only the source SHA and stash needed to preserve work.
export async function prepareRunnerTargetSynchronization(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: RepositoryAccess,
  mergeRequestUrl?: string | null,
  _checkpointCurrentTarget = false
) {
  const previousSource =
    state.recovery?.sourceHeadSha ??
    (await getRemoteBranchCommit(state.branch, localPath));
  let source: string | null = null;
  await withGitCredentials(access, localPath, async (env) => {
    source = await fetchBranchIfExists(
      repositoryUrl,
      state.branch,
      localPath,
      env
    );
    await fetchBranch(repositoryUrl, state.targetBranch, localPath, env);
  });
  const target = await getRemoteBranchCommit(state.targetBranch, localPath);
  if (!target)
    throw new Error('Target branch does not exist: ' + state.targetBranch);
  state.recovery ??= {
    kind: 'target_sync',
    phase: 'in_progress',
    sourceBranch: state.branch,
    targetBranch: state.targetBranch,
    sourceHeadSha: previousSource ?? undefined,
    targetHeadSha: target,
    mergeRequestUrl,
    attempt: 1,
    conflictFiles: [],
  };
  state.recovery.mergeRequestUrl =
    mergeRequestUrl ?? state.recovery.mergeRequestUrl;
  state.recovery.targetBranch = state.targetBranch;
  if (
    (await isRebaseInProgress(localPath)) ||
    (await getConflictedFiles(localPath)).length
  ) {
    await recordConflicts(state);
    return;
  }
  await assertCurrentRunnerBranch(state, localPath);
  if (!(await restoreWork(state))) return;
  let head = (await getHeadCommit(localPath)).sha;
  const integrateSource =
    !!source &&
    source !== head &&
    !(await isAncestor(source, head, localPath)) &&
    (source !== previousSource || !state.recovery.sourceHeadSha);
  const rebaseTarget = !(await isAncestor(target, head, localPath));
  if (integrateSource || rebaseTarget) {
    if (await getWorkingTreeStatus(localPath))
      state.recovery.stashRef = await stashWorkingTree(localPath);
    state.recovery.sourceHeadSha = source ?? undefined;
    state.recovery.targetHeadSha = target;
    state.recovery.phase = 'in_progress';
    await writeRunnerState(state);
    for (const branch of [
      ...(integrateSource ? [state.branch] : []),
      state.targetBranch,
    ]) {
      const ref = await getRemoteBranchCommit(branch, localPath);
      head = (await getHeadCommit(localPath)).sha;
      if (!ref || (await isAncestor(ref, head, localPath))) continue;
      try {
        await startRebase(branch, localPath);
      } catch (error) {
        if (
          !(await isRebaseInProgress(localPath)) &&
          !(await getConflictedFiles(localPath)).length
        )
          throw error;
        await recordConflicts(state);
        return;
      }
    }
    if (!(await restoreWork(state))) return;
  }
  state.preparedHeadSha = (await getHeadCommit(localPath)).sha;
  state.commitSha = undefined;
  state.recovery.sourceHeadSha = source ?? undefined;
  state.recovery.targetHeadSha = target;
  state.recovery.phase = 'ready_to_push';
  state.recovery.conflictFiles = [];
  await writeRunnerState(state);
}

async function restoreWork(state: RunnerWorkspaceState) {
  const recovery = state.recovery!;
  if (!recovery.stashRef) return true;
  const stash = await getStashEntry(recovery.stashRef, state.localPath);
  if (!recovery.stashApplied) {
    if (!stash)
      throw new Error(
        'Preserved migration changes are missing from Git stash: ' +
          recovery.stashRef
      );
    try {
      await applyStash(stash.commitSha, state.localPath);
    } catch (error) {
      if (!(await getConflictedFiles(state.localPath)).length) throw error;
      recovery.stashApplied = true;
      await recordConflicts(state);
      return false;
    }
    recovery.stashApplied = true;
    await writeRunnerState(state);
  }
  if (stash) await dropStash(stash.commitSha, state.localPath);
  delete recovery.stashRef;
  delete recovery.stashApplied;
  await writeRunnerState(state);
  return true;
}

async function recordConflicts(state: RunnerWorkspaceState) {
  state.recovery!.phase = 'conflicts';
  state.recovery!.conflictFiles = await getConflictedFiles(state.localPath);
  state.preparedHeadSha = (await getHeadCommit(state.localPath)).sha;
  await writeRunnerState(state);
}

export async function finalizeRunnerRebaseRecovery(
  state: RunnerWorkspaceState,
  localPath: string,
  progressReports: AgenticRunProgressReportResult[]
): Promise<RunnerWorkspaceFinalizeResult> {
  if (await isRebaseInProgress(localPath)) {
    try {
      await continueRebase(localPath);
    } catch (error) {
      if (!(await isRebaseInProgress(localPath))) throw error;
      await recordConflicts(state);
      return {
        completed: false,
        workspace: state,
        progressReports,
        conflictFiles: state.recovery!.conflictFiles,
        instructions: createRecoveryWorkspaceInstructions(
          state.runKey,
          state.projectName,
          state
        ),
      };
    }
  }
  const access = await api.getRepositoryAccess(state.repositoryUrl);
  const repositoryUrl = await getEffectiveRepositoryUrl(
    state.repositoryUrl,
    localPath
  );
  assertAuthorizedRepositoryUrl(access, state.repositoryUrl, repositoryUrl);
  await prepareRunnerTargetSynchronization(
    state,
    localPath,
    repositoryUrl,
    access,
    state.recovery?.mergeRequestUrl
  );
  return {
    completed: false,
    workspace: state,
    progressReports,
    conflictFiles: state.recovery?.conflictFiles,
    instructions: createRecoveryWorkspaceInstructions(
      state.runKey,
      state.projectName,
      state
    ),
  };
}

export async function reconcileRunnerRecoveryWorkspace(
  state: RunnerWorkspaceState,
  localPath: string
) {
  await assertGitWorkspaceIdentity(localPath);
  if (
    (await isRebaseInProgress(localPath)) ||
    (await getConflictedFiles(localPath)).length
  )
    await recordConflicts(state);
  else await assertCurrentRunnerBranch(state, localPath);
}
export function createRecoveryProgressMetadata(
  recovery: NonNullable<RunnerWorkspaceState['recovery']>
) {
  return { remediation: 'target_sync', conflictFiles: recovery.conflictFiles };
}
export function formatRecoveryProgressNote(state: RunnerWorkspaceState) {
  return state.recovery?.conflictFiles.length
    ? 'Resolve conflicts: ' + state.recovery.conflictFiles.join(', ')
    : 'Migration synchronized with target branch.';
}
export function createRecoveryWorkspaceInstructions(
  _runKey: string,
  _projectName: string,
  state: RunnerWorkspaceState
) {
  return state.recovery?.phase === 'conflicts'
    ? [
        'Resolve and stage conflicts in ' +
          state.localPath +
          '. Finalize to continue the rebase; rerun relevant checks on the resulting content.',
      ]
    : ['Run relevant project checks and finalize to publish this migration.'];
}
