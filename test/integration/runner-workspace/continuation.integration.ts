import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runPostMergeRequestContinuationIntegration(context: any) {
  const {
    root,
    remotePath,
    seedPath,
    registeredFileRepositoryUrl,
    tokenLeakPath,
    serverSecretLeakPath,
    ambientSecretLeakPath,
    runnerRoot,
    progress,
    repositoryAccessRequests,
    state,
    server,
    execFile,
    commitForTest,
    normalizeProjectPath,
    pathToFileUrl,
    prepareRunnerWorkspace,
    finalizeRunnerWorkspace,
    resolveRunnerGitValues,
    prepared,
  } = context;

  const { getAgenticRun } = await import(
    '../../../dist/services/agentic-runs.service.js'
  );
  const { validateAgenticRun } = await import(
    '../../../dist/services/analyzer-validation.service.js'
  );

  state.projectProgressStatus = 'failed';
  state.projectPipelineStatus = 'failed';
  state.projectMergeRequestUrl =
    'https://gitlab.example.com/group/project/-/merge_requests/3';
  state.projectMergeRequestState = 'opened';
  const failedPipelineContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(
    failedPipelineContinuation.projectState.progress.status,
    'failed'
  );
  assert.equal(failedPipelineContinuation.continuation.action, 'continue');
  assert.equal(
    failedPipelineContinuation.continuation.reason,
    'application_pipeline_failure'
  );
  assert.equal(
    failedPipelineContinuation.workspace.localPath,
    prepared.workspace.localPath
  );
  assert(
    failedPipelineContinuation.instructions.some((instruction) =>
      instruction.includes('Expected true, received false')
    )
  );

  state.projectPipelineFailureReason = 'runner_system_failure';
  state.projectPipelineUrl =
    'https://gitlab.example.com/group/project/-/pipelines/321';
  const pipelineRetriesBeforeInfrastructureWait = state.pipelineRetryCount;
  const matchedLookupsBeforeInfrastructureWait =
    state.matchedProjectsLookupCount;
  const runLookupsBeforeInfrastructureWait = state.agenticRunLookupCount;
  const infrastructureFailureContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(infrastructureFailureContinuation.continuation.action, 'wait');
  assert.equal(
    infrastructureFailureContinuation.continuation.reason,
    'infrastructure_pipeline_failure'
  );
  assert.equal(infrastructureFailureContinuation.workspace, undefined);
  assert.equal(
    infrastructureFailureContinuation.continuation.pipelineRetry.retried,
    true
  );
  assert.equal(
    infrastructureFailureContinuation.continuation.pipelineRetry.status,
    'pending'
  );
  assert.equal(
    state.pipelineRetryCount,
    pipelineRetriesBeforeInfrastructureWait + 1
  );
  assert(
    infrastructureFailureContinuation.instructions.some((instruction) =>
      instruction.includes('retry was requested successfully')
    )
  );
  assert.equal(
    state.matchedProjectsLookupCount,
    matchedLookupsBeforeInfrastructureWait
  );
  assert.equal(state.agenticRunLookupCount, runLookupsBeforeInfrastructureWait);
  state.projectPipelineFailureReason = 'script_failure';
  state.projectPipelineUrl = null;

  const matchedLookupsBeforeProviderWait = state.matchedProjectsLookupCount;
  const runLookupsBeforeProviderWait = state.agenticRunLookupCount;
  state.providerSyncSuccess = false;
  const providerFailureContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(providerFailureContinuation.continuation.action, 'wait');
  assert.equal(
    providerFailureContinuation.continuation.reason,
    'provider_sync_failed'
  );
  assert.equal(providerFailureContinuation.workspace, undefined);
  assert.equal(
    state.matchedProjectsLookupCount,
    matchedLookupsBeforeProviderWait
  );
  assert.equal(state.agenticRunLookupCount, runLookupsBeforeProviderWait);
  state.providerSyncSuccess = true;

  const providerSnapshotsBeforeBitbucketFallback =
    state.bitbucketProviderSnapshotCount;
  state.repositoryAccessProvider = 'bitbucket_data_center';
  state.projectRepositoryUrls = [
    'https://bitbucket.example.com/scm/OB/project-a.git',
  ];
  state.projectProgressStatus = 'failed';
  state.projectProgressResolution = null;
  state.projectMergeRequestUrl =
    'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17';
  state.projectMergeRequestState = 'open';
  state.projectMergeRequestDetailedStatus = null;
  state.bitbucketPullRequestState = 'MERGED';
  state.bitbucketBuildStatuses = [
    {
      key: 'unit-tests',
      name: 'Unit tests',
      state: 'FAILED',
      url: 'https://ci.example.com/build/17',
    },
  ];
  state.providerSyncSuccess = false;
  state.bitbucketPullRequestLookupFailures = 1;
  const failedLocalFallbackContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(failedLocalFallbackContinuation.continuation.action, 'wait');
  assert.equal(
    failedLocalFallbackContinuation.continuation.reason,
    'provider_sync_failed'
  );
  assert.equal(
    state.bitbucketProviderSnapshotCount,
    providerSnapshotsBeforeBitbucketFallback
  );

  const bitbucketFallbackContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(
    state.bitbucketProviderSnapshotCount,
    providerSnapshotsBeforeBitbucketFallback + 1
  );
  assert.equal(
    bitbucketFallbackContinuation.projectState.providerSync.success,
    true
  );
  assert.equal(
    bitbucketFallbackContinuation.projectState.progress.status,
    'done'
  );
  assert.equal(
    bitbucketFallbackContinuation.projectState.progress
      .pipelineFailureDiagnostics?.jobs[0]?.name,
    'Unit tests'
  );
  assert.equal(
    bitbucketFallbackContinuation.projectState.progress
      .pipelineFailureDiagnostics?.lastAttemptError,
    null
  );
  assert.equal(bitbucketFallbackContinuation.continuation.action, 'stop');
  assert.equal(
    bitbucketFallbackContinuation.continuation.reason,
    'change_merged'
  );
  assert.equal(bitbucketFallbackContinuation.workspace, undefined);

  state.repositoryAccessProvider = 'gitlab';
  state.projectRepositoryUrls = [registeredFileRepositoryUrl];
  state.projectMergeRequestUrl =
    'https://gitlab.example.com/group/project/-/merge_requests/3';
  state.bitbucketPullRequestState = 'OPEN';
  state.providerSyncSuccess = true;

  state.projectProgressStatus = 'future_status';
  state.projectPipelineStatus = null;
  const unsupportedStatusContinuation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(unsupportedStatusContinuation.continuation.action, 'wait');
  assert.equal(
    unsupportedStatusContinuation.continuation.reason,
    'unsupported_progress_status'
  );
  assert.equal(unsupportedStatusContinuation.workspace, undefined);

  state.projectProgressStatus = 'merged';
  state.projectPipelineStatus = 'success';
  state.projectMergeRequestState = 'merged';
  const matchedLookupsBeforeMergedStop = state.matchedProjectsLookupCount;
  const runLookupsBeforeMergedStop = state.agenticRunLookupCount;
  const mergeRequestCreateCountBeforeStoppedFinalize =
    state.mergeRequestCreateCount;
  const progressCountBeforeStoppedFinalize = progress.length;
  const stateVersionBeforeStoppedFinalize = state.runnerExecution.stateVersion;
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-icons',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix icon registry',
    }),
    /finalization is not permitted.*"stop".*change_merged/
  );
  assert.equal(state.runnerExecution.phase, 'completed');
  assert.equal(
    state.runnerExecution.stateVersion,
    stateVersionBeforeStoppedFinalize + 1
  );
  assert.equal(state.runnerLeaseToken, null);
  assert.equal(state.runnerExecution.leaseOwner, null);
  assert.equal(state.runnerExecution.leaseExpiresAt, null);
  assert.equal(state.runnerExecution.heartbeatAt, null);
  assert.equal(state.runnerCompletionByIdentityPhases.at(-1), 'completed');
  assert.equal(
    state.mergeRequestCreateCount,
    mergeRequestCreateCountBeforeStoppedFinalize
  );
  assert.equal(progress.length, progressCountBeforeStoppedFinalize);

  const mergedPreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(mergedPreparation.projectState.progress.status, 'merged');
  assert.equal(mergedPreparation.continuation.action, 'stop');
  assert.equal(mergedPreparation.workspace, undefined);
  assert.equal(
    state.matchedProjectsLookupCount,
    matchedLookupsBeforeMergedStop
  );
  assert.equal(state.agenticRunLookupCount, runLookupsBeforeMergedStop);

  state.projectProgressStatus = 'done';
  state.projectProgressResolution = 'dismissed';
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-icons',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
    }),
    /finalization is not permitted.*"stop".*change_dismissed/
  );
  assert.equal(state.runnerExecution.phase, 'abandoned');
  assert.equal(state.runnerCompletionByIdentityPhases.at(-1), 'abandoned');
  state.projectProgressStatus = 'merged';
  state.projectProgressResolution = null;

  const progressCountBeforeLocalStop = progress.length;
  const runLookupsBeforeLocalStop = state.agenticRunLookupCount;
  const localMergedRun = await getAgenticRun('run-icons');
  assert.equal(localMergedRun.continuation.action, 'stop');
  assert.deepEqual(
    localMergedRun.agentContext.instructions,
    mergedPreparation.instructions
  );
  assert.equal(localMergedRun.agentContext.validation.allowed, false);
  assert.equal(state.agenticRunLookupCount, runLookupsBeforeLocalStop);
  assert.equal(progress.length, progressCountBeforeLocalStop);

  const skippedMergedValidation = await validateAgenticRun('run-icons');
  assert.equal(skippedMergedValidation.skipped, true);
  assert.equal(skippedMergedValidation.continuation.action, 'stop');
  assert.equal(skippedMergedValidation.progressReport, undefined);
  assert.equal(progress.length, progressCountBeforeLocalStop);

  const runLookupCountBeforeNoMatch = state.agenticRunLookupCount;
  const progressCountBeforeNoMatch = progress.length;
  state.projectMatchesCheck = false;
  state.projectFulfillment = 'unfulfilled';
  const localNoMatchRun = await getAgenticRun('run-icons');
  assert.equal(localNoMatchRun.continuation.action, 'stop');
  assert.equal(localNoMatchRun.continuation.reason, 'change_merged');
  assert.equal(state.agenticRunLookupCount, runLookupCountBeforeNoMatch);
  assert.equal(progress.length, progressCountBeforeNoMatch);
  state.projectMatchesCheck = true;
  state.projectFulfillment = 'fulfilled';

  await assert.rejects(fs.access(tokenLeakPath));
  await assert.rejects(fs.access(serverSecretLeakPath));
  if (process.platform !== 'win32') {
    assert.equal(await fs.readFile(ambientSecretLeakPath, 'utf8'), 'unset');
  }

  assert.equal(state.mergeRequestCreateCount, 2);
  assert.equal(state.mergeRequestLookupCount, 1);
  await assert.rejects(fs.access(path.join(runnerRoot, 'state')));
  assert.equal(state.mergeRequestPayload.source_branch, 'agentic/run-icons');
  assert.equal(state.mergeRequestPayload.target_branch, 'main');
  assert.equal(progress.at(-1).status, 'in_progress');
  const { stdout } = await execFile(
    'git',
    ['show-ref', '--verify', 'refs/heads/agentic/run-icons'],
    { cwd: remotePath }
  );
  assert.match(stdout, /^[a-f0-9]{40}/);

  state.projectMatchesCheck = false;
  state.projectFulfillment = 'unfulfilled';
  state.projectProgressStatus = 'pending_retry';
  state.projectProgressResolution = null;
  state.projectRetryInstructions = [
    {
      id: 2,
      instruction: 'Retry only if the check still matches.',
      requestedFromStatus: 'failed',
      requestedBy: { id: 7, firstname: 'Tomas', lastname: 'Trajan' },
      creationDate: '2026-08-20T09:00:00.000Z',
    },
  ];
  const progressCountBeforeUnfulfilledRetry = progress.length;
  const unfulfilledRetry = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert(unfulfilledRetry.workspace);
  assert.equal(
    unfulfilledRetry.continuation.reason,
    'operator_retry_requested'
  );
  assert(
    unfulfilledRetry.instructions.some((instruction) =>
      instruction.includes('current agentic check result is unfulfilled')
    )
  );
  assert.equal(progress.length, progressCountBeforeUnfulfilledRetry + 1);
  assert.equal(progress.at(-1).status, 'in_progress');
}
