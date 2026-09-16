import {
  RepositoryAccess,
  RunnerWorkspaceFinalizeResult,
  RunnerWorkspaceRebaseRecovery,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import { reportRunnerAgenticRunProgressSafely } from './agentic-runs.service.js';
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
  skipRebase,
  stashWorkingTree,
  startRebase,
  fastForwardBranch,
} from './git.service.js';
import {
  assertCurrentRunnerBranch,
  RunnerWorkspaceReconciliationError,
} from './runner-workspace-git.service.js';
import {
  assertAuthorizedRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import { writeRunnerState } from './runner-execution.service.js';
import { assertGitWorkspaceIdentity } from './runner-workspace-store.service.js';
import {
  getChangeRequestDetails,
  validateRepositoryAccess,
} from './source-control.service.js';

export async function finalizeRunnerRebaseRecovery(
  state: RunnerWorkspaceState,
  localPath: string,
  progressReports: Awaited<
    ReturnType<typeof reportRunnerAgenticRunProgressSafely>
  >[]
): Promise<RunnerWorkspaceFinalizeResult> {
  await assertGitWorkspaceIdentity(localPath);
  const recovery = state.recovery;
  if (!recovery) {
    throw new Error('Runner workspace rebase recovery state is missing.');
  }
  // Stored legacy rebase checkpoints resume through the same synchronization flow.
  recovery.kind = 'target_sync';
  return finalizeRunnerTargetSynchronization(state, localPath, progressReports);
}

async function finalizeRunnerTargetSynchronization(
  state: RunnerWorkspaceState,
  localPath: string,
  progressReports: Awaited<
    ReturnType<typeof reportRunnerAgenticRunProgressSafely>
  >[]
): Promise<RunnerWorkspaceFinalizeResult> {
  const recovery = state.recovery;
  if (!recovery) {
    throw new Error(
      'Runner workspace target synchronization state is missing.'
    );
  }

  if (await isRebaseInProgress(localPath)) {
    try {
      await continueRebase(localPath);
    } catch (error) {
      const conflictFiles = await getConflictedFiles(localPath);
      if (conflictFiles.length) {
        recovery.phase = 'conflicts';
        recovery.conflictFiles = conflictFiles;
        await writeRunnerState(state);
        return reportRunnerRecoveryConflicts(state, localPath, progressReports);
      }
      if (
        isEmptyRebaseCommitError(error) &&
        (await isRebaseInProgress(localPath))
      ) {
        try {
          await skipRebase(localPath);
        } catch (skipError) {
          const remaining = await getConflictedFiles(localPath);
          if (!remaining.length) throw skipError;
          recovery.phase = 'conflicts';
          recovery.conflictFiles = remaining;
          await writeRunnerState(state);
          return reportRunnerRecoveryConflicts(
            state,
            localPath,
            progressReports
          );
        }
      } else {
        throw error;
      }
    }
  }

  if (await isRebaseInProgress(localPath)) {
    recovery.phase = 'conflicts';
    const remainingConflictFiles = await getConflictedFiles(localPath);
    if (remainingConflictFiles.length) {
      recovery.conflictFiles = remainingConflictFiles;
    }
    await writeRunnerState(state);
    return reportRunnerRecoveryConflicts(state, localPath, progressReports);
  }

  const conflictFiles = await getConflictedFiles(localPath);
  if (conflictFiles.length) {
    recovery.phase = 'conflicts';
    recovery.conflictFiles = conflictFiles;
    await writeRunnerState(state);
    return reportRunnerRecoveryConflicts(state, localPath, progressReports);
  }

  if (recovery.mergeRequestUrl) {
    const access = await api.getRepositoryAccess(state.repositoryUrl);
    const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
      state.repositoryUrl,
      localPath
    );
    assertAuthorizedRepositoryUrl(
      access,
      state.repositoryUrl,
      effectiveRepositoryUrl
    );
    const repository = await validateRepositoryAccess(
      access,
      effectiveRepositoryUrl
    );
    const mergeRequest = await getChangeRequestDetails(
      access,
      repository.repositoryId,
      recovery.mergeRequestUrl
    );
    if (
      mergeRequest.sourceBranch !== recovery.sourceBranch ||
      mergeRequest.targetBranch !== recovery.targetBranch ||
      (recovery.sourceHeadSha &&
        mergeRequest.sourceHeadSha &&
        mergeRequest.sourceHeadSha !== recovery.sourceHeadSha &&
        mergeRequest.sourceHeadSha !== state.commitSha)
    ) {
      const error =
        'The change request changed during target synchronization; no push was attempted.';
      progressReports.push(
        await reportRunnerAgenticRunProgressSafely(
          state.runKey,
          state.projectName,
          {
            status: 'blocked',
            repositoryUrl: state.repositoryUrl,
            branch: state.branch,
            error,
            notes: error,
            metadata: {
              ...createRecoveryProgressMetadata(recovery),
              mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
            },
          }
        )
      );
      return {
        completed: false,
        workspace: state,
        progressReports,
        error,
        instructions: [
          'The checkout and migration edits were preserved. Review the changed request branches before retrying synchronization.',
        ],
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
    recovery.mergeRequestUrl
  );
  if (state.recovery?.phase === 'conflicts') {
    return reportRunnerRecoveryConflicts(state, localPath, progressReports);
  }
  return { completed: false, workspace: state, progressReports };
}

async function reportRunnerRecoveryConflicts(
  state: RunnerWorkspaceState,
  localPath: string,
  progressReports: Awaited<
    ReturnType<typeof reportRunnerAgenticRunProgressSafely>
  >[]
): Promise<RunnerWorkspaceFinalizeResult> {
  const recovery = state.recovery;
  if (!recovery) {
    throw new Error('Runner workspace rebase recovery state is missing.');
  }
  progressReports.push(
    await reportRunnerAgenticRunProgressSafely(
      state.runKey,
      state.projectName,
      {
        status: 'blocked',
        repositoryUrl: state.repositoryUrl,
        branch: state.branch,
        notes: formatRecoveryProgressNote(state),
        metadata: createRecoveryProgressMetadata(recovery),
      }
    )
  );
  return {
    completed: false,
    workspace: state,
    progressReports,
    conflictFiles: recovery.conflictFiles,
    instructions: createRecoveryWorkspaceInstructions(
      state.runKey,
      state.projectName,
      state
    ),
  };
}

export async function prepareRunnerTargetSynchronization(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: RepositoryAccess,
  mergeRequestUrl?: string | null,
  checkpointCurrentTarget = false
) {
  if (state.recovery) state.recovery.kind = 'target_sync';
  if (state.recovery && state.recovery.targetBranch !== state.targetBranch) {
    throw new Error(
      'The change request target changed during synchronization; the checkout and migration edits were preserved.'
    );
  }

  let sourceHeadSha: string | null = null;
  await withGitCredentials(access, localPath, async (env) => {
    sourceHeadSha = await fetchBranchIfExists(
      repositoryUrl,
      state.branch,
      localPath,
      env
    );
    await fetchBranch(repositoryUrl, state.targetBranch, localPath, env);
  });
  const targetHeadSha = await getRemoteBranchCommit(
    state.targetBranch,
    localPath
  );
  if (!targetHeadSha) {
    throw new Error(
      'Unable to resolve configured target branch "' +
        state.targetBranch +
        '" before runner work.'
    );
  }

  // Refresh refs during conflict recovery, but finish the current rebase before
  // starting another one against a newer target.
  if (
    state.recovery &&
    ((await isRebaseInProgress(localPath)) ||
      (await getConflictedFiles(localPath)).length)
  ) {
    state.recovery.phase = 'conflicts';
    state.recovery.conflictFiles = await getConflictedFiles(localPath);
    await writeRunnerState(state);
    return;
  }

  let head = await getHeadCommit(localPath);
  if (
    state.recovery &&
    sourceHeadSha !== (state.recovery.sourceHeadSha ?? null)
  ) {
    if (sourceHeadSha === state.commitSha && head.sha === state.commitSha) {
      // The push may have succeeded before its response/checkpoint was lost.
      state.recovery.sourceHeadSha = sourceHeadSha ?? undefined;
    } else {
      throw new Error(
        'The provider source branch advanced after target synchronization; the checkout and migration edits were preserved and no push was attempted.'
      );
    }
  }

  if (
    state.recovery?.stashRef &&
    (state.recovery.stashApplied ||
      (await isAncestor(state.recovery.targetHeadSha, head.sha, localPath)))
  ) {
    if (!(await restoreTargetSynchronizationStash(state, localPath))) return;
  }
  const sourceNeedsFastForward =
    Boolean(sourceHeadSha) &&
    sourceHeadSha !== head.sha &&
    (await isAncestor(head.sha, sourceHeadSha!, localPath));
  if (
    !state.recovery &&
    sourceHeadSha &&
    sourceHeadSha !== head.sha &&
    !sourceNeedsFastForward &&
    !(await isAncestor(sourceHeadSha, head.sha, localPath))
  ) {
    throw new RunnerWorkspaceReconciliationError(
      'The retained runner workspace and provider source branch have diverged.'
    );
  }
  const targetNeedsRebase = !(await isAncestor(
    targetHeadSha,
    sourceNeedsFastForward ? sourceHeadSha! : head.sha,
    localPath
  ));
  if (!sourceNeedsFastForward && !targetNeedsRebase) {
    if (
      !state.recovery &&
      checkpointCurrentTarget &&
      state.phase === 'prepared'
    ) {
      state.recovery = {
        kind: 'target_sync',
        phase: 'ready_to_push',
        mergeRequestUrl: mergeRequestUrl ?? null,
        sourceBranch: state.branch,
        targetBranch: state.targetBranch,
        sourceHeadSha: sourceHeadSha ?? undefined,
        targetHeadSha,
        attempt: 1,
        conflictFiles: [],
      };
    }
    if (state.recovery) {
      if (!(await restoreTargetSynchronizationStash(state, localPath))) return;
      state.recovery.phase = 'ready_to_push';
      state.recovery.conflictFiles = [];
    }
    if (!state.commitSha) state.preparedHeadSha = head.sha;
    await writeRunnerState(state);
    return;
  }

  if (state.recovery?.phase === 'conflicts') {
    state.recovery.phase = 'ready_to_push';
    state.recovery.conflictFiles = [];
    await writeRunnerState(state);
  }
  const previousRecovery = state.recovery ? { ...state.recovery } : undefined;
  const previousPreparedHead = state.preparedHeadSha;
  const previousCommit = state.commitSha;
  const status = await getWorkingTreeStatus(localPath);
  if (state.recovery?.stashRef && status) {
    throw new Error(
      'Target synchronization has both a preserved stash and additional local edits. Preserve those edits before resuming the pending synchronization.'
    );
  }
  const newStashRef = status ? await stashWorkingTree(localPath) : undefined;
  state.recovery = {
    kind: 'target_sync',
    phase: 'in_progress',
    mergeRequestUrl:
      previousRecovery?.mergeRequestUrl ?? mergeRequestUrl ?? null,
    sourceBranch: state.branch,
    targetBranch: state.targetBranch,
    sourceHeadSha:
      previousRecovery?.sourceHeadSha ?? sourceHeadSha ?? undefined,
    targetHeadSha,
    attempt: previousRecovery
      ? previousRecovery.attempt +
        (previousRecovery.targetHeadSha !== targetHeadSha ? 1 : 0)
      : 1,
    conflictFiles: [],
    ...(newStashRef ?? previousRecovery?.stashRef
      ? { stashRef: newStashRef ?? previousRecovery?.stashRef }
      : {}),
  };
  state.preparedHeadSha = head.sha;
  state.commitSha = undefined;
  try {
    // Save the source lease, target and exact stash before changing HEAD.
    await writeRunnerState(state, 'prepared');
  } catch (error) {
    state.recovery = previousRecovery;
    state.preparedHeadSha = previousPreparedHead;
    state.commitSha = previousCommit;
    if (newStashRef)
      await restoreStashAfterFailure(newStashRef, localPath, error);
    throw error;
  }

  if (sourceNeedsFastForward) await fastForwardBranch(state.branch, localPath);
  if (targetNeedsRebase) {
    try {
      await startRebase(state.targetBranch, localPath);
    } catch (error) {
      const conflictFiles = await getConflictedFiles(localPath);
      if (!conflictFiles.length && !(await isRebaseInProgress(localPath)))
        throw error;
      state.recovery!.phase = 'conflicts';
      state.recovery!.conflictFiles = conflictFiles;
      state.preparedHeadSha = (await getHeadCommit(localPath)).sha;
      await writeRunnerState(state);
      return;
    }
  }
  head = await getHeadCommit(localPath);
  state.preparedHeadSha = head.sha;
  await writeRunnerState(state);
  if (!(await restoreTargetSynchronizationStash(state, localPath))) return;
  state.recovery!.phase = 'ready_to_push';
  state.recovery!.conflictFiles = [];
  await writeRunnerState(state);
}

async function restoreTargetSynchronizationStash(
  state: RunnerWorkspaceState,
  localPath: string
) {
  if (!state.recovery?.stashRef) return true;
  const stashEntry = await getRecoveryStashEntry(state.recovery, localPath);
  if (!state.recovery.stashApplied) {
    if (!stashEntry) {
      throw new Error(
        'The preserved working-tree stash "' +
          state.recovery.stashRef +
          '" is unavailable before it was applied.'
      );
    }
    if (state.recovery.phase === 'ready_to_push') {
      state.recovery.phase = 'in_progress';
      await writeRunnerState(state, 'prepared');
    }
    try {
      await applyStash(stashEntry.commitSha, localPath);
    } catch (error) {
      const conflictFiles = await getConflictedFiles(localPath);
      if (!conflictFiles.length) throw error;
      state.recovery!.phase = 'conflicts';
      state.recovery!.conflictFiles = conflictFiles;
      state.recovery!.stashApplied = true;
      await writeRunnerState(state);
      return false;
    }
    state.recovery!.stashApplied = true;
    await writeRunnerState(state);
  }
  if (stashEntry) await dropStash(stashEntry.commitSha, localPath);
  delete state.recovery!.stashRef;
  delete state.recovery!.stashApplied;
  await writeRunnerState(state);
  return true;
}

export async function reconcileRunnerRecoveryWorkspace(
  state: RunnerWorkspaceState,
  localPath: string
) {
  try {
    await assertGitWorkspaceIdentity(localPath);
  } catch (error) {
    throw recoveryReconciliationError(
      'The retained recovery checkout no longer has a valid runner Git workspace identity.',
      error
    );
  }
  const recovery = state.recovery;
  if (!recovery) return;

  const rebaseInProgress = await isRebaseInProgress(localPath);
  recovery.kind = 'target_sync';
  if (rebaseInProgress) {
    recovery.phase = 'conflicts';
    recovery.conflictFiles = await getConflictedFiles(localPath);
    await writeRunnerState(state);
    return;
  }
  try {
    await assertCurrentRunnerBranch(state, localPath);
  } catch (error) {
    throw recoveryReconciliationError(
      'The retained recovery checkout branch no longer matches DB execution state.',
      error
    );
  }
  const conflictFiles = await getConflictedFiles(localPath);
  if (conflictFiles.length) {
    recovery.phase = 'conflicts';
    recovery.conflictFiles = conflictFiles;
  }
  await writeRunnerState(state);
}

function recoveryReconciliationError(message: string, cause: unknown) {
  return new RunnerWorkspaceReconciliationError(
    message + ' ' + (cause instanceof Error ? cause.message : String(cause))
  );
}

async function getRecoveryStashEntry(
  recovery: RunnerWorkspaceRebaseRecovery,
  localPath: string
) {
  const stashRef = recovery.stashRef;
  if (!stashRef) return null;
  const stashEntry = await getStashEntry(stashRef, localPath);
  if (
    stashEntry &&
    stashRef.startsWith('stash@{') &&
    !stashEntry.message.includes('omniboard-runner-target-sync')
  ) {
    throw new RunnerWorkspaceReconciliationError(
      `Persisted legacy stash reference "${stashRef}" now points to an unrelated stash; refusing to apply or drop it.`
    );
  }
  if (stashEntry) {
    recovery.stashRef = stashEntry.commitSha;
  }
  return stashEntry;
}

export function createRecoveryProgressMetadata(
  recovery: RunnerWorkspaceRebaseRecovery
) {
  return {
    remediation: recovery.kind,
    remediationPhase: recovery.phase,
    remediationAttempt: recovery.attempt,
    sourceHeadSha: recovery.sourceHeadSha,
    targetHeadSha: recovery.targetHeadSha,
    targetBranch: recovery.targetBranch,
    conflictFiles: recovery.conflictFiles,
  };
}

export function formatRecoveryProgressNote(state: RunnerWorkspaceState) {
  const recovery = state.recovery;
  if (!recovery) {
    return 'Prepared dedicated runner workspace for mergeability recovery.';
  }
  if (recovery.kind === 'target_sync') {
    if (recovery.phase === 'conflicts') {
      return (
        'Resolving target-branch synchronization conflicts while rebasing "' +
        recovery.sourceBranch +
        '" onto "' +
        recovery.targetBranch +
        '": ' +
        recovery.conflictFiles.join(', ')
      );
    }
    return `Synchronized "${recovery.sourceBranch}" onto the latest "${recovery.targetBranch}" and awaiting finalization.`;
  }
  if (recovery.phase === 'conflicts') {
    return (
      'Resolving merge conflicts while rebasing "' +
      recovery.sourceBranch +
      '" onto "' +
      recovery.targetBranch +
      '": ' +
      recovery.conflictFiles.join(', ')
    );
  }
  return `Rebased "${recovery.sourceBranch}" onto "${recovery.targetBranch}" and awaiting verification before push.`;
}

async function restoreStashAfterFailure(
  stashRef: string,
  localPath: string,
  originalError: unknown
) {
  try {
    await applyStash(stashRef, localPath);
    await dropStash(stashRef, localPath);
  } catch (restoreError) {
    throw new Error(
      toErrorMessage(originalError) +
        ' The preserved runner workspace changes remain in ' +
        stashRef +
        ', but restoring them failed: ' +
        toErrorMessage(restoreError),
      { cause: originalError }
    );
  }
}

function isEmptyRebaseCommitError(error: unknown) {
  const output = [toErrorMessage(error)];
  if (error && typeof error === 'object') {
    for (const key of ['stdout', 'stderr'] as const) {
      const value = Reflect.get(error, key);
      if (typeof value === 'string') {
        output.push(value);
      }
    }
  }
  return /No changes - did you forget|previous cherry-pick is now empty|patch is empty/i.test(
    output.join('\n')
  );
}

export function createRecoveryWorkspaceInstructions(
  runKey: string,
  projectName: string,
  state: RunnerWorkspaceState
) {
  if (!state.recovery) {
    throw new Error('Runner workspace rebase recovery state is missing.');
  }
  const conflictInstruction = state.recovery.conflictFiles.length
    ? 'Resolve only the current rebase conflicts in: ' +
      state.recovery.conflictFiles.join(', ') +
      '. Do not run git rebase, commit, or push commands yourself.'
    : state.recovery.kind === 'target_sync'
    ? 'The target branch synchronization completed without file conflicts. Continue the requested project work, then finalize the workspace.'
    : 'The rebase completed without file conflicts. Verify the project before finalization.';
  const targetSyncNote =
    state.recovery.kind === 'target_sync'
      ? 'The prepared source branch includes the latest target branch. Preserve the target changes while completing the requested work.'
      : '';
  return [
    'Work only inside ' + state.localPath + '.',
    ...(targetSyncNote ? [targetSyncNote] : []),
    conflictInstruction,
    'Preserve the intended changes from both the target branch and the agentic branch.',
    'Run relevant tests, lint, or build commands before finalizing.',
    'When ready, call omniboard_runner_finalize_agentic_run_workspace with runKey "' +
      runKey +
      '", projectName "' +
      projectName +
      '", and localPath "' +
      state.localPath +
      '". Finalization will continue the rebase and may return another set of conflicts to resolve.',
    'If you stop without finalizing, call omniboard_runner_release_agentic_run_workspace with runKey "' +
      runKey +
      '", and projectName "' +
      projectName +
      '" so this workspace does not remain leased.',
  ];
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
