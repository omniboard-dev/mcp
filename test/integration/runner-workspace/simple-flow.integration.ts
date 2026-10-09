import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runSimpleFlowIntegration(context: any) {
  const {
    root,
    remotePath,
    seedPath,
    state,
    execFile,
    prepareRunnerWorkspace,
    finalizeRunnerWorkspace,
  } = context;
  const { releaseAllRunnerExecutions } = await import(
    '../../../dist/services/runner-execution.service.js'
  );
  process.env.OMNIBOARD_MCP_CLI_ALLOW_LOCAL_TRANSPORTS = 'true';
  const options = { runKey: 'run-icons', projectName: 'project-a' };
  const git = async (cwd: string, ...args: string[]) =>
    (await execFile('git', args, { cwd })).stdout.trim();
  const seedCommit = async (name: string, content: string) => {
    await fs.writeFile(path.join(seedPath, name), content);
    await git(seedPath, 'add', name);
    await git(seedPath, 'commit', '-m', 'Advance target');
    await git(seedPath, 'push', 'origin', 'main');
  };
  const first = await prepareRunnerWorkspace(options);
  assert(first.workspace);
  const localPath = first.workspace.localPath;
  assert.equal(
    await git(localPath, 'branch', '--show-current'),
    'agentic/run-icons'
  );
  const assertEmptyPublicationBlocked = async () => {
    const result = await finalizeRunnerWorkspace({ ...options, localPath });
    assert.equal(result.completed, false);
    assert.equal(result.published, false);
    assert.equal(result.mergeRequest, undefined);
    assert.match(result.instructions.join(' '), /no changes/);
    assert.match(result.instructions.join(' '), /resolution=dismissed/);
    assert.equal(state.mergeRequestCreateCount, 0);
    assert.equal(
      await git(remotePath, 'branch', '--list', 'agentic/run-icons'),
      ''
    );
    assert.equal(
      context.progress.some((entry: any) => entry.status === 'mr_created'),
      false
    );
  };
  await assertEmptyPublicationBlocked();
  await git(localPath, 'commit', '--allow-empty', '-m', 'Empty migration');
  await assertEmptyPublicationBlocked();
  await fs.writeFile(
    path.join(localPath, 'reverted.txt'),
    'temporary change\n'
  );
  await git(localPath, 'add', 'reverted.txt');
  await git(localPath, 'commit', '-m', 'Temporary migration');
  await git(localPath, 'revert', '--no-edit', 'HEAD');
  await assertEmptyPublicationBlocked();
  await fs.writeFile(
    path.join(localPath, 'migration.txt'),
    'Vitest migration\n'
  );
  const published = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(published.published, true);
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    published.commitSha
  );
  state.projectMergeRequestUrl = published.mergeRequest.url;
  state.projectMergeRequestState = 'opened';
  state.projectProgressStatus = 'mr_created';

  // Progress labels and changed analyzer results do not block a retained MR.
  state.projectMatchesCheck = false;
  state.projectFulfillment = 'notFulfilled';
  await fs.mkdir(path.join(localPath, 'node_modules'), { recursive: true });
  await fs.writeFile(
    path.join(localPath, 'node_modules', 'retained'),
    'installed'
  );
  for (const status of [
    'in_progress',
    'verified',
    'mr_created',
    'failed',
    'blocked',
    'needs_input',
  ]) {
    state.projectProgressStatus = status;
    assert.equal(
      (await prepareRunnerWorkspace(options)).workspace.localPath,
      localPath
    );
  }

  // Fresh target, dirty edits and restart: retain everything and use the same MR.
  await fs.writeFile(path.join(localPath, 'local-edit.txt'), 'keep my work\n');
  await seedCommit('main-only.txt', 'latest main\n');
  await releaseAllRunnerExecutions();
  const resumed = await prepareRunnerWorkspace(options);
  assert.equal(resumed.workspace.localPath, localPath);
  assert.equal(
    await fs.readFile(path.join(localPath, 'local-edit.txt'), 'utf8'),
    'keep my work\n'
  );
  assert.equal(
    await fs.readFile(path.join(localPath, 'node_modules', 'retained'), 'utf8'),
    'installed'
  );
  assert.equal(
    await fs.readFile(path.join(localPath, 'main-only.txt'), 'utf8'),
    'latest main\n'
  );
  await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(state.mergeRequestCreateCount, 1);

  const publishedBeforeTargetChange = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  await seedCommit('requires-revalidation.txt', 'new target code\n');
  const revalidation = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(revalidation.completed, false);
  assert(
    revalidation.instructions.some((line) =>
      line.includes('rerun relevant checks')
    )
  );
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    publishedBeforeTargetChange
  );
  const revalidated = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(revalidated.published, true);

  // Real conflict after main moves. Resume with Git state even across shutdown.
  await fs.writeFile(path.join(localPath, 'README.md'), '# Migrated\n');
  await finalizeRunnerWorkspace({ ...options, localPath });
  await fs.writeFile(
    path.join(localPath, 'later-commit.txt'),
    'Applied after conflict resolution\n'
  );
  await finalizeRunnerWorkspace({ ...options, localPath });
  const beforeRecovery = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  await seedCommit('README.md', '# Main changed\n');
  const conflicted = await prepareRunnerWorkspace(options);
  assert.deepEqual(conflicted.workspace.recovery.conflictFiles, ['README.md']);
  await releaseAllRunnerExecutions();
  const conflictResumed = await prepareRunnerWorkspace(options);
  assert.equal(conflictResumed.workspace.localPath, localPath);
  assert.deepEqual(conflictResumed.workspace.recovery.conflictFiles, [
    'README.md',
  ]);
  await fs.writeFile(
    path.join(localPath, 'README.md'),
    '# Main changed and migrated\n'
  );
  await git(localPath, 'add', 'README.md');
  await assert.rejects(fs.access(path.join(localPath, 'later-commit.txt')));
  const recovered = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(recovered.completed, false);
  assert(
    recovered.instructions.some((line) =>
      line.includes('rerun relevant checks')
    )
  );
  assert.equal(
    await fs.readFile(path.join(localPath, 'later-commit.txt'), 'utf8'),
    'Applied after conflict resolution\n'
  );
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    beforeRecovery
  );
  const fixed = await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(fixed.published, true);
  assert.equal(
    await git(remotePath, 'show', 'refs/heads/agentic/run-icons:README.md'),
    '# Main changed and migrated'
  );
  await git(localPath, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD');

  // Source commits added elsewhere are retained before publishing another fix.
  const other = path.join(root, 'other');
  await git(root, 'clone', remotePath, other);
  await git(other, 'config', 'user.name', 'Other developer');
  await git(other, 'config', 'user.email', 'other@example.com');
  await git(other, 'checkout', 'agentic/run-icons');
  await fs.writeFile(path.join(other, 'other.txt'), 'Other contribution\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '-m', 'Other contribution');
  await git(other, 'push', 'origin', 'agentic/run-icons');
  await fs.writeFile(
    path.join(localPath, 'ci-fix.txt'),
    'Repair from CI logs\n'
  );
  state.projectPipelineStatus = 'failed';
  const ci = await prepareRunnerWorkspace(options);
  assert(
    ci.continuation.diagnostics.some((line) =>
      line.includes('Expected true, received false')
    )
  );
  assert.equal(
    await fs.readFile(path.join(localPath, 'other.txt'), 'utf8'),
    'Other contribution\n'
  );
  await finalizeRunnerWorkspace({ ...options, localPath });
  assert.equal(
    await git(remotePath, 'show', 'refs/heads/agentic/run-icons:ci-fix.txt'),
    'Repair from CI logs'
  );
  assert.equal(state.runnerAcquireCount, 0, 'No execution lifecycle API calls');
  assert.equal(
    state.mergeRequestCreateCount,
    1,
    'One MR for the whole migration'
  );
  const { mergeRunnerChange } = await import(
    '../../../dist/services/runner-merge.service.js'
  );
  state.mergeRequestSourceHeadSha = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  const pendingMerge = await mergeRunnerChange(
    options.runKey,
    options.projectName
  );
  assert.equal(pendingMerge.merged, false);
  assert.match(pendingMerge.reason, /Pipeline must succeed/);
  state.projectPipelineStatus = 'success';
  state.projectProgressStatus = 'blocked'; // stale reporting never vetoes merging
  const merged = await mergeRunnerChange(options.runKey, options.projectName);
  assert.equal(merged.merged, true);
  assert.equal(context.progress.at(-1).resolution, 'merged');
  assert.equal(
    (await mergeRunnerChange(options.runKey, options.projectName)).merged,
    true
  );
  assert.equal(state.mergeCalls, 2, 'Already merged is idempotent');
  await fs.writeFile(path.join(localPath, 'stale-work.txt'), 'do not resume\n');
  await releaseAllRunnerExecutions();
  const headBeforeResume = await git(localPath, 'rev-parse', 'HEAD');
  const remoteBeforeResume = await git(
    remotePath,
    'rev-parse',
    'refs/heads/agentic/run-icons'
  );
  const stopped = await prepareRunnerWorkspace({ ...options, localPath });
  assert.equal(stopped.continuation.action, 'stop');
  assert.equal(stopped.continuation.reason, 'change_merged');
  assert.equal(stopped.workspace, undefined);
  await assert.rejects(
    finalizeRunnerWorkspace({ ...options, localPath }),
    /already merged/
  );
  assert.equal(await git(localPath, 'rev-parse', 'HEAD'), headBeforeResume);
  assert.equal(
    await fs.readFile(path.join(localPath, 'stale-work.txt'), 'utf8'),
    'do not resume\n'
  );
  assert.equal(
    await git(remotePath, 'rev-parse', 'refs/heads/agentic/run-icons'),
    remoteBeforeResume
  );
  assert.equal(
    state.mergeRequestCreateCount,
    1,
    'Merged retained work must not create another MR'
  );
  console.log(
    'Simple migration flow: fresh checkout, retained edits, restart, target conflict, source update and CI repair passed.'
  );
}
