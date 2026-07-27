import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runAgenticRunIntegration(context: any) {
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
    stateFileName,
  } = context;

  const baseRun = {
    runKey: 'run-fallback',
    checkName: 'uxf-icon-registry',
    isActive: true,
  };
  assert.deepEqual(
    resolveRunnerGitValues(
      {
        ...baseRun,
        branchName: 'feature/OB-123-definition',
        commitMessage: 'fix(OB-123): definition values',
      },
      { branch: 'feature/OB-123-explicit' }
    ),
    {
      branchName: 'feature/OB-123-explicit',
      commitMessage: 'fix(OB-123): definition values',
    }
  );
  assert.deepEqual(
    resolveRunnerGitValues({
      ...baseRun,
      prompt:
        '### Branch name: `feature/OB-456-from-prompt`\n- **Commit message:** "fix(OB-456): from prompt"',
    }),
    {
      branchName: 'feature/OB-456-from-prompt',
      commitMessage: 'fix(OB-456): from prompt',
    }
  );
  const emptyPromptGitValues = resolveRunnerGitValues({
    ...baseRun,
    prompt: 'Branch name: ""\nCommit message: ""',
  });
  assert.match(
    emptyPromptGitValues.branchName,
    /^agentic\/run-fallback-[a-z0-9]+$/
  );
  assert.equal(
    emptyPromptGitValues.commitMessage,
    'chore: complete agentic run run-fallback'
  );
  const defaultGitValues = resolveRunnerGitValues(baseRun);
  assert.match(
    defaultGitValues.branchName,
    /^agentic\/run-fallback-[a-z0-9]+$/
  );
  assert.equal(
    defaultGitValues.commitMessage,
    'chore: complete agentic run run-fallback'
  );
  const {
    createAgenticRunAgentContext,
    getAgenticRun,
    reportAgenticRunProgress,
    reportRunnerAgenticRunProgress,
  } = await import('../../../dist/services/agentic-runs.service.js');
  const { validateAgenticRun } = await import(
    '../../../dist/services/analyzer-validation.service.js'
  );
  const { getAgenticRunContinuationDecision } = await import(
    '../../../dist/services/agentic-run-continuation.service.js'
  );

  const activeAgentContext = createAgenticRunAgentContext(baseRun);
  assert(
    activeAgentContext.instructions.some(
      (instruction) =>
        instruction.includes('false positive') &&
        instruction.includes('resolution "dismissed"')
    )
  );

  const continuationDecision = (
    status,
    mergeRequestDetailedStatus = null,
    resolution = null,
    providerSyncSuccess = true
  ) =>
    getAgenticRunContinuationDecision({
      run: {
        runKey: 'run-uxf',
        checkName: 'uxf-icon-registry',
        status: 'active',
        isActive: true,
      },
      project: {
        id: 1,
        name: 'project-a',
        currentlyMatchesCheck: true,
      },
      progress: { status, mergeRequestDetailedStatus, resolution },
      providerSync: {
        attempted: false,
        success: providerSyncSuccess,
        diagnostics: [],
      },
    });
  for (const status of [
    'pending',
    'in_progress',
    'implemented',
    'verified',
    'committed',
    'pushed',
  ]) {
    assert.equal(continuationDecision(status).action, 'continue');
    assert.equal(continuationDecision(status).reason, 'active_work');
  }
  assert.equal(continuationDecision('failed').reason, 'retry_failed_work');
  assert.deepEqual(
    [
      ['needs_input', 'requested_changes'],
      ['blocked', 'conflict'],
    ].map(([status, detail]) => {
      const decision = continuationDecision(status, detail);
      return [decision.action, decision.reason];
    }),
    [
      ['continue', 'actionable_review_feedback'],
      ['continue', 'actionable_merge_block'],
    ]
  );
  for (const status of ['needs_input', 'blocked', 'mr_created']) {
    assert.equal(continuationDecision(status).action, 'wait');
    assert.equal(
      continuationDecision(status).reason,
      'waiting_for_provider_activity'
    );
  }
  assert.deepEqual(
    [
      continuationDecision('done', null, 'merged'),
      continuationDecision('done', null, 'dismissed'),
      continuationDecision('done'),
      continuationDecision('done', null, 'dismissed', false),
      continuationDecision('merged'),
    ].map(({ action, reason }) => [action, reason]),
    [
      ['stop', 'change_merged'],
      ['stop', 'change_dismissed'],
      ['stop', 'change_completed'],
      ['stop', 'change_dismissed'],
      ['stop', 'change_merged'],
    ]
  );
  const {
    createChangeRequest,
    resolveGitUsername,
    retryFailedPipeline,
    validateRepositoryAccess,
  } = await import('../../../dist/services/source-control.service.js');

  const insecurePreparation = prepareRunnerWorkspace({
    runKey: 'run-uxf',
    projectName: 'project-a',
  });
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      branch: 'agentic/concurrent-override',
    }),
    /already in progress.*different repository or branch options/
  );
  await assert.rejects(insecurePreparation, /secure HTTPS/);
  process.env.OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS = 'true';

  const bitbucketAccess = {
    provider: 'bitbucket_data_center',
    host: 'bitbucket.example.com',
    apiBaseUrl: `http://127.0.0.1:${
      server.address().port
    }/bitbucket/rest/api/latest`,
    username: 'omniboard-service',
    token: 'bitbucket-token',
  };
  const bitbucketRepository = await validateRepositoryAccess(
    bitbucketAccess,
    'https://bitbucket.example.com/scm/OB/project-a.git'
  );
  assert.equal(bitbucketRepository.repositoryId, 'OB/project-a');
  assert.equal(resolveGitUsername(bitbucketAccess), 'omniboard-service');
  assert.deepEqual(
    await retryFailedPipeline(
      bitbucketAccess,
      'https://bitbucket.example.com/scm/OB/project-a.git',
      'https://ci.example.com/builds/17'
    ),
    {
      supported: false,
      reason:
        'Bitbucket Data Center does not expose a standard repository pipeline retry API.',
    }
  );
  const bitbucketPullRequest = await createChangeRequest(
    bitbucketAccess,
    bitbucketRepository.repositoryId,
    'agentic/run-uxf',
    'main',
    'Fix UXF icon registry',
    '## Summary\\n- Automated test change.\\n\\n## Verification\\n- Passed.'
  );
  assert.equal(bitbucketPullRequest.id, 17);
  assert.equal(
    bitbucketPullRequest.url,
    'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17'
  );
  assert.equal(
    state.bitbucketAuthorization,
    `Basic ${Buffer.from('omniboard-service:bitbucket-token').toString(
      'base64'
    )}`
  );
  assert.deepEqual(state.bitbucketPullRequestPayload.fromRef, {
    id: 'refs/heads/agentic/run-uxf',
    repository: {
      slug: 'project-a',
      project: { key: 'OB' },
    },
  });
  assert.deepEqual(state.bitbucketPullRequestPayload.toRef, {
    id: 'refs/heads/main',
    repository: {
      slug: 'project-a',
      project: { key: 'OB' },
    },
  });
  assert.equal(
    state.bitbucketPullRequestPayload.description,
    '## Summary\n- Automated test change.\n\n## Verification\n- Passed.'
  );
  const retriedBitbucketPullRequest = await createChangeRequest(
    bitbucketAccess,
    bitbucketRepository.repositoryId,
    'agentic/run-uxf',
    'main',
    'Fix UXF icon registry',
    'Use `\\n` when documenting escaped line breaks.'
  );
  assert.equal(retriedBitbucketPullRequest.id, 17);
  assert.equal(
    retriedBitbucketPullRequest.url,
    'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17'
  );
  assert.equal(state.bitbucketPullRequestCreateCount, 2);
  assert.equal(state.bitbucketPullRequestLookupCount, 2);
  assert.equal(
    state.bitbucketPullRequestPayload.description,
    'Use `\\n` when documenting escaped line breaks.'
  );

  await reportRunnerAgenticRunProgress('run-uxf', 'project-a', {
    status: 'done',
    resolution: 'dismissed',
    resolutionReason: 'false_positive',
    localPath: '/runner/project-a',
    metadata: { executionMode: 'caller-controlled' },
  });
  const callerControlledProgress = progress.at(-1);
  assert.equal(
    callerControlledProgress.metadata.executionMode,
    'dedicated-runner'
  );
  assert.equal(callerControlledProgress.localPath, '/runner/project-a');
  assert.equal(callerControlledProgress.status, 'done');
  assert.equal(callerControlledProgress.resolution, 'dismissed');
  assert.equal(callerControlledProgress.resolutionReason, 'false_positive');
  assert.equal('pipelineStatus' in callerControlledProgress, false);
  assert.equal('mergeRequestUrl' in callerControlledProgress, false);

  await assert.rejects(
    reportRunnerAgenticRunProgress('run-uxf', 'project-a', {
      status: 'done',
    }),
    /done agentic run progress report requires a resolution/
  );
  await assert.rejects(
    reportRunnerAgenticRunProgress('run-uxf', 'project-a', {
      status: 'in_progress',
      resolution: 'dismissed',
    }),
    /resolution can only be reported with status "done"/
  );

  await reportAgenticRunProgress('run-uxf', { status: 'in_progress' });
  assert.equal(progress.at(-1).localPath, root);
  progress.length = 0;
}
