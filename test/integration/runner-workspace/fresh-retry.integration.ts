import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runFreshRetryIntegration(context: any) {
  const {
    root,
    remotePath,
    seedPath,
    state,
    execFile,
    prepareRunnerWorkspace,
    finalizeRunnerWorkspace,
    repositoryAccessRequests,
    registeredFileRepositoryUrl,
  } = context;
  const { releaseAllRunnerExecutions } = await import(
    '../../../dist/services/runner-execution.service.js'
  );
  const { mergeRunnerChange } = await import(
    '../../../dist/services/runner-merge.service.js'
  );
  const { prepareNextRunnerProjects } = await import(
    '../../../dist/services/runner-batch-preparation.service.js'
  );
  const options = { runKey: 'run-icons', projectName: 'project-a' };
  const git = async (cwd: string, ...args: string[]) =>
    (await execFile('git', args, { cwd })).stdout.trim();
  state.persistProgress = true;
  state.projectMergeRequestState = 'closed';
  state.projectProgressStatus = 'done';
  state.projectProgressResolution = 'dismissed';
  state.projectProgressRepositoryUrl = registeredFileRepositoryUrl;
  state.projectRepositoryUrls = [
    new URL('file://' + path.join(root, 'wrong-default.git')).toString(),
    registeredFileRepositoryUrl,
  ];
  const accessStart = repositoryAccessRequests.length;
  await releaseAllRunnerExecutions();

  // A dismissed/closed MR still needs the migration; keep its chosen repository.
  const retry = await prepareRunnerWorkspace(options);
  assert.equal(retry.continuation.action, 'continue');
  assert.equal(retry.workspace.repositoryUrl, registeredFileRepositoryUrl);
  assert.equal(state.projectProgressStatus, 'in_progress');
  const localPath = retry.workspace.localPath;
  const oldUrl = state.projectMergeRequestUrl;
  await fs.writeFile(path.join(localPath, 'retry.txt'), 'retry migration\n');
  const replacement = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(replacement.published, true);
  assert.equal(replacement.mergeRequest.state, 'opened');
  assert.notEqual(replacement.mergeRequest.url, oldUrl);
  assert.equal(state.projectMergeRequestUrl, replacement.mergeRequest.url);

  state.projectFulfillment = 'fulfilled';
  state.projectPipelineStatus = 'running';
  const awaitingCi = await prepareNextRunnerProjects({
    runKey: options.runKey,
  });
  assert.equal(awaitingCi.summary.prepared, 0);
  assert.equal(awaitingCi.results[0].reason, 'waiting_for_ci');
  assert.equal(awaitingCi.results[0].preparation.continuation.action, 'wait');
  const dirtyFile = path.join(localPath, 'pending-ci-fix.txt');
  await fs.writeFile(dirtyFile, 'local fix still needs publication\n');
  const unpublishedFix = await prepareNextRunnerProjects({
    runKey: options.runKey,
  });
  assert.equal(unpublishedFix.summary.prepared, 1);
  await fs.unlink(dirtyFile);
  state.projectPipelineStatus = 'success';
  state.projectMergeRequestDetailedStatus = 'not_approved';
  const awaitingApproval = await prepareNextRunnerProjects({
    runKey: options.runKey,
  });
  assert.equal(awaitingApproval.results[0].reason, 'waiting_for_review');
  state.projectMergeRequestDetailedStatus = 'mergeable';

  // Missing old-runner metadata means disposable local work, recovered from the MR branch.
  await fs.writeFile(
    path.join(localPath, 'discarded.txt'),
    'old local edits\n'
  );
  await git(
    localPath,
    'stash',
    'push',
    '--include-untracked',
    '-m',
    'omniboard-runner-target-sync'
  );
  await fs.unlink(path.join(localPath, '.git', 'omniboard-runner.json'));
  await fs.writeFile(path.join(seedPath, 'fresh-main.txt'), 'latest main\n');
  await git(seedPath, 'add', 'fresh-main.txt');
  await git(seedPath, 'commit', '-m', 'Advance main for retry');
  await git(seedPath, 'push', 'origin', 'main');
  await releaseAllRunnerExecutions();
  const rebuilt = await prepareRunnerWorkspace(options);
  assert.equal(rebuilt.workspaceCreated, true);
  assert.equal(rebuilt.workspace.localPath, localPath);
  assert.equal(
    await fs.readFile(path.join(localPath, 'retry.txt'), 'utf8'),
    'retry migration\n'
  );
  assert.equal(
    await fs.readFile(path.join(localPath, 'fresh-main.txt'), 'utf8'),
    'latest main\n'
  );
  await assert.rejects(fs.access(path.join(localPath, 'discarded.txt')), {
    code: 'ENOENT',
  });
  assert.equal(await git(localPath, 'stash', 'list'), '');
  await git(localPath, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD');

  // Corrupt state found during finalization must return the fresh checkout for work first.
  await fs.writeFile(
    path.join(localPath, '.git', 'omniboard-runner.json'),
    '{broken'
  );
  const remoteBefore = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  const resetFinalization = await finalizeRunnerWorkspace({
    ...options,
    localPath,
  });
  assert.equal(resetFinalization.completed, false);
  assert.match(resetFinalization.instructions.join(' '), /recreated/);
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    remoteBefore
  );
  await fs.writeFile(
    path.join(localPath, 'reapplied.txt'),
    'reapplied migration\n'
  );
  assert.equal(
    (await finalizeRunnerWorkspace({ ...options, localPath })).published,
    true
  );

  // A deleted MR branch and missing checkout start from current main.
  state.projectMergeRequestState = 'closed';
  state.projectProgressStatus = 'blocked';
  await git(seedPath, 'push', 'origin', '--delete', 'agentic/run-icons');
  await fs.rm(localPath, { recursive: true, force: true });
  await releaseAllRunnerExecutions();
  const fresh = await prepareRunnerWorkspace(options);
  assert.equal(fresh.workspaceCreated, true);
  assert.equal(
    await git(localPath, 'rev-parse', 'HEAD'),
    await git(remotePath, 'rev-parse', 'refs/heads/main')
  );
  await fs.writeFile(
    path.join(localPath, 'from-scratch.txt'),
    'fresh migration\n'
  );
  const freshPublished = await finalizeRunnerWorkspace({
    ...options,
    localPath,
  });
  assert.equal(freshPublished.published, true);
  assert.equal(freshPublished.mergeRequest.state, 'opened');
  await releaseAllRunnerExecutions();
  state.projectPipelineStatus = 'success';
  state.mergeRequestSourceHeadSha = freshPublished.commitSha;
  assert.equal(
    (await mergeRunnerChange(options.runKey, options.projectName)).merged,
    true
  );
  assert(
    repositoryAccessRequests
      .slice(accessStart)
      .every((url: string) => url === registeredFileRepositoryUrl)
  );
  console.log(
    'Fresh retry: closed/dismissed MR, disposable legacy/corrupt checkout, deleted source branch and retained repository passed.'
  );
}
