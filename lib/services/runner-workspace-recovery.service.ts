import {
  AgenticRunProgressReportResult,
  McpRepositoryAccess,
  RunnerWorkspaceFinalizeResult,
  RunnerWorkspaceRebaseRecovery,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import { reportRunnerAgenticRunProgressSafely } from './agentic-runs.service.js';
import {
  continueRebase,
  fetchBranch,
  getConflictedFiles,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getRemoteBranchCommit,
  getWorkingTreeStatus,
  isRebaseInProgress,
  pushBranchWithLease,
  resetBranchToRemote,
  skipRebase,
  startRebase,
} from './git.service.js';
import { assertCurrentRunnerBranch } from './runner-workspace-git.service.js';
import {
  assertAuthorizedRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import {
  assertGitWorkspaceIdentity,
  writeRunnerState,
} from './runner-workspace-store.service.js';
import {
  getChangeRequestDetails,
  providerLabel,
  SourceControlChangeRequestDetails,
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

  if (recovery.phase === 'conflicts') {
    if (await isRebaseInProgress(localPath)) {
      try {
        await continueRebase(localPath);
      } catch (error) {
        const conflictFiles = await getConflictedFiles(localPath);
        if (conflictFiles.length) {
          recovery.conflictFiles = conflictFiles;
          await writeRunnerState(state);
          return reportRunnerRecoveryConflicts(
            state,
            localPath,
            progressReports
          );
        }
        if (
          isEmptyRebaseCommitError(error) &&
          (await isRebaseInProgress(localPath))
        ) {
          try {
            await skipRebase(localPath);
          } catch (skipError) {
            const skipConflictFiles = await getConflictedFiles(localPath);
            if (skipConflictFiles.length) {
              recovery.phase = 'conflicts';
              recovery.conflictFiles = skipConflictFiles;
              await writeRunnerState(state);
              return reportRunnerRecoveryConflicts(
                state,
                localPath,
                progressReports
              );
            }
            throw skipError;
          }
        } else {
          throw error;
        }
      }
    }
    if (await isRebaseInProgress(localPath)) {
      recovery.conflictFiles = await getConflictedFiles(localPath);
      await writeRunnerState(state);
      return reportRunnerRecoveryConflicts(state, localPath, progressReports);
    }
    recovery.phase = 'ready_to_push';
    recovery.conflictFiles = [];
  }

  await assertCurrentRunnerBranch(state, localPath);
  if (await getWorkingTreeStatus(localPath)) {
    throw new Error(
      'Runner workspace must be clean after completing rebase conflict resolution.'
    );
  }

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
  if (repository.repositoryId !== state.projectPath) {
    throw new Error(
      `${providerLabel(
        access
      )} repository identity changed during rebase recovery.`
    );
  }

  await withGitCredentials(access, localPath, async (env) => {
    await Promise.all([
      fetchBranch(
        effectiveRepositoryUrl,
        recovery.sourceBranch,
        localPath,
        env
      ),
      fetchBranch(
        effectiveRepositoryUrl,
        recovery.targetBranch,
        localPath,
        env
      ),
    ]);
  });
  const remoteSourceHead = await getRemoteBranchCommit(
    recovery.sourceBranch,
    localPath
  );
  if (remoteSourceHead !== recovery.sourceHeadSha) {
    const recoveryMetadata = createRecoveryProgressMetadata(recovery);
    if (remoteSourceHead) {
      await resetBranchToRemote(recovery.sourceBranch, localPath);
      state.preparedHeadSha = remoteSourceHead;
      state.commitSha = undefined;
      state.recovery = undefined;
      await writeRunnerState(state);
    }
    const error =
      'The provider source branch advanced during rebase recovery; the lease was not acquired and no push was attempted.';
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(
        state.runKey,
        state.projectName,
        {
          status: 'blocked',
          repositoryUrl: state.repositoryUrl,
          localPath,
          branch: state.branch,
          error,
          notes: error,
          metadata: recoveryMetadata,
        }
      )
    );
    return {
      completed: false,
      workspace: state,
      progressReports,
      error,
      instructions: [
        'Prepare the project again to reconcile the newly advanced source branch before retrying recovery.',
      ],
    };
  }

  const remoteTargetHead = await getRemoteBranchCommit(
    recovery.targetBranch,
    localPath
  );
  if (!remoteTargetHead) {
    throw new Error(
      'Unable to resolve the target branch before recovery push.'
    );
  }
  if (remoteTargetHead !== recovery.targetHeadSha) {
    if (recovery.attempt >= 3) {
      const recoveryMetadata = createRecoveryProgressMetadata(recovery);
      await resetRunnerRecoveryToRemoteSource(
        state,
        recovery,
        localPath,
        remoteSourceHead
      );
      const error =
        'The target branch advanced repeatedly during rebase recovery; retry limit reached without pushing.';
      progressReports.push(
        await reportRunnerAgenticRunProgressSafely(
          state.runKey,
          state.projectName,
          {
            status: 'blocked',
            repositoryUrl: state.repositoryUrl,
            localPath,
            branch: state.branch,
            error,
            notes: error,
            metadata: recoveryMetadata,
          }
        )
      );
      return {
        completed: false,
        workspace: state,
        progressReports,
        error,
        instructions: [
          'Prepare the project again after target-branch activity settles.',
        ],
      };
    }
    recovery.attempt += 1;
    recovery.targetHeadSha = remoteTargetHead;
    try {
      await startRebase(recovery.targetBranch, localPath);
    } catch (error) {
      const conflictFiles = await getConflictedFiles(localPath);
      if (!conflictFiles.length) throw error;
      recovery.phase = 'conflicts';
      recovery.conflictFiles = conflictFiles;
      await writeRunnerState(state);
      return reportRunnerRecoveryConflicts(state, localPath, progressReports);
    }
    await writeRunnerState(state);
  }

  const commitSha = (await getHeadCommit(localPath)).sha;
  const mergeRequest = await getChangeRequestDetails(
    access,
    state.projectPath,
    recovery.mergeRequestUrl
  );
  if (
    mergeRequest.sourceBranch !== recovery.sourceBranch ||
    mergeRequest.targetBranch !== recovery.targetBranch ||
    (mergeRequest.sourceHeadSha &&
      mergeRequest.sourceHeadSha !== recovery.sourceHeadSha)
  ) {
    const recoveryMetadata = createRecoveryProgressMetadata(recovery);
    await resetRunnerRecoveryToRemoteSource(
      state,
      recovery,
      localPath,
      remoteSourceHead
    );
    const error =
      'The change request changed during rebase recovery; no push was attempted.';
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(
        state.runKey,
        state.projectName,
        {
          status: 'blocked',
          repositoryUrl: state.repositoryUrl,
          localPath,
          branch: state.branch,
          error,
          notes: error,
          metadata: recoveryMetadata,
        }
      )
    );
    return {
      completed: false,
      workspace: state,
      progressReports,
      error,
      instructions: [
        'Prepare the project again to reconcile the current change-request branches before retrying recovery.',
      ],
    };
  }
  await withGitCredentials(access, localPath, (env) =>
    pushBranchWithLease(
      effectiveRepositoryUrl,
      recovery.sourceBranch,
      recovery.sourceHeadSha,
      localPath,
      env
    )
  );
  state.recovery = undefined;
  state.preparedHeadSha = commitSha;
  state.commitSha = commitSha;
  await writeRunnerState(state);
  progressReports.push(
    await reportRunnerAgenticRunProgressSafely(
      state.runKey,
      state.projectName,
      {
        status: 'pushed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        mergeRequestUrl: mergeRequest.url,
        mergeRequestState: mergeRequest.state,
        notes: `Rebased "${state.branch}" onto "${state.targetBranch}" and pushed with force-with-lease.`,
        metadata: {
          mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
          remediation: 'rebase',
          remediationPhase: 'pushed',
          targetBranch: state.targetBranch,
        },
      }
    )
  );
  let refreshError: string | undefined;
  try {
    await api.refreshAgenticRunProjectState(state.runKey, state.projectName);
  } catch (error) {
    refreshError =
      'The branch was pushed successfully, but refreshing provider state failed: ' +
      (error instanceof Error ? error.message : String(error));
  }

  return {
    completed: true,
    workspace: state,
    commitSha,
    mergeRequest,
    progressReports,
    ...(refreshError ? { instructions: [refreshError] } : {}),
  };
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
        localPath,
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

export async function prepareRunnerRebaseRecovery(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: McpRepositoryAccess,
  changeRequest: SourceControlChangeRequestDetails,
  fallbackDetailedStatus?: string | null,
  providerRebaseFailure?: string
) {
  if (state.recovery) {
    return;
  }

  const detailedStatus =
    normalizeProviderStatus(changeRequest.detailedStatus) ||
    normalizeProviderStatus(fallbackDetailedStatus);
  if (
    detailedStatus !== 'conflict' &&
    detailedStatus !== 'need_rebase' &&
    detailedStatus !== 'cannot_be_merged'
  ) {
    return;
  }

  const workingTreeStatus = await getWorkingTreeStatus(localPath);
  if (workingTreeStatus) {
    throw new Error(
      'Cannot start mergeability recovery while the runner workspace has local changes.'
    );
  }
  await withGitCredentials(access, localPath, (env) =>
    fetchBranch(repositoryUrl, changeRequest.targetBranch, localPath, env)
  );
  const sourceHeadSha = await getRemoteBranchCommit(
    changeRequest.sourceBranch,
    localPath
  );
  const targetHeadSha = await getRemoteBranchCommit(
    changeRequest.targetBranch,
    localPath
  );
  if (!sourceHeadSha || !targetHeadSha) {
    throw new Error(
      'Unable to resolve source and target branch commits for mergeability recovery.'
    );
  }
  if (
    changeRequest.sourceHeadSha &&
    changeRequest.sourceHeadSha !== sourceHeadSha
  ) {
    throw new Error(
      'Provider source branch advanced while mergeability recovery was being prepared.'
    );
  }
  const head = await getHeadCommit(localPath);
  if (head.sha !== sourceHeadSha) {
    throw new Error(
      'Runner workspace HEAD does not match the provider source branch before rebase.'
    );
  }

  const recovery: RunnerWorkspaceRebaseRecovery = {
    kind: 'rebase',
    phase: 'ready_to_push',
    mergeRequestUrl: changeRequest.url,
    sourceBranch: changeRequest.sourceBranch,
    targetBranch: changeRequest.targetBranch,
    sourceHeadSha,
    targetHeadSha,
    attempt: 1,
    conflictFiles: [],
  };
  state.targetBranch = changeRequest.targetBranch;
  state.recovery = recovery;

  try {
    await startRebase(changeRequest.targetBranch, localPath);
  } catch (error) {
    const conflictFiles = await getConflictedFiles(localPath);
    if (!conflictFiles.length) {
      state.recovery = undefined;
      await writeRunnerState(state);
      throw error;
    }
    recovery.phase = 'conflicts';
    recovery.conflictFiles = conflictFiles;
  }

  state.preparedHeadSha = (await getHeadCommit(localPath)).sha;
  state.commitSha = undefined;
  await writeRunnerState(state);

  if (providerRebaseFailure) {
    await reportRunnerAgenticRunProgressSafely(
      state.runKey,
      state.projectName,
      {
        status: 'in_progress',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        notes:
          'Provider-native rebase was unavailable, so MCP started a local rebase: ' +
          providerRebaseFailure,
        metadata: createRecoveryProgressMetadata(recovery),
      }
    );
  }
}

async function resetRunnerRecoveryToRemoteSource(
  state: RunnerWorkspaceState,
  recovery: RunnerWorkspaceRebaseRecovery,
  localPath: string,
  remoteSourceHead: string
) {
  await resetBranchToRemote(recovery.sourceBranch, localPath);
  state.preparedHeadSha = remoteSourceHead;
  state.commitSha = undefined;
  state.recovery = undefined;
  await writeRunnerState(state);
}

export async function reconcileRunnerRecoveryWorkspace(
  state: RunnerWorkspaceState,
  localPath: string
) {
  await assertGitWorkspaceIdentity(localPath);
  const recovery = state.recovery;
  if (!recovery) return;

  const rebaseInProgress = await isRebaseInProgress(localPath);
  if (recovery.phase === 'conflicts' && rebaseInProgress) {
    recovery.conflictFiles = await getConflictedFiles(localPath);
    await writeRunnerState(state);
    return;
  }
  if (rebaseInProgress) {
    throw new Error(
      'Runner workspace has an unexpected in-progress rebase recovery state.'
    );
  }

  await assertCurrentRunnerBranch(state, localPath);
  if (await getWorkingTreeStatus(localPath)) {
    throw new Error(
      'Recovered runner workspace has local changes outside an in-progress rebase.'
    );
  }
  recovery.phase = 'ready_to_push';
  recovery.conflictFiles = [];
  state.preparedHeadSha = (await getHeadCommit(localPath)).sha;
  await writeRunnerState(state);
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

function normalizeProviderStatus(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
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
    : 'The rebase completed without file conflicts. Verify the project before finalization.';
  return [
    'Work only inside ' + state.localPath + '.',
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
  ];
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
