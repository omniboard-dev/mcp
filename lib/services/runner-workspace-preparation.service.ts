import path from 'node:path';
import {
  getAgenticRunContinuationDecision,
  workflowContinuation,
} from './agentic-run-continuation.service.js';
import { RunnerWorkspacePrepareResult } from '../interface.js';
import * as api from './api.service.js';
import {
  getRunnerAgenticRun,
  reportRunnerAgenticRunProgressSafely,
} from './agentic-runs.service.js';
import {
  applyGitIdentity,
  checkoutRemoteBranch,
  cloneRepository,
  createBranchAt,
  fetchBranch,
  getDefaultBranch,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getMcpStartupGitIdentity,
  getRemoteBranchCommit,
  isRebaseInProgress,
} from './git.service.js';
import {
  acquireRunnerExecution,
  checkpointRunnerExecution,
  createRunnerWorkspaceState,
  getActiveRunnerExecution,
  registerRunnerWorkspace,
  runnerExecutionLocalPath,
  writeRunnerState,
} from './runner-execution.service.js';
import {
  createRecoveryWorkspaceInstructions,
  prepareRunnerTargetSynchronization,
  reconcileRunnerRecoveryWorkspace,
} from './runner-workspace-recovery.service.js';
import { assertCurrentRunnerBranch } from './runner-workspace-git.service.js';
import {
  assertAuthorizedRepositoryUrl,
  resolveProjectRepositoryUrl,
  withGitCredentials,
} from './runner-workspace-repository.service.js';
import {
  assertGitWorkspaceIdentity,
  assertRunnerWorkspacePath,
  ensureRunnerLayout,
  runnerWorkspaceExists,
} from './runner-workspace-store.service.js';
import {
  getChangeRequestDetails,
  validateRepositoryAccess,
} from './source-control.service.js';
import { resolveRunnerGitValues } from './runner-workspace-values.service.js';

export interface PrepareRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  repositoryUrl?: string;
  branch?: string;
  localPath?: string;
}
const preparations = new Map<string, Promise<RunnerWorkspacePrepareResult>>();
export function isRunnerWorkspacePreparationInProgress(
  runKey: string,
  projectName: string
) {
  return preparations.has(JSON.stringify([runKey, projectName]));
}
export function prepareRunnerWorkspace(
  options: PrepareRunnerWorkspaceOptions
): Promise<RunnerWorkspacePrepareResult> {
  const key = JSON.stringify([options.runKey, options.projectName]);
  const existing = preparations.get(key);
  if (existing) return existing;
  const result = prepare(options).finally(() => preparations.delete(key));
  preparations.set(key, result);
  return result;
}

async function prepare({
  runKey,
  projectName,
  repositoryUrl,
  branch,
  localPath: requestedLocalPath,
}: PrepareRunnerWorkspaceOptions): Promise<RunnerWorkspacePrepareResult> {
  // Assess provider facts before touching a retained checkout.
  const projectState = await api.refreshAgenticRunProjectState(
    runKey,
    projectName
  );
  const runResponse = await getRunnerAgenticRun(projectName, runKey);
  const run = runResponse.run;
  const project = { ...projectState.project, progress: projectState.progress };
  let continuation = getAgenticRunContinuationDecision(projectState);
  const result = {
    run,
    project,
    projectState,
    prompt: run.prompt ?? null,
    result: runResponse.result,
  };
  if (continuation.action !== 'continue') {
    return { ...result, continuation, instructions: continuation.instructions };
  }
  const retained = getActiveRunnerExecution(runKey, projectName);
  const resolvedUrl = resolveProjectRepositoryUrl(
    project,
    projectState.progress.repositoryUrl ??
      retained?.repositoryUrl ??
      repositoryUrl
  );
  const access = await api.getRepositoryAccess(resolvedUrl);
  const effectiveUrl = await getEffectiveRepositoryUrl(
    resolvedUrl,
    process.cwd()
  );
  assertAuthorizedRepositoryUrl(access, resolvedUrl, effectiveUrl);
  const repository = await validateRepositoryAccess(access, effectiveUrl);
  const mr = projectState.progress.mergeRequestUrl
    ? await getChangeRequestDetails(
        access,
        repository.repositoryId,
        projectState.progress.mergeRequestUrl
      )
    : null;
  const values = resolveRunnerGitValues(run, {
    branch:
      mr?.sourceBranch ??
      projectState.progress.branch ??
      retained?.branch ??
      branch,
  });
  if (mr?.state.toLowerCase() === 'merged' || mr?.rebaseInProgress) {
    continuation = workflowContinuation(
      mr.state.toLowerCase() === 'merged'
        ? {
            outcome: 'complete',
            reason: 'change_merged',
            instruction:
              'The change is already merged. Leave retained local work untouched.',
          }
        : {
            outcome: 'waiting',
            reason: 'waiting_for_provider_activity',
            instruction: 'The provider is rebasing this MR. Retry later.',
          },
      projectState
    );
    return { ...result, continuation, instructions: continuation.instructions };
  }

  const execution = await acquireRunnerExecution(
    {
      runKey,
      projectName,
      repositoryUrl: resolvedUrl,
      sourceControlProvider: access.provider,
      sourceControlRepositoryId: repository.repositoryId,
      branch: values.branchName,
      commitMessage: values.commitMessage,
    },
    requestedLocalPath
  );
  const layout = await ensureRunnerLayout();
  let localPath = runnerExecutionLocalPath(execution)!;
  const exists = await runnerWorkspaceExists(localPath);
  if (!exists)
    await withGitCredentials(access, localPath, (env) =>
      cloneRepository(effectiveUrl, localPath, path.dirname(localPath), env)
    );
  localPath = await assertRunnerWorkspacePath(layout.workspaces, localPath);
  await assertGitWorkspaceIdentity(localPath);
  assertAuthorizedRepositoryUrl(
    access,
    resolvedUrl,
    await getEffectiveRepositoryUrl('origin', localPath)
  );
  const headBeforeSynchronization = (await getHeadCommit(localPath)).sha;
  await registerRunnerWorkspace(execution.executionKey, localPath);
  await applyGitIdentity(await getMcpStartupGitIdentity(), localPath);
  const targetBranch =
    mr?.targetBranch ??
    execution.targetBranch ??
    (await getDefaultBranch(localPath));
  if (targetBranch === values.branchName)
    throw new Error(
      'The migration source branch must differ from the target branch.'
    );
  await withGitCredentials(access, localPath, (env) =>
    fetchBranch(effectiveUrl, targetBranch, localPath, env)
  );
  if (!exists) {
    if (await getRemoteBranchCommit(values.branchName, localPath))
      await checkoutRemoteBranch(values.branchName, localPath);
    else
      await createBranchAt(
        values.branchName,
        'refs/remotes/origin/' + targetBranch,
        localPath
      );
  }
  await checkpointRunnerExecution(execution, {
    checkName: run.checkName,
    targetBranch,
    preparedHeadSha: (await getHeadCommit(localPath)).sha,
  });
  const state = createRunnerWorkspaceState(execution, localPath, access);
  // Git's rebase state is sufficient to resume; a missing API checkpoint is irrelevant.
  if (await isRebaseInProgress(localPath)) {
    state.recovery ??= {
      kind: 'target_sync',
      phase: 'conflicts',
      mergeRequestUrl: mr?.url,
      sourceBranch: state.branch,
      targetBranch,
      sourceHeadSha:
        (await getRemoteBranchCommit(state.branch, localPath)) ?? undefined,
      targetHeadSha:
        (await getRemoteBranchCommit(targetBranch, localPath)) ?? '',
      attempt: 1,
      conflictFiles: [],
    };
    await reconcileRunnerRecoveryWorkspace(state, localPath);
  } else await assertCurrentRunnerBranch(state, localPath);
  await prepareRunnerTargetSynchronization(
    state,
    localPath,
    effectiveUrl,
    access,
    mr?.url,
    true
  );
  await writeRunnerState(state);
  const workspaceChanged =
    headBeforeSynchronization !== (await getHeadCommit(localPath)).sha;
  const progressReport = await reportRunnerAgenticRunProgressSafely(
    runKey,
    projectName,
    {
      status: 'in_progress',
      repositoryUrl: resolvedUrl,
      branch: state.branch,
      notes:
        'Prepared migration workspace from current Git and provider state.',
    }
  );
  return {
    ...result,
    continuation,
    workspace: state,
    workspaceCreated: !exists,
    workspaceChanged,
    progressReport,
    instructions: [
      ...(!exists
        ? [
            'Created a fresh checkout. Reapply the run prompt and checks; previous local runner work is disposable.',
          ]
        : []),
      'Work in ' +
        localPath +
        '. Apply the run prompt; resolve conflicts and pipeline failures, then run the relevant project checks.',
      ...(state.recovery
        ? createRecoveryWorkspaceInstructions(
            runKey,
            projectName,
            state
          ).filter((line) => !/heartbeat|lease|budget|10 minutes/i.test(line))
        : []),
      'Finalize this workspace to publish the branch and create or reuse an open MR. Only actionable work may proceed. No heartbeat or release is required.',
    ],
  };
}
