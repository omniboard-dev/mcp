import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runWorkspaceRecoveryIntegration(context: any) {
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
    writeRunnerState,
    prepared,
  } = context;

  const rejectingHook = path.join(remotePath, 'hooks', 'pre-receive');
  await fs.writeFile(rejectingHook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-icons',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix icon registry',
    }),
    /pre-receive hook declined/
  );
  assert.equal(state.runnerLeaseToken, null);
  assert.equal(state.runnerExecution.leaseOwner, null);
  assert.equal(state.runnerExecution.leaseExpiresAt, null);
  assert.equal(state.runnerExecution.heartbeatAt, null);
  await fs.rm(rejectingHook);

  const finalized = await finalizeRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
    localPath: prepared.workspace.localPath,
    mergeRequestTitle: 'Fix icon registry',
    mergeRequestDescription:
      '## Summary\\n- Update the icon registry.\\n\\n## Verification\\n- Tests passed.',
  });

  assert.match(finalized.commitSha, /^[a-f0-9]{40}$/);
  const commitIdentity = (
    await execFile(
      'git',
      ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', finalized.commitSha],
      { cwd: prepared.workspace.localPath }
    )
  ).stdout
    .trim()
    .split('\n');
  assert.deepEqual(commitIdentity, [
    'MCP Startup User',
    'startup@example.com',
    'MCP Startup User',
    'startup@example.com',
  ]);
  assert.equal(
    finalized.mergeRequest.url,
    'https://gitlab.example.com/group/project/-/merge_requests/3'
  );
  assert.equal(
    state.mergeRequestPayload.description,
    '## Summary\n- Update the icon registry.\n\n## Verification\n- Tests passed.'
  );
  const retried = await finalizeRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
    localPath: prepared.workspace.localPath,
    mergeRequestTitle: 'Fix icon registry',
    mergeRequestDescription:
      '## Summary\n- Update the icon registry.\n\n## Verification\n- Tests passed.',
  });
  assert.equal(retried.commitSha, finalized.commitSha);

  const recoveryProgressStart = progress.length;

  state.projectProgressStatus = 'blocked';
  state.projectMergeRequestUrl =
    'https://gitlab.example.com/group/project/-/merge_requests/3';
  state.projectMergeRequestState = 'opened';
  state.projectMergeRequestDetailedStatus = 'need_rebase';
  state.mergeRequestDetailedStatus = 'need_rebase';
  state.mergeRequestRebaseInProgress = false;
  const nativeRebasePreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(nativeRebasePreparation.continuation.action, 'wait');
  assert.equal(
    nativeRebasePreparation.continuation.reason,
    'automatic_rebase_requested'
  );
  assert.equal(nativeRebasePreparation.workspace, undefined);
  assert.equal(state.mergeRequestRebaseRequestCount, 1);
  assert.equal(progress.at(-1).status, 'in_progress');
  state.mergeRequestDetailedStatus = 'mergeable';
  state.mergeRequestRebaseInProgress = false;
  state.projectMergeRequestDetailedStatus = null;

  await execFile('git', ['fetch', 'origin'], { cwd: seedPath });
  await execFile(
    'git',
    ['checkout', '-B', 'agentic/run-icons', 'origin/agentic/run-icons'],
    { cwd: seedPath }
  );
  const sourceReadme = await fs.readFile(
    path.join(seedPath, 'README.md'),
    'utf8'
  );
  await fs.writeFile(
    path.join(seedPath, 'README.md'),
    sourceReadme.replace('# Runner test', '# Feature version')
  );
  await execFile('git', ['add', 'README.md'], { cwd: seedPath });
  await execFile('git', ['commit', '-m', 'Change feature heading'], {
    cwd: seedPath,
  });
  await execFile('git', ['push', 'origin', 'agentic/run-icons'], {
    cwd: seedPath,
  });
  await execFile('git', ['checkout', 'main'], { cwd: seedPath });
  await execFile('git', ['pull', '--ff-only', 'origin', 'main'], {
    cwd: seedPath,
  });
  const targetReadme = await fs.readFile(
    path.join(seedPath, 'README.md'),
    'utf8'
  );
  await fs.writeFile(
    path.join(seedPath, 'README.md'),
    targetReadme.replace('# Runner test', '# Main version')
  );
  await execFile('git', ['add', 'README.md'], { cwd: seedPath });
  await execFile('git', ['commit', '-m', 'Change main heading'], {
    cwd: seedPath,
  });
  await execFile('git', ['push', 'origin', 'main'], { cwd: seedPath });

  const sourceHeadBeforeRecovery = (
    await execFile('git', ['rev-parse', 'refs/heads/agentic/run-icons'], {
      cwd: remotePath,
    })
  ).stdout.trim();

  state.projectProgressStatus = 'blocked';
  state.projectMergeRequestDetailedStatus = 'conflict';
  state.mergeRequestDetailedStatus = null;
  const generationBeforeFailedRecovery = prepared.workspace.generation;
  const pathBeforeFailedRecovery = prepared.workspace.localPath;
  state.recoveryCheckpointFailures = 1;
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-icons',
      projectName: 'project-a',
    }),
    /Forced recovery checkpoint failure/
  );
  assert.equal(state.runnerExecution.recovery, null);
  const conflictPreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.notEqual(
    conflictPreparation.workspace.localPath,
    pathBeforeFailedRecovery
  );
  assert.equal(
    conflictPreparation.workspace.generation,
    generationBeforeFailedRecovery + 1
  );
  prepared.workspace = conflictPreparation.workspace;
  assert.equal(
    conflictPreparation.continuation.reason,
    'actionable_merge_block'
  );
  assert.equal(conflictPreparation.workspace.recovery.phase, 'conflicts');
  assert.deepEqual(conflictPreparation.workspace.recovery.conflictFiles, [
    'README.md',
  ]);
  assert(
    conflictPreparation.instructions.some((instruction) =>
      instruction.includes('README.md')
    )
  );

  state.projectProgressStatus = 'pending_retry';
  state.projectRetryInstructions = [
    {
      id: 1,
      instruction:
        'Keep the target heading and preserve the agentic branch body.',
      requestedFromStatus: 'blocked',
      requestedBy: { id: 7, firstname: 'Tomas', lastname: 'Trajan' },
      creationDate: '2026-08-20T08:00:00.000Z',
    },
  ];
  const guidedConflictPreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(
    guidedConflictPreparation.continuation.reason,
    'operator_retry_requested'
  );
  assert(
    guidedConflictPreparation.instructions.some((instruction) =>
      instruction.includes(
        'Keep the target heading and preserve the agentic branch body.'
      )
    )
  );
  state.projectProgressStatus = 'blocked';
  state.projectRetryInstructions = [];

  const resolveCurrentConflict = async () => {
    await fs.writeFile(
      path.join(prepared.workspace.localPath, 'README.md'),
      '# Resolved version\n\nUpdated by the runner.\n'
    );
    await execFile('git', ['add', 'README.md'], {
      cwd: prepared.workspace.localPath,
    });
  };

  state.mergeRequestTargetBranch = 'release';
  let changedRequestFinalization;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await resolveCurrentConflict();
    changedRequestFinalization = await finalizeRunnerWorkspace({
      runKey: 'run-icons',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix icon registry',
    });
    if (changedRequestFinalization.error) break;
    assert.deepEqual(changedRequestFinalization.conflictFiles, ['README.md']);
  }
  assert.match(changedRequestFinalization.error, /change request changed/);
  assert.equal(changedRequestFinalization.workspace.recovery, undefined);
  assert.equal(
    (
      await execFile('git', ['rev-parse', 'HEAD'], {
        cwd: prepared.workspace.localPath,
      })
    ).stdout.trim(),
    sourceHeadBeforeRecovery
  );
  assert.equal(
    (
      await execFile('git', ['rev-parse', 'refs/heads/agentic/run-icons'], {
        cwd: remotePath,
      })
    ).stdout.trim(),
    sourceHeadBeforeRecovery
  );

  state.mergeRequestTargetBranch = 'main';
  const restartedConflictPreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(restartedConflictPreparation.workspace.recovery.attempt, 1);
  assert.equal(
    restartedConflictPreparation.workspace.recovery.phase,
    'conflicts'
  );

  // Exhaust the provider GET retry budget so recovery after a persistent
  // lookup failure remains covered independently of transient retry coverage.
  state.mergeRequestLookupFailures = 3;
  let conflictFinalized;
  let lookupFailureObserved = false;
  let needsConflictResolution = true;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (needsConflictResolution) {
      await resolveCurrentConflict();
    }
    try {
      conflictFinalized = await finalizeRunnerWorkspace({
        runKey: 'run-icons',
        projectName: 'project-a',
        localPath: prepared.workspace.localPath,
        mergeRequestTitle: 'Fix icon registry',
      });
    } catch (error) {
      assert.match(String(error), /lookup failed with 503/);
      lookupFailureObserved = true;
      needsConflictResolution = false;
      assert.equal(
        (
          await execFile('git', ['rev-parse', 'refs/heads/agentic/run-icons'], {
            cwd: remotePath,
          })
        ).stdout.trim(),
        sourceHeadBeforeRecovery
      );
      continue;
    }
    if (conflictFinalized.completed) break;
    assert.deepEqual(conflictFinalized.conflictFiles, ['README.md']);
    needsConflictResolution = true;
  }
  assert.equal(lookupFailureObserved, true);
  assert.equal(conflictFinalized.completed, true);
  assert.equal(conflictFinalized.workspace.recovery, undefined);
  await execFile('git', ['fetch', 'origin'], { cwd: seedPath });
  let remoteFeatureHead = (
    await execFile('git', ['rev-parse', 'origin/agentic/run-icons'], {
      cwd: seedPath,
    })
  ).stdout.trim();
  let remoteMainHead = (
    await execFile('git', ['rev-parse', 'origin/main'], { cwd: seedPath })
  ).stdout.trim();
  await execFile(
    'git',
    ['merge-base', '--is-ancestor', remoteMainHead, remoteFeatureHead],
    { cwd: seedPath }
  );

  const exhaustedPreparation = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  const exhaustedRecoveryState = exhaustedPreparation.workspace;
  exhaustedRecoveryState.recovery = {
    kind: 'rebase',
    phase: 'ready_to_push',
    mergeRequestUrl:
      'https://gitlab.example.com/group/project/-/merge_requests/3',
    sourceBranch: 'agentic/run-icons',
    targetBranch: 'main',
    sourceHeadSha: remoteFeatureHead,
    targetHeadSha: remoteMainHead,
    attempt: 3,
    conflictFiles: [],
  };
  await writeRunnerState(exhaustedRecoveryState);

  await execFile('git', ['checkout', 'main'], { cwd: seedPath });
  await execFile('git', ['pull', '--ff-only', 'origin', 'main'], {
    cwd: seedPath,
  });
  await fs.writeFile(path.join(seedPath, 'target-advance.txt'), 'advanced\n');
  await commitForTest(seedPath, 'Advance target during recovery');
  await execFile('git', ['push', 'origin', 'main'], { cwd: seedPath });
  remoteMainHead = (
    await execFile('git', ['rev-parse', 'refs/heads/main'], { cwd: remotePath })
  ).stdout.trim();

  const exhaustedFinalization = await finalizeRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
    localPath: prepared.workspace.localPath,
  });
  assert.equal(exhaustedFinalization.completed, false);
  assert.match(exhaustedFinalization.error, /retry limit reached/);
  assert.equal(exhaustedFinalization.workspace.recovery, undefined);
  assert.equal(
    (
      await execFile('git', ['rev-parse', 'HEAD'], {
        cwd: prepared.workspace.localPath,
      })
    ).stdout.trim(),
    remoteFeatureHead
  );

  const restartedExhaustedRecovery = await prepareRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
  });
  assert.equal(restartedExhaustedRecovery.workspace.recovery.attempt, 1);
  assert.equal(
    restartedExhaustedRecovery.workspace.recovery.targetHeadSha,
    remoteMainHead
  );
  const completedExhaustedRecovery = await finalizeRunnerWorkspace({
    runKey: 'run-icons',
    projectName: 'project-a',
    localPath: prepared.workspace.localPath,
  });
  assert.equal(completedExhaustedRecovery.completed, true);

  await execFile('git', ['fetch', 'origin'], { cwd: seedPath });
  remoteFeatureHead = (
    await execFile('git', ['rev-parse', 'origin/agentic/run-icons'], {
      cwd: seedPath,
    })
  ).stdout.trim();
  await execFile(
    'git',
    ['merge-base', '--is-ancestor', remoteMainHead, remoteFeatureHead],
    { cwd: seedPath }
  );

  state.mergeRequestDetailedStatus = 'mergeable';
  state.projectMergeRequestDetailedStatus = null;

  const recoveryReports = progress.slice(recoveryProgressStart);
  const providerRebaseReport = recoveryReports[0];
  assert.equal(providerRebaseReport.status, 'in_progress');
  assert(
    recoveryReports.some(
      (report) =>
        report.status === 'blocked' &&
        report.metadata?.mcpTool ===
          'omniboard_runner_prepare_agentic_run_workspace'
    )
  );
  assert(
    recoveryReports.some(
      (report) => report.metadata?.remediationPhase === 'conflicts'
    )
  );
  assert(
    recoveryReports.some((report) =>
      report.error?.includes('change request changed')
    )
  );
  assert(
    recoveryReports.some((report) =>
      report.error?.includes('retry limit reached')
    )
  );
  assert(recoveryReports.some((report) => report.status === 'pushed'));
}
