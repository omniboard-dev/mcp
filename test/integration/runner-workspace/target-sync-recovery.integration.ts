import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runTargetSyncRecoveryIntegration(context: any) {
  const {
    state,
    seedPath,
    remotePath,
    runnerRoot,
    execFile,
    commitForTest,
    prepareRunnerWorkspace,
    finalizeRunnerWorkspace,
  } = context;
  const { releaseRunnerExecution } = await import(
    '../../../dist/services/runner-execution.service.js'
  );
  const options = { runKey: 'run-icons', projectName: 'project-a' };
  const git = async (cwd: string, ...args: string[]) =>
    (await execFile('git', args, { cwd })).stdout.trim();
  let scenario = 0;

  async function advanceTarget() {
    await git(seedPath, 'checkout', 'main');
    await git(seedPath, 'pull', '--ff-only', 'origin', 'main');
    await fs.appendFile(path.join(seedPath, 'sync-target.txt'), 'advance\n');
    await commitForTest(seedPath, 'Advance target during synchronization');
    await git(seedPath, 'push', 'origin', 'main');
    return git(seedPath, 'rev-parse', 'HEAD');
  }

  async function setup(dirty = true, conflict = false, staleAtClone = false) {
    if (state.runnerExecution) {
      await releaseRunnerExecution(state.runnerExecution.executionKey);
    }
    // Each scenario owns disposable checkouts in the integration test root.
    await fs.rm(path.join(runnerRoot, 'workspaces'), {
      recursive: true,
      force: true,
    });
    Object.assign(state, {
      runnerExecution: null,
      projectProgressMetadata: null,
      failLookupAfterPush: false,
      mergeRequestLookupFailures: 0,
      projectProgressStatus: 'in_progress',
      projectProgressResolution: null,
      projectMatchesCheck: true,
      projectFulfillment: 'fulfilled',
      projectRetryInstructions: [],
      projectPipelineStatus: null,
      projectMergeRequestUrl:
        'https://gitlab.example.com/group/project/-/merge_requests/3',
      projectMergeRequestState: 'opened',
      projectMergeRequestDetailedStatus: null,
      mergeRequestDetailedStatus: 'mergeable',
      mergeRequestTargetBranch: 'main',
      recoveryCheckpointFailures: 0,
      recoveryCheckpointSkip: 0,
      pushedCheckpointFailures: 0,
      mergeRequestSourceHeadSha: undefined,
    });
    scenario += 1;
    await git(seedPath, 'fetch', 'origin');
    await git(seedPath, 'checkout', '-B', 'agentic/run-icons', 'origin/main');
    await fs.writeFile(
      path.join(seedPath, 'sync-feature.txt'),
      `${scenario}\n`
    );
    if (conflict) {
      await fs.writeFile(
        path.join(seedPath, 'sync-config.txt'),
        'registry=migrated\n'
      );
    }
    await commitForTest(seedPath, 'Feature before target synchronization');
    await git(seedPath, 'push', '--force', 'origin', 'agentic/run-icons');
    if (staleAtClone) await advanceTarget();
    const prepared = await prepareRunnerWorkspace(options);
    const workspace = prepared.workspace;
    if (dirty) {
      await fs.appendFile(
        path.join(workspace.localPath, 'README.md'),
        'retained edit\n'
      );
      await fs.writeFile(
        path.join(workspace.localPath, 'sync-staged.txt'),
        'staged\n'
      );
      await git(workspace.localPath, 'add', 'sync-staged.txt');
      await fs.writeFile(
        path.join(workspace.localPath, 'sync-untracked.txt'),
        'untracked\n'
      );
    }
    const status = await git(workspace.localPath, 'status', '--porcelain');
    const readme = await fs.readFile(
      path.join(workspace.localPath, 'README.md'),
      'utf8'
    );
    await advanceTarget();
    if (conflict) {
      await fs.writeFile(
        path.join(seedPath, 'sync-config.txt'),
        'registry=upstream\n'
      );
      await commitForTest(seedPath, 'Change upstream registry configuration');
      await git(seedPath, 'push', 'origin', 'main');
    }
    return { workspace, status, readme };
  }

  async function assertRetainedWork(
    fixture: Awaited<ReturnType<typeof setup>>
  ) {
    assert.equal(
      await git(fixture.workspace.localPath, 'status', '--porcelain'),
      fixture.status
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.workspace.localPath, 'README.md'),
        'utf8'
      ),
      fixture.readme
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.workspace.localPath, 'sync-staged.txt'),
        'utf8'
      ),
      'staged\n'
    );
    assert.equal(
      await fs.readFile(
        path.join(fixture.workspace.localPath, 'sync-untracked.txt'),
        'utf8'
      ),
      'untracked\n'
    );
  }

  // A workspace prepared while current must still catch up at finalization.
  const initiallyCurrent = await setup();
  assert.equal(initiallyCurrent.workspace.recovery, undefined);
  const finalTarget = await git(remotePath, 'rev-parse', 'refs/heads/main');
  const caughtUp = await finalizeRunnerWorkspace({
    ...options,
    localPath: initiallyCurrent.workspace.localPath,
  });
  assert.equal(caughtUp.completed, true);
  await git(
    remotePath,
    'merge-base',
    '--is-ancestor',
    finalTarget,
    'refs/heads/agentic/run-icons'
  );
  assert.equal(
    await git(
      remotePath,
      'show',
      'refs/heads/agentic/run-icons:sync-untracked.txt'
    ),
    'untracked'
  );

  const needsRebase = await setup(false);
  state.projectProgressStatus = 'blocked';
  state.projectMergeRequestDetailedStatus = 'need_rebase';
  state.mergeRequestDetailedStatus = 'need_rebase';
  const nativeRequests = state.mergeRequestRebaseRequestCount;
  const localRebase = await prepareRunnerWorkspace(options);
  assert.equal(localRebase.continuation.action, 'continue');
  assert.equal(
    localRebase.workspace.localPath,
    needsRebase.workspace.localPath
  );
  assert.equal(localRebase.workspace.recovery.kind, 'target_sync');
  assert.equal(localRebase.workspace.recovery.phase, 'ready_to_push');
  assert.equal(state.mergeRequestRebaseRequestCount, nativeRequests);

  const changedRequest = await setup();
  const synchronized = await prepareRunnerWorkspace(options);
  const synchronizedHead = await git(
    synchronized.workspace.localPath,
    'rev-parse',
    'HEAD'
  );
  state.mergeRequestTargetBranch = 'release';
  const blocked = await finalizeRunnerWorkspace({
    ...options,
    localPath: synchronized.workspace.localPath,
  });
  assert.match(blocked.error, /change request changed/);
  assert.equal(
    await git(synchronized.workspace.localPath, 'rev-parse', 'HEAD'),
    synchronizedHead
  );
  assert.equal(blocked.workspace.recovery.kind, 'target_sync');
  await assertRetainedWork(changedRequest);

  for (const dirty of [true, false]) {
    const retry = await setup(dirty);
    const prepared = await prepareRunnerWorkspace(options);
    const sourceHead = prepared.workspace.recovery.sourceHeadSha;
    const hook = path.join(remotePath, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    try {
      await assert.rejects(
        finalizeRunnerWorkspace({
          ...options,
          localPath: retry.workspace.localPath,
        }),
        /pre-receive hook declined/
      );
    } finally {
      await fs.rm(hook);
    }
    assert.equal(state.runnerExecution.recovery.sourceHeadSha, sourceHead);
    const committedHead = await git(
      retry.workspace.localPath,
      'rev-parse',
      'HEAD'
    );
    const result = await finalizeRunnerWorkspace({
      ...options,
      localPath: retry.workspace.localPath,
    });
    assert.equal(result.completed, true);
    assert.equal(result.commitSha, committedHead);
    assert.equal(
      await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
      committedHead
    );
    assert.equal(state.runnerExecution.recovery, null);
  }

  const published = await setup();
  await prepareRunnerWorkspace(options);
  state.pushedCheckpointFailures = 1;
  await assert.rejects(
    finalizeRunnerWorkspace({
      ...options,
      localPath: published.workspace.localPath,
    }),
    /Forced pushed checkpoint failure/
  );
  const publishedHead = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  assert.equal(publishedHead, state.runnerExecution.commitSha);
  state.mergeRequestSourceHeadSha = publishedHead;
  const publicationRetry = await finalizeRunnerWorkspace({
    ...options,
    localPath: published.workspace.localPath,
  });
  assert.equal(publicationRetry.completed, true);
  assert.equal(publicationRetry.commitSha, publishedHead);

  const providerRetry = await setup(false);
  await prepareRunnerWorkspace(options);
  state.failLookupAfterPush = true;
  await assert.rejects(
    finalizeRunnerWorkspace({
      ...options,
      localPath: providerRetry.workspace.localPath,
    })
  );
  assert.equal(state.runnerExecution.phase, 'pushed');
  const alreadyPublished = state.runnerExecution.commitSha;
  const providerResumed = await finalizeRunnerWorkspace({
    ...options,
    localPath: providerRetry.workspace.localPath,
  });
  assert.equal(providerResumed.completed, true);
  assert.equal(providerResumed.commitSha, alreadyPublished);

  const freshClone = await setup(false, false, true);
  assert.equal(
    await git(
      freshClone.workspace.localPath,
      'show',
      '-s',
      '--format=%cn%n%ce',
      'HEAD'
    ),
    'MCP Startup User\nstartup@example.com'
  );

  const concurrent = await setup();
  const beforeConcurrentSource = await prepareRunnerWorkspace(options);
  const localHead = await git(
    concurrent.workspace.localPath,
    'rev-parse',
    'HEAD'
  );
  await git(seedPath, 'checkout', 'agentic/run-icons');
  await fs.writeFile(
    path.join(seedPath, 'concurrent-source.txt'),
    'another contributor\n'
  );
  await commitForTest(seedPath, 'Advance source concurrently');
  await git(seedPath, 'push', 'origin', 'agentic/run-icons');
  const concurrentHead = await git(seedPath, 'rev-parse', 'HEAD');
  await assert.rejects(
    finalizeRunnerWorkspace({
      ...options,
      localPath: concurrent.workspace.localPath,
    }),
    /source branch advanced/
  );
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    concurrentHead
  );
  assert.equal(
    await git(concurrent.workspace.localPath, 'rev-parse', 'HEAD'),
    localHead
  );
  assert.equal(
    state.runnerExecution.recovery.sourceHeadSha,
    beforeConcurrentSource.workspace.recovery.sourceHeadSha
  );
  await assertRetainedWork(concurrent);

  const checkpoint = await setup();
  const originalHead = await git(
    checkpoint.workspace.localPath,
    'rev-parse',
    'HEAD'
  );
  state.recoveryCheckpointFailures = 1;
  await assert.rejects(
    prepareRunnerWorkspace(options),
    /Forced recovery checkpoint failure/
  );
  assert.equal(
    await git(checkpoint.workspace.localPath, 'rev-parse', 'HEAD'),
    originalHead
  );
  await assertRetainedWork(checkpoint);
  const resumed = await prepareRunnerWorkspace(options);
  assert.equal(resumed.workspace.generation, checkpoint.workspace.generation);
  assert.equal(resumed.workspace.localPath, checkpoint.workspace.localPath);
  await assertRetainedWork(checkpoint);

  const interrupted = await setup();
  state.recoveryCheckpointSkip = 1;
  state.recoveryCheckpointFailures = 1;
  await assert.rejects(
    prepareRunnerWorkspace(options),
    /Forced recovery checkpoint failure/
  );
  assert.equal(state.runnerExecution.recovery.phase, 'in_progress');
  assert.match(state.runnerExecution.recovery.stashRef, /^[a-f0-9]{40}$/);
  const afterInterruption = await prepareRunnerWorkspace(options);
  assert.equal(
    afterInterruption.workspace.localPath,
    interrupted.workspace.localPath
  );
  assert.equal(
    afterInterruption.workspace.generation,
    interrupted.workspace.generation
  );
  await assertRetainedWork(interrupted);

  const restoredBeforeCheckpoint = await setup();
  state.recoveryCheckpointSkip = 2;
  state.recoveryCheckpointFailures = 1;
  await assert.rejects(
    prepareRunnerWorkspace(options),
    /Forced recovery checkpoint failure/
  );
  assert.equal(state.runnerExecution.recovery.stashApplied, undefined);
  await assertRetainedWork(restoredBeforeCheckpoint);
  await prepareRunnerWorkspace(options);
  await assertRetainedWork(restoredBeforeCheckpoint);
  assert.equal(
    await git(restoredBeforeCheckpoint.workspace.localPath, 'stash', 'list'),
    ''
  );
  assert.equal(
    await git(
      restoredBeforeCheckpoint.workspace.localPath,
      'for-each-ref',
      '--format=%refname',
      'refs/omniboard/applied-stashes'
    ),
    ''
  );

  const freshness = await setup();
  await prepareRunnerWorkspace(options);
  const latestTarget = await advanceTarget();
  const repeated = await prepareRunnerWorkspace(options);
  await git(
    repeated.workspace.localPath,
    'merge-base',
    '--is-ancestor',
    latestTarget,
    'HEAD'
  );
  assert.equal(repeated.workspace.recovery.targetHeadSha, latestTarget);
  await assertRetainedWork(freshness);
  const targetBeforeFinalization = await advanceTarget();
  const finalized = await finalizeRunnerWorkspace({
    ...options,
    localPath: repeated.workspace.localPath,
  });
  assert.equal(finalized.completed, true);
  await git(
    remotePath,
    'merge-base',
    '--is-ancestor',
    targetBeforeFinalization,
    'refs/heads/agentic/run-icons'
  );

  const stagedConflict = await setup();
  await git(stagedConflict.workspace.localPath, 'add', 'README.md');
  await fs.appendFile(path.join(seedPath, 'README.md'), 'upstream edit\n');
  await commitForTest(
    seedPath,
    'Advance the same file as the staged migration'
  );
  await git(seedPath, 'push', 'origin', 'main');
  const dirtyConflicts = await prepareRunnerWorkspace(options);
  assert.equal(dirtyConflicts.workspace.recovery.phase, 'conflicts');
  assert.deepEqual(dirtyConflicts.workspace.recovery.conflictFiles, [
    'README.md',
  ]);
  state.projectProgressStatus = 'blocked';
  state.projectProgressMetadata = context.progress.at(-1).metadata;
  const blockedResumed = await prepareRunnerWorkspace(options);
  assert.equal(blockedResumed.continuation.action, 'continue');
  assert.equal(
    blockedResumed.workspace.localPath,
    stagedConflict.workspace.localPath
  );
  await fs.writeFile(
    path.join(stagedConflict.workspace.localPath, 'README.md'),
    stagedConflict.readme + 'upstream edit\n'
  );
  await git(stagedConflict.workspace.localPath, 'add', 'README.md');
  const dirtyResolved = await finalizeRunnerWorkspace({
    ...options,
    localPath: stagedConflict.workspace.localPath,
  });
  assert.equal(dirtyResolved.completed, true);
  assert.equal(
    await git(remotePath, 'show', 'refs/heads/agentic/run-icons:README.md'),
    (stagedConflict.readme + 'upstream edit\n').trim()
  );

  // Resolve through the public runner tools, without manually continuing a
  // rebase or changing the execution checkpoint as part of the test.
  const migration = await setup(true, true);
  state.projectMergeRequestUrl = null;
  state.projectMergeRequestState = null;
  const conflicts = await prepareRunnerWorkspace(options);
  assert.equal(conflicts.workspace.recovery.kind, 'target_sync');
  assert.equal(conflicts.workspace.recovery.phase, 'conflicts');
  assert.deepEqual(conflicts.workspace.recovery.conflictFiles, [
    'sync-config.txt',
  ]);
  const targetDuringResolution = await advanceTarget();
  await fs.writeFile(
    path.join(migration.workspace.localPath, 'sync-config.txt'),
    'registry=migrated\nupstream=true\n'
  );
  await git(migration.workspace.localPath, 'add', 'sync-config.txt');
  const resolved = await finalizeRunnerWorkspace({
    ...options,
    localPath: migration.workspace.localPath,
  });
  assert.equal(resolved.completed, true);
  await git(
    remotePath,
    'merge-base',
    '--is-ancestor',
    targetDuringResolution,
    'refs/heads/agentic/run-icons'
  );
  assert.equal(
    await git(
      remotePath,
      'show',
      'refs/heads/agentic/run-icons:sync-config.txt'
    ),
    'registry=migrated\nupstream=true'
  );
  assert.equal(
    await git(remotePath, 'show', 'refs/heads/agentic/run-icons:README.md'),
    migration.readme.trim()
  );
  assert.equal(
    await git(
      remotePath,
      'show',
      'refs/heads/agentic/run-icons:sync-staged.txt'
    ),
    'staged'
  );
  assert.equal(
    await git(
      remotePath,
      'show',
      'refs/heads/agentic/run-icons:sync-untracked.txt'
    ),
    'untracked'
  );
}
