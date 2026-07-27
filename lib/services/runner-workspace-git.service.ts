import {
  AgenticRunProjectState,
  McpRepositoryAccess,
  RunnerWorkspaceState,
} from '../interface.js';
import {
  commitAll,
  fastForwardBranch,
  fetchBranch,
  getCurrentBranch,
  getHeadCommit,
  getRemoteBranchCommit,
  getWorkingTreeStatus,
  isAncestor,
  isRebaseInProgress,
} from './git.service.js';
import { withGitCredentials } from './runner-workspace-repository.service.js';
import { writeRunnerState } from './runner-execution.service.js';
import { assertGitWorkspaceIdentity } from './runner-workspace-store.service.js';

export class RunnerWorkspaceReconciliationError extends Error {}

export async function reconcileRunnerWorkspace(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: McpRepositoryAccess,
  projectState: AgenticRunProjectState
) {
  try {
    await assertGitWorkspaceIdentity(localPath);
  } catch (error) {
    throw reconciliationError(
      'The retained checkout no longer has a valid runner Git workspace identity.',
      error
    );
  }
  if (await isRebaseInProgress(localPath)) {
    throw new RunnerWorkspaceReconciliationError(
      'The retained checkout has an in-progress rebase not present in DB execution state.'
    );
  }
  try {
    await assertCurrentRunnerBranch(state, localPath);
  } catch (error) {
    throw reconciliationError(
      'The retained checkout branch no longer matches DB execution state.',
      error
    );
  }
  if (
    projectState.progress.branch &&
    projectState.progress.branch !== state.branch
  ) {
    throw new Error(
      'Provider branch "' +
        projectState.progress.branch +
        '" does not match retained workspace branch "' +
        state.branch +
        '".'
    );
  }

  const workingTreeStatus = await getWorkingTreeStatus(localPath);
  let head = await getHeadCommit(localPath);
  try {
    await withGitCredentials(access, localPath, (env) =>
      fetchBranch(repositoryUrl, state.branch, localPath, env)
    );
  } catch (error) {
    if (projectState.progress.mergeRequestUrl) {
      throw new Error(
        'Unable to refresh the existing provider branch: ' +
          toErrorMessage(error)
      );
    }
  }

  const remoteCommit = await getRemoteBranchCommit(state.branch, localPath);
  const hasVerifiedLocalHead =
    head.sha === state.preparedHeadSha || head.sha === state.commitSha;
  if (!remoteCommit && !hasVerifiedLocalHead) {
    throw new RunnerWorkspaceReconciliationError(
      'The retained workspace contains an unverified local commit.'
    );
  }
  if (remoteCommit && remoteCommit !== head.sha) {
    if (await isAncestor(head.sha, remoteCommit, localPath)) {
      if (workingTreeStatus) {
        throw new RunnerWorkspaceReconciliationError(
          'The remote branch advanced while the retained workspace has local changes.'
        );
      }
      await fastForwardBranch(state.branch, localPath);
      head = await getHeadCommit(localPath);
    } else if (await isAncestor(remoteCommit, head.sha, localPath)) {
      if (!hasVerifiedLocalHead) {
        throw new RunnerWorkspaceReconciliationError(
          'The retained workspace contains an unverified local commit.'
        );
      }
    } else {
      throw new RunnerWorkspaceReconciliationError(
        'The retained workspace and remote provider branch have diverged.'
      );
    }
  }

  state.preparedHeadSha = head.sha;
  state.commitSha = undefined;
  await writeRunnerState(state);
}

function reconciliationError(message: string, cause: unknown) {
  return new RunnerWorkspaceReconciliationError(
    message + ' ' + toErrorMessage(cause)
  );
}

export async function createRunnerCommit(
  state: RunnerWorkspaceState,
  localPath: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string
) {
  const head = await getHeadCommit(localPath);
  if (head.sha !== state.preparedHeadSha) {
    throw new Error(
      'Runner workspace HEAD changed before finalization; commit manually or prepare a new workspace.'
    );
  }

  const commitSha = await commitAll(
    commitMessage,
    localPath,
    authorName,
    authorEmail
  );
  state.commitSha = commitSha;
  await writeRunnerState(state);
  return commitSha;
}

export async function resolveExistingRunnerCommit(
  state: RunnerWorkspaceState,
  localPath: string,
  commitMessage: string
) {
  const head = await getHeadCommit(localPath);
  if (
    head.sha === state.preparedHeadSha ||
    head.parentShas.length !== 1 ||
    head.parentShas[0] !== state.preparedHeadSha ||
    head.message !== commitMessage ||
    (state.commitSha && state.commitSha !== head.sha)
  ) {
    throw new Error(
      'Runner workspace has no verified runner commit to resume.'
    );
  }

  if (!state.commitSha) {
    state.commitSha = head.sha;
    await writeRunnerState(state);
  }
  return head.sha;
}

export async function assertCurrentRunnerBranch(
  state: RunnerWorkspaceState,
  localPath: string
) {
  const currentBranch = await getCurrentBranch(localPath);
  if (currentBranch !== state.branch) {
    throw new Error(
      `Runner workspace is on branch "${currentBranch}", expected "${state.branch}".`
    );
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
