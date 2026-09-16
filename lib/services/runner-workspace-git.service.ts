import {
  AgenticRunProjectState,
  RepositoryAccess,
  RunnerWorkspaceState,
} from '../interface.js';
import {
  commitAll,
  fetchBranch,
  getCurrentBranch,
  getHeadCommit,
  getRemoteBranchCommit,
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
  access: RepositoryAccess,
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

  let head = await getHeadCommit(localPath);
  const sourceRemoteBeforeFetch = await getRemoteBranchCommit(
    state.branch,
    localPath
  );
  try {
    if (sourceRemoteBeforeFetch) {
      await withGitCredentials(access, localPath, (env) =>
        fetchBranch(repositoryUrl, state.branch, localPath, env)
      );
    }
  } catch (error) {
    throw new Error(
      'Unable to refresh the provider source branch: ' + toErrorMessage(error)
    );
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
    if (
      !(await isAncestor(head.sha, remoteCommit, localPath)) &&
      !(await isAncestor(remoteCommit, head.sha, localPath))
    ) {
      throw new RunnerWorkspaceReconciliationError(
        'The retained workspace and remote provider branch have diverged.'
      );
    }
    if (!hasVerifiedLocalHead) {
      throw new RunnerWorkspaceReconciliationError(
        'The retained workspace contains an unverified local commit.'
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
  commitMessage: string
) {
  const head = await getHeadCommit(localPath);
  if (head.sha !== state.preparedHeadSha) {
    throw new Error(
      'Runner workspace HEAD changed before finalization; commit manually or prepare a new workspace.'
    );
  }

  const commitSha = await commitAll(commitMessage, localPath);
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
