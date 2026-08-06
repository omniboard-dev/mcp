import path from 'node:path';

import {
  AgenticRunProgressReportResult,
  AgenticRunProjectState,
  RunnerWorkspaceFinalizeResult,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import {
  reportRunnerAgenticRunProgressSafely,
  resolveAgenticRunContinuation,
} from './agentic-runs.service.js';
import {
  getEffectiveRepositoryUrl,
  getWorkingTreeStatus,
  pushBranch,
} from './git.service.js';
import {
  acquireRunnerExecution,
  completeRunnerExecutionByIdentity,
  createRunnerWorkspaceState,
  releaseRunnerExecution,
  writeRunnerState,
} from './runner-execution.service.js';
import {
  assertCurrentRunnerBranch,
  createRunnerCommit,
  resolveExistingRunnerCommit,
} from './runner-workspace-git.service.js';
import { finalizeRunnerRebaseRecovery } from './runner-workspace-recovery.service.js';
import {
  assertAuthorizedRepositoryUrl,
  repositoryIdentity,
  resolveProjectRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import {
  assertGitWorkspaceIdentity,
  assertRunnerWorkspacePath,
  assertWorkspaceIdentity,
  ensureRunnerLayout,
  runnerWorkspacePath,
} from './runner-workspace-store.service.js';
import {
  createChangeRequest,
  providerLabel,
  validateRepositoryAccess,
} from './source-control.service.js';
import {
  defaultRunnerCommitMessage,
  normalizeNonEmptyString,
  resolveRunnerGitValues,
} from './runner-workspace-values.service.js';

export interface FinalizeRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  localPath: string;
  commitMessage?: string;
  mergeRequestTitle?: string;
  mergeRequestDescription?: string;
}

export async function finalizeRunnerWorkspace({
  runKey,
  projectName,
  localPath: requestedLocalPath,
  commitMessage,
  mergeRequestTitle,
  mergeRequestDescription,
}: FinalizeRunnerWorkspaceOptions): Promise<RunnerWorkspaceFinalizeResult> {
  const projectState = await api.refreshAgenticRunProjectState(
    runKey,
    projectName
  );
  const continuation = await resolveAgenticRunContinuation(projectState);
  if (continuation.action !== 'continue') {
    if (continuation.action === 'stop') {
      await completeRunnerExecutionByIdentity(
        runKey,
        projectName,
        continuation.reason === 'change_dismissed' ? 'abandoned' : 'completed'
      );
    }
    throw new Error(
      `Runner workspace finalization is not permitted while the continuation decision is "${
        continuation.action
      }" (${continuation.reason}). ${continuation.instructions.join(' ')}`
    );
  }

  const repositoryUrl = resolveProjectRepositoryUrl(projectState.project);
  const access = await api.getRepositoryAccess(repositoryUrl);
  const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
    repositoryUrl,
    process.cwd()
  );
  assertAuthorizedRepositoryUrl(access, repositoryUrl, effectiveRepositoryUrl);
  const repository = await validateRepositoryAccess(
    access,
    effectiveRepositoryUrl
  );
  const resolvedGitValues = resolveRunnerGitValues(projectState.run, {
    branch: projectState.progress.branch ?? undefined,
  });
  const execution = await acquireRunnerExecution({
    runKey,
    projectName,
    repositoryUrl,
    sourceControlProvider: access.provider,
    sourceControlRepositoryId: repository.repositoryId,
    branch: resolvedGitValues.branchName,
    commitMessage: resolvedGitValues.commitMessage,
  });
  let localPath: string;
  let state: RunnerWorkspaceState;
  try {
    const layout = await ensureRunnerLayout();
    const expectedLocalPath = runnerWorkspacePath(
      layout.workspaces,
      projectName,
      execution.executionKey,
      execution.generation
    );
    if (path.resolve(requestedLocalPath) !== path.resolve(expectedLocalPath)) {
      throw new Error(
        'Runner workspace path does not match the active DB execution generation.'
      );
    }
    localPath = await assertRunnerWorkspacePath(
      layout.workspaces,
      expectedLocalPath
    );
    state = createRunnerWorkspaceState(execution, localPath, access);
    assertWorkspaceIdentity(state, runKey, projectName, localPath);
    assertFinalizationProjectStateMatchesWorkspace(state, projectState);
  } catch (error) {
    await releaseRunnerExecution(execution.executionKey);
    throw error;
  }

  const resolvedCommitMessage =
    normalizeNonEmptyString(commitMessage) ??
    state.commitMessage ??
    defaultRunnerCommitMessage(runKey);
  state.commitMessage = resolvedCommitMessage;
  const progressReports: AgenticRunProgressReportResult[] = [];

  try {
    if (state.recovery) {
      return finalizeRunnerRebaseRecovery(state, localPath, progressReports);
    }

    await assertGitWorkspaceIdentity(localPath);
    await assertCurrentRunnerBranch(state, localPath);
    const status = await getWorkingTreeStatus(localPath);
    const commitSha = status
      ? await createRunnerCommit(state, localPath, resolvedCommitMessage)
      : await resolveExistingRunnerCommit(
          state,
          localPath,
          resolvedCommitMessage
        );
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'committed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        notes: resolvedCommitMessage,
      })
    );

    const workspaceRepositoryUrl = await getEffectiveRepositoryUrl(
      state.repositoryUrl,
      localPath
    );
    assertAuthorizedRepositoryUrl(
      access,
      state.repositoryUrl,
      workspaceRepositoryUrl
    );
    const workspaceRepository = await validateRepositoryAccess(
      access,
      workspaceRepositoryUrl
    );
    if (workspaceRepository.repositoryId !== state.projectPath) {
      throw new Error(
        `${providerLabel(access)} ${
          access.provider === 'gitlab' ? 'project' : 'repository'
        } identity changed from "${state.projectPath}" to "${
          workspaceRepository.repositoryId
        }".`
      );
    }
    await withGitCredentials(access, localPath, (env) =>
      pushBranch(workspaceRepositoryUrl, state.branch, localPath, env)
    );
    await writeRunnerState(state, 'pushed');
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'pushed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        notes: `Pushed branch "${state.branch}".`,
      })
    );

    const mergeRequest = await createChangeRequest(
      access,
      state.projectPath,
      state.branch,
      state.targetBranch,
      mergeRequestTitle ?? resolvedCommitMessage,
      mergeRequestDescription ??
        `Automated change for Omniboard agentic run ${runKey}.`
    );
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'mr_created',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        mergeRequestUrl: mergeRequest.url,
        mergeRequestState: mergeRequest.state,
        notes: `Created merge request: ${mergeRequest.title}`,
        metadata: {
          mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
          mergeRequestIid: mergeRequest.iid ?? null,
          targetBranch: state.targetBranch,
        },
      })
    );

    await releaseRunnerExecution(state.executionKey);
    return {
      completed: true,
      workspace: state,
      commitSha,
      mergeRequest,
      progressReports,
    };
  } catch (error) {
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'failed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        error: error instanceof Error ? error.message : String(error),
        notes: 'Dedicated runner finalization failed.',
        metadata: {
          mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
        },
      })
    );
    throw error;
  }
}

function assertFinalizationProjectStateMatchesWorkspace(
  state: RunnerWorkspaceState,
  projectState: AgenticRunProjectState
) {
  if (
    projectState.run.runKey !== state.runKey ||
    projectState.project.name !== state.projectName
  ) {
    throw new Error(
      'Refreshed run and project identity does not match the runner workspace.'
    );
  }
  if (
    projectState.progress.branch &&
    projectState.progress.branch !== state.branch
  ) {
    throw new Error(
      'Refreshed provider branch "' +
        projectState.progress.branch +
        '" does not match runner workspace branch "' +
        state.branch +
        '".'
    );
  }

  const repositoryUrls = [
    projectState.project.repositoryUrl,
    ...(projectState.project.repositoryUrls ?? []),
  ].filter((value): value is string => Boolean(value));
  if (
    repositoryUrls.length > 0 &&
    !repositoryUrls.some(
      (repositoryUrl) =>
        repositoryIdentity(repositoryUrl) ===
        repositoryIdentity(state.repositoryUrl)
    )
  ) {
    throw new Error(
      'Refreshed project repository does not match the runner workspace repository.'
    );
  }
}
