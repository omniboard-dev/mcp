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
} from './git.service.js';
import { withGitCredentials } from './runner-workspace-repository.service.js';
import {
  assertGitWorkspaceIdentity,
  writeRunnerState,
} from './runner-workspace-store.service.js';

export async function reconcileRunnerWorkspace(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: McpRepositoryAccess,
  projectState: AgenticRunProjectState
) {
  await assertGitWorkspaceIdentity(localPath);
  await assertCurrentRunnerBranch(state, localPath);
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
    throw new Error(
      'The retained workspace contains an unverified local commit.'
    );
  }
  if (remoteCommit && remoteCommit !== head.sha) {
    if (await isAncestor(head.sha, remoteCommit, localPath)) {
      if (workingTreeStatus) {
        throw new Error(
          'The remote branch advanced while the retained workspace has local changes.'
        );
      }
      await fastForwardBranch(state.branch, localPath);
      head = await getHeadCommit(localPath);
    } else if (await isAncestor(remoteCommit, head.sha, localPath)) {
      if (!hasVerifiedLocalHead) {
        throw new Error(
          'The retained workspace contains an unverified local commit.'
        );
      }
    } else {
      throw new Error(
        'The retained workspace and remote provider branch have diverged.'
      );
    }
  }

  state.preparedHeadSha = head.sha;
  state.commitSha = undefined;
  await writeRunnerState(state);
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
