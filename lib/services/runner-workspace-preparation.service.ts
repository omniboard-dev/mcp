import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AgenticRunContinuationDecision,
  AgenticRunMatchedProject,
  AgenticRunProjectState,
  AgenticRunResponse,
  RunnerExecution,
  RunnerWorkspacePrepareResult,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import {
  getRunnerAgenticRun,
  listAgenticRunProjects,
  reportRunnerAgenticRunProgressSafely,
  resolveAgenticRunContinuation,
} from './agentic-runs.service.js';
import {
  applyGitIdentity,
  checkoutRemoteBranch,
  cloneRepository,
  createBranch,
  getDefaultBranch,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getMcpStartupGitIdentity,
  getRemoteBranchCommit,
} from './git.service.js';
import {
  acquireRunnerExecution,
  checkpointRunnerExecution,
  completeRunnerExecutionByIdentity,
  createRunnerWorkspaceState,
  reinitializeRunnerExecution,
  releaseRunnerExecution,
  RunnerExecutionLeaseConflictError,
} from './runner-execution.service.js';
import {
  reconcileRunnerWorkspace,
  RunnerWorkspaceReconciliationError,
} from './runner-workspace-git.service.js';
import {
  createRecoveryProgressMetadata,
  createRecoveryWorkspaceInstructions,
  formatRecoveryProgressNote,
  prepareRunnerRebaseRecovery,
  reconcileRunnerRecoveryWorkspace,
} from './runner-workspace-recovery.service.js';
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
  runnerWorkspaceExists,
  runnerWorkspacePath,
} from './runner-workspace-store.service.js';
import {
  getChangeRequestDetails,
  requestChangeRequestRebase,
  SourceControlChangeRequestDetails,
  validateRepositoryAccess,
} from './source-control.service.js';
import {
  defaultRunnerCommitMessage,
  resolveRunnerGitValues,
} from './runner-workspace-values.service.js';

const workspacePreparations = new Map<
  string,
  {
    options: PrepareRunnerWorkspaceOptions;
    result: Promise<RunnerWorkspacePrepareResult>;
  }
>();

export interface PrepareRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  repositoryUrl?: string;
  branch?: string;
}

export function prepareRunnerWorkspace(
  options: PrepareRunnerWorkspaceOptions
): Promise<RunnerWorkspacePrepareResult> {
  const preparationKey = createPreparationKey(
    options.runKey,
    options.projectName
  );
  const existingPreparation = workspacePreparations.get(preparationKey);
  if (existingPreparation) {
    if (!hasMatchingPreparationOptions(existingPreparation.options, options)) {
      return Promise.reject(
        new Error(
          'Runner workspace preparation is already in progress for run "' +
            options.runKey +
            '" and project "' +
            options.projectName +
            '" with different repository or branch options.'
        )
      );
    }
    return existingPreparation.result;
  }

  const preparation = prepareRunnerWorkspaceInternal(options).finally(() =>
    workspacePreparations.delete(preparationKey)
  );
  workspacePreparations.set(preparationKey, {
    options: { ...options },
    result: preparation,
  });
  return preparation;
}

export function isRunnerWorkspacePreparationInProgress(
  runKey: string,
  projectName: string
) {
  return workspacePreparations.has(createPreparationKey(runKey, projectName));
}

function createPreparationKey(runKey: string, projectName: string) {
  return JSON.stringify([runKey, projectName]);
}

function hasMatchingPreparationOptions(
  left: PrepareRunnerWorkspaceOptions,
  right: PrepareRunnerWorkspaceOptions
) {
  return (
    left.repositoryUrl === right.repositoryUrl && left.branch === right.branch
  );
}

async function refreshRunnerProjectStateLocallyIfNeeded({
  runKey,
  projectName,
  repositoryUrl,
  projectState,
}: PrepareRunnerWorkspaceOptions & {
  projectState: AgenticRunProjectState;
}): Promise<AgenticRunProjectState> {
  if (
    projectState.providerSync.success ||
    !projectState.progress.mergeRequestUrl
  ) {
    return projectState;
  }

  let providerSnapshot: SourceControlChangeRequestDetails['providerSnapshot'];
  try {
    const resolvedRepositoryUrl = resolveProjectRepositoryUrl(
      projectState.project,
      repositoryUrl ?? projectState.progress.repositoryUrl ?? undefined
    );
    const access = await api.getRepositoryAccess(resolvedRepositoryUrl);
    if (access.provider !== 'bitbucket_data_center') return projectState;

    const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
      resolvedRepositoryUrl,
      process.cwd()
    );
    assertAuthorizedRepositoryUrl(
      access,
      resolvedRepositoryUrl,
      effectiveRepositoryUrl
    );
    const repository = await validateRepositoryAccess(
      access,
      effectiveRepositoryUrl
    );
    const changeRequest = await getChangeRequestDetails(
      access,
      repository.repositoryId,
      projectState.progress.mergeRequestUrl
    );
    providerSnapshot = changeRequest.providerSnapshot;
  } catch {
    return projectState;
  }
  if (!providerSnapshot) return projectState;

  try {
    return await api.applyAgenticRunProjectProviderSnapshot(
      runKey,
      projectName,
      providerSnapshot
    );
  } catch (error) {
    if (error instanceof api.OmniboardApiError && error.status === 404) {
      return projectState;
    }
    throw error;
  }
}

async function prepareRunnerWorkspaceInternal({
  runKey,
  projectName,
  repositoryUrl,
  branch,
}: PrepareRunnerWorkspaceOptions): Promise<RunnerWorkspacePrepareResult> {
  let resolvedRepositoryUrl = repositoryUrl;
  let localPath: string | undefined;
  let createdWorkspace = false;
  let execution: RunnerExecution | undefined;

  try {
    let projectState = await api.refreshAgenticRunProjectState(
      runKey,
      projectName
    );
    projectState = await refreshRunnerProjectStateLocallyIfNeeded({
      runKey,
      projectName,
      repositoryUrl,
      branch,
      projectState,
    });
    const continuation = await resolveAgenticRunContinuation(projectState);
    if (continuation.action !== 'continue') {
      if (continuation.action === 'stop') {
        await completeRunnerExecutionByIdentity(
          runKey,
          projectName,
          continuation.reason === 'change_dismissed' ? 'abandoned' : 'completed'
        );
      }
      return createNonContinuablePreparation(projectState, continuation);
    }

    const discovery = await listAgenticRunProjects({ runKey });
    const project = discovery.projects.find(
      (item) => item.name === projectName
    );
    if (!project) {
      throw new Error(
        'Project "' +
          projectName +
          '" does not currently match run "' +
          runKey +
          '".'
      );
    }

    const runResponse = await getRunnerAgenticRun(projectName, runKey);

    const resolvedGitValues = resolveRunnerGitValues(runResponse.run, {
      branch: branch ?? projectState.progress.branch ?? undefined,
    });
    resolvedRepositoryUrl = resolveProjectRepositoryUrl(project, repositoryUrl);

    const access = await api.getRepositoryAccess(resolvedRepositoryUrl);
    const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
      resolvedRepositoryUrl,
      process.cwd()
    );
    assertAuthorizedRepositoryUrl(
      access,
      resolvedRepositoryUrl,
      effectiveRepositoryUrl
    );
    const repository = await validateRepositoryAccess(
      access,
      effectiveRepositoryUrl
    );
    const changeRequest = projectState.progress.mergeRequestUrl
      ? await getChangeRequestDetails(
          access,
          repository.repositoryId,
          projectState.progress.mergeRequestUrl
        )
      : null;
    if (
      changeRequest &&
      changeRequest.sourceBranch !== resolvedGitValues.branchName
    ) {
      throw new Error(
        `Provider change-request source branch "${changeRequest.sourceBranch}" does not match resolved runner branch "${resolvedGitValues.branchName}".`
      );
    }

    let providerRebaseFailure: string | undefined;
    if (
      changeRequest &&
      continuation.reason === 'actionable_merge_block' &&
      normalizeProviderStatus(
        projectState.progress.mergeRequestDetailedStatus
      ) === 'need_rebase'
    ) {
      if (changeRequest.rebaseInProgress) {
        return createAutomaticRebasePreparation(
          runResponse,
          project,
          projectState,
          changeRequest,
          'Provider-native rebase is already in progress.'
        );
      }
      const rebaseRequest = changeRequest.rebaseError
        ? { requested: false as const, reason: changeRequest.rebaseError }
        : await requestChangeRequestRebase(
            access,
            repository.repositoryId,
            changeRequest.url
          );
      if (rebaseRequest.requested) {
        return createAutomaticRebasePreparation(
          runResponse,
          project,
          projectState,
          changeRequest,
          'Provider-native rebase was requested successfully.'
        );
      }
      providerRebaseFailure = rebaseRequest.reason;
    }

    const gitIdentity = await getMcpStartupGitIdentity();

    execution = await acquireRunnerExecution({
      runKey,
      projectName,
      repositoryUrl: resolvedRepositoryUrl,
      sourceControlProvider: access.provider,
      sourceControlRepositoryId: repository.repositoryId,
      branch: resolvedGitValues.branchName,
      commitMessage: resolvedGitValues.commitMessage,
    });

    const layout = await ensureRunnerLayout();
    localPath = runnerWorkspacePath(
      layout.workspaces,
      projectName,
      execution.executionKey,
      execution.generation
    );
    let workspaceExists = await runnerWorkspaceExists(localPath);
    let initializeWorkspace = execution.phase === 'preparing';

    if (workspaceExists && initializeWorkspace) {
      execution = await reinitializeRunnerExecution(execution);
      localPath = runnerWorkspacePath(
        layout.workspaces,
        projectName,
        execution.executionKey,
        execution.generation
      );
      workspaceExists = await runnerWorkspaceExists(localPath);
    } else if (!workspaceExists && !initializeWorkspace) {
      execution = await reinitializeRunnerExecution(execution);
      localPath = runnerWorkspacePath(
        layout.workspaces,
        projectName,
        execution.executionKey,
        execution.generation
      );
      workspaceExists = await runnerWorkspaceExists(localPath);
      initializeWorkspace = true;
    }
    if (workspaceExists && initializeWorkspace) {
      throw new Error(
        'Fresh runner workspace path already exists for execution generation ' +
          execution.generation +
          '.'
      );
    }

    let state: RunnerWorkspaceState;
    let resumed = false;
    if (initializeWorkspace) {
      createdWorkspace = true;
      await withGitCredentials(access, localPath, (env) =>
        cloneRepository(
          effectiveRepositoryUrl,
          localPath!,
          path.dirname(localPath!),
          env
        )
      );
      localPath = await assertRunnerWorkspacePath(layout.workspaces, localPath);
      await assertGitWorkspaceIdentity(localPath);
      const targetBranch =
        changeRequest?.targetBranch ?? (await getDefaultBranch(localPath));
      const remoteBranchCommit = await getRemoteBranchCommit(
        resolvedGitValues.branchName,
        localPath
      );
      if (remoteBranchCommit) {
        await checkoutRemoteBranch(resolvedGitValues.branchName, localPath);
        resumed = true;
      } else {
        await createBranch(resolvedGitValues.branchName, localPath);
      }
      const preparedHeadSha = (await getHeadCommit(localPath)).sha;
      execution = await checkpointRunnerExecution(execution, {
        phase: 'prepared',
        targetBranch,
        preparedHeadSha,
        commitSha: null,
        recovery: null,
      });
      state = createRunnerWorkspaceState(execution, localPath, access);
    } else {
      localPath = await assertRunnerWorkspacePath(layout.workspaces, localPath);
      state = createRunnerWorkspaceState(execution, localPath, access);
      assertWorkspaceIdentity(state, runKey, projectName, localPath);
      if (state.branch !== resolvedGitValues.branchName) {
        throw new Error(
          'Retained runner workspace branch "' +
            state.branch +
            '" does not match resolved branch "' +
            resolvedGitValues.branchName +
            '".'
        );
      }
      if (
        repositoryIdentity(state.repositoryUrl) !==
          repositoryIdentity(resolvedRepositoryUrl) ||
        state.projectPath !== repository.repositoryId
      ) {
        throw new Error(
          'Retained runner workspace repository identity no longer matches the project.'
        );
      }
      state.targetBranch = changeRequest?.targetBranch ?? state.targetBranch;
      try {
        if (state.recovery) {
          await reconcileRunnerRecoveryWorkspace(state, localPath);
        } else {
          await reconcileRunnerWorkspace(
            state,
            localPath,
            effectiveRepositoryUrl,
            access,
            projectState
          );
        }
      } catch (error) {
        if (!(error instanceof RunnerWorkspaceReconciliationError)) {
          throw error;
        }
        await reinitializeRunnerExecution(execution);
        return prepareRunnerWorkspaceInternal({
          runKey,
          projectName,
          repositoryUrl,
          branch,
        });
      }
      resumed = true;
    }

    await applyGitIdentity(gitIdentity, localPath);

    if (changeRequest && continuation.reason === 'actionable_merge_block') {
      await prepareRunnerRebaseRecovery(
        state,
        localPath,
        effectiveRepositoryUrl,
        access,
        changeRequest,
        projectState.progress.mergeRequestDetailedStatus,
        providerRebaseFailure
      );
    }

    const progressReport = await reportRunnerAgenticRunProgressSafely(
      runKey,
      projectName,
      {
        status:
          state.recovery?.phase === 'conflicts' ? 'blocked' : 'in_progress',
        repositoryUrl: resolvedRepositoryUrl,
        localPath: state.localPath,
        branch: state.branch,
        notes: state.recovery
          ? formatRecoveryProgressNote(state)
          : resumed
          ? 'Continued dedicated runner workspace for "' + projectName + '".'
          : 'Prepared dedicated runner workspace for "' + projectName + '".',
        metadata: {
          mcpTool: 'omniboard_runner_prepare_agentic_run_workspace',
          targetBranch: state.targetBranch,
          resumed,
          ...(state.recovery
            ? createRecoveryProgressMetadata(state.recovery)
            : {}),
        },
      }
    );

    return {
      run: runResponse.run,
      project,
      result: runResponse.result,
      projectState,
      continuation,
      workspace: state,
      prompt: runResponse.run.prompt ?? null,
      instructions: createWorkspaceInstructions(
        runKey,
        projectName,
        state,
        continuation
      ),
      progressReport,
    };
  } catch (error) {
    if (error instanceof RunnerExecutionLeaseConflictError) {
      throw error;
    }
    let cleanupError: unknown;
    if (execution) {
      try {
        await releaseRunnerExecution(execution.executionKey);
      } catch (caught) {
        cleanupError = caught;
      }
    }
    if (localPath && createdWorkspace) {
      try {
        await fs.rm(localPath, { recursive: true, force: true });
        localPath = undefined;
      } catch (caught) {
        cleanupError = cleanupError ?? caught;
      }
    }

    const failureMessage = cleanupError
      ? toErrorMessage(error) +
        ' Cleanup also failed: ' +
        toErrorMessage(cleanupError)
      : toErrorMessage(error);
    await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
      status: 'failed',
      repositoryUrl: resolvedRepositoryUrl ?? null,
      localPath,
      error: failureMessage,
      notes: 'Dedicated runner workspace preparation failed.',
      metadata: {
        mcpTool: 'omniboard_runner_prepare_agentic_run_workspace',
      },
    });
    throw error;
  }
}

async function createAutomaticRebasePreparation(
  runResponse: AgenticRunResponse,
  project: AgenticRunMatchedProject,
  projectState: AgenticRunProjectState,
  changeRequest: SourceControlChangeRequestDetails,
  note: string
): Promise<RunnerWorkspacePrepareResult> {
  const continuation: AgenticRunContinuationDecision = {
    action: 'wait',
    reason: 'automatic_rebase_requested',
    instructions: [
      note,
      'Wait for the provider to finish rebasing the change-request source branch, then prepare the project again to refresh mergeability and pipeline state.',
    ],
    diagnostics: [],
  };
  const progressReport = await reportRunnerAgenticRunProgressSafely(
    projectState.run.runKey,
    projectState.project.name,
    {
      status: 'in_progress',
      repositoryUrl: projectState.project.repositoryUrl ?? null,
      branch: changeRequest.sourceBranch,
      mergeRequestUrl: changeRequest.url,
      mergeRequestState: changeRequest.state,
      mergeRequestDetailedStatus: changeRequest.detailedStatus,
      notes: note,
      metadata: {
        mcpTool: 'omniboard_runner_prepare_agentic_run_workspace',
        remediation: 'rebase',
        remediationPhase: 'provider_rebase_requested',
        targetBranch: changeRequest.targetBranch,
      },
    }
  );

  return {
    run: runResponse.run,
    project,
    result: runResponse.result,
    projectState,
    continuation,
    prompt: runResponse.run.prompt ?? null,
    instructions: continuation.instructions,
    progressReport,
  };
}

function createNonContinuablePreparation(
  projectState: AgenticRunProjectState,
  continuation: AgenticRunContinuationDecision
): RunnerWorkspacePrepareResult {
  return {
    run: projectState.run,
    project: {
      id: projectState.project.id,
      name: projectState.project.name,
      repositoryUrl: projectState.project.repositoryUrl,
      repositoryUrls: projectState.project.repositoryUrls,
    },
    projectState,
    continuation,
    prompt: projectState.run.prompt ?? null,
    instructions: continuation.instructions,
  };
}

function createWorkspaceInstructions(
  runKey: string,
  projectName: string,
  state: RunnerWorkspaceState,
  continuation: AgenticRunContinuationDecision
) {
  if (state.recovery) {
    return createRecoveryWorkspaceInstructions(runKey, projectName, state);
  }

  return [
    'Work only inside ' + state.localPath + '.',
    'Use the returned prompt and check result as the source of truth.',
    ...continuation.instructions,
    'Inspect the existing branch and implement the smallest coherent change that resolves the check or provider failure.',
    'Run relevant tests, lint, or build commands before finalizing.',
    'When ready, call omniboard_runner_finalize_agentic_run_workspace with runKey "' +
      runKey +
      '", projectName "' +
      projectName +
      '", and localPath "' +
      state.localPath +
      '". The prepared commit message is "' +
      (state.commitMessage ?? defaultRunnerCommitMessage(runKey)) +
      '".',
    'If you stop without finalizing, call omniboard_runner_release_agentic_run_workspace with runKey "' +
      runKey +
      '", and projectName "' +
      projectName +
      '" so this workspace does not remain leased.',
  ];
}

function normalizeProviderStatus(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
