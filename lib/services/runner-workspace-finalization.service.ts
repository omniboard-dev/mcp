import path from 'node:path';
import { RunnerWorkspaceFinalizeResult } from '../interface.js';
import * as api from './api.service.js';
import { reportRunnerAgenticRunProgressSafely } from './agentic-runs.service.js';
import {
  commitAll,
  getConflictedFiles,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getWorkingTreeStatus,
  isRebaseInProgress,
  pushBranch,
  pushBranchWithLease,
} from './git.service.js';
import { writeRunnerState } from './runner-execution.service.js';
import { prepareRunnerWorkspace } from './runner-workspace-preparation.service.js';
import { finalizeRunnerRebaseRecovery } from './runner-workspace-recovery.service.js';
import {
  assertAuthorizedRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import {
  createChangeRequest,
  getChangeRequestDetails,
} from './source-control.service.js';

export interface FinalizeRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  localPath: string;
  commitMessage?: string;
  mergeRequestTitle?: string;
  mergeRequestDescription?: string;
}
export async function finalizeRunnerWorkspace(
  options: FinalizeRunnerWorkspaceOptions
): Promise<RunnerWorkspaceFinalizeResult> {
  const prepared = await prepareRunnerWorkspace(options);
  const state = prepared.workspace;
  if (!state) throw new Error(prepared.continuation.instructions.join(' '));
  if (path.resolve(options.localPath) !== path.resolve(state.localPath))
    throw new Error(
      'The requested path is not this project migration checkout: ' +
        state.localPath
    );
  const progressReports: RunnerWorkspaceFinalizeResult['progressReports'] = [];
  const headBeforeRecovery = (await getHeadCommit(state.localPath)).sha;
  const conflicts = await getConflictedFiles(state.localPath);
  if (conflicts.length)
    return {
      completed: false,
      workspace: state,
      progressReports,
      conflictFiles: conflicts,
      instructions: [
        'Resolve and stage these conflicts, run the relevant checks, then finalize the same workspace.',
      ],
    };
  if (state.recovery) {
    const recovery = await finalizeRunnerRebaseRecovery(
      state,
      state.localPath,
      progressReports
    );
    if (
      recovery.error ||
      state.recovery?.phase === 'conflicts' ||
      (await isRebaseInProgress(state.localPath))
    )
      return recovery;
  }
  if (
    prepared.workspaceCreated ||
    prepared.workspaceChanged ||
    headBeforeRecovery !== (await getHeadCommit(state.localPath)).sha
  )
    return {
      completed: false,
      workspace: state,
      progressReports,
      instructions: [
        prepared.workspaceCreated
          ? 'The runner checkout was recreated. Apply the run prompt and run the relevant checks in this fresh workspace before finalizing again.'
          : 'Synchronization changed the checkout. Review the changes and rerun relevant checks before finalizing again.',
      ],
    };
  const expectedSource = state.recovery?.sourceHeadSha;
  const mrUrl =
    state.recovery?.mergeRequestUrl ??
    prepared.projectState.progress.mergeRequestUrl;
  const message = options.commitMessage ?? state.commitMessage!;
  const commitSha = (await getWorkingTreeStatus(state.localPath))
    ? await commitAll(message, state.localPath)
    : (await getHeadCommit(state.localPath)).sha;
  state.commitSha = commitSha;
  const access = await api.getRepositoryAccess(state.repositoryUrl);
  const repositoryUrl = await getEffectiveRepositoryUrl(
    state.repositoryUrl,
    state.localPath
  );
  assertAuthorizedRepositoryUrl(access, state.repositoryUrl, repositoryUrl);
  await withGitCredentials(access, state.localPath, (env) =>
    expectedSource
      ? pushBranchWithLease(
          repositoryUrl,
          state.branch,
          expectedSource,
          state.localPath,
          env
        )
      : pushBranch(repositoryUrl, state.branch, state.localPath, env)
  );
  state.recovery = undefined;
  await writeRunnerState(state, 'pushed');
  const existingRequest = mrUrl
    ? await getChangeRequestDetails(access, state.projectPath, mrUrl)
    : null;
  const mergeRequest =
    existingRequest &&
    !['closed', 'declined'].includes(existingRequest.state.toLowerCase())
      ? existingRequest
      : await createChangeRequest(
          access,
          state.projectPath,
          state.branch,
          state.targetBranch,
          options.mergeRequestTitle ?? message,
          options.mergeRequestDescription ??
            'Automated change for OMNIBOARD run ' + state.runKey + '.'
        );
  progressReports.push(
    await reportRunnerAgenticRunProgressSafely(
      state.runKey,
      state.projectName,
      {
        status: 'mr_created',
        repositoryUrl: state.repositoryUrl,
        branch: state.branch,
        commitSha,
        mergeRequestUrl: mergeRequest.url,
        mergeRequestState: mergeRequest.state,
        notes:
          'Published migration. Follow this MR pipeline and repair failures in the same checkout.',
      }
    )
  );
  return {
    completed: true,
    published: true,
    workspace: state,
    commitSha,
    mergeRequest,
    progressReports,
    instructions: [
      'Publication succeeded. Wait while CI runs; repair failed CI or merge conflicts until the open MR is green and mergeable. Then no agent work remains. Do not merge automatically.',
    ],
  };
}
