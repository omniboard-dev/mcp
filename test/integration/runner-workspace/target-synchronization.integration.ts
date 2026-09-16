import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(cp.execFile);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'omniboard-mcp-target-sync-test-')
);
const remotePath = path.join(root, 'project.git');
const seedPath = path.join(root, 'seed');
const workspacePath = path.join(root, 'workspace');
const conflictWorkspacePath = path.join(root, 'conflict-workspace');
const gitEnvironment = { ...process.env };
for (const key of [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_KEY_2',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_VALUE_2',
  'GIT_CONFIG_PARAMETERS',
]) {
  delete gitEnvironment[key];
}

try {
  await fs.mkdir(seedPath);
  await execFile('git', ['init', '--bare', remotePath], {
    cwd: root,
    env: gitEnvironment,
  });
  await execFile('git', ['init'], { cwd: seedPath, env: gitEnvironment });
  await configureIdentity(seedPath);
  await fs.writeFile(path.join(seedPath, 'README.md'), '# Runner test\n');
  await commit(seedPath, 'Initial commit');
  const initialSha = await git(seedPath, ['rev-parse', 'HEAD']);
  await git(seedPath, ['branch', '-M', 'main']);
  await git(seedPath, ['remote', 'add', 'origin', fileUrl(remotePath)]);
  await git(seedPath, ['push', '-u', 'origin', 'main']);

  await git(seedPath, ['checkout', '-b', 'agentic/run-icons']);
  await fs.writeFile(path.join(seedPath, 'feature.txt'), 'feature\n');
  await commit(seedPath, 'Feature commit');
  await git(seedPath, ['push', '-u', 'origin', 'agentic/run-icons']);

  await git(seedPath, ['checkout', 'main']);
  await fs.writeFile(path.join(seedPath, 'target.txt'), 'target\n');
  await commit(seedPath, 'Target advance');
  await git(seedPath, ['push', 'origin', 'main']);

  const {
    applyStash,
    checkoutRemoteBranch,
    cloneRepository,
    dropStash,
    fetchBranch,
    getHeadCommit,
    getStashEntry,
    getWorkingTreeStatus,
    isAncestor,
    startRebase,
    stashWorkingTree,
  } = await import('../../../dist/services/git.service.js');

  await cloneRepository(
    fileUrl(remotePath),
    workspacePath,
    root,
    gitEnvironment
  );
  await fetchBranch(fileUrl(remotePath), 'main', workspacePath, gitEnvironment);
  await fetchBranch(
    fileUrl(remotePath),
    'agentic/run-icons',
    workspacePath,
    gitEnvironment
  );
  await checkoutRemoteBranch('agentic/run-icons', workspacePath);

  await fs.appendFile(path.join(workspacePath, 'feature.txt'), 'staged\n');
  await git(workspacePath, ['add', 'feature.txt']);
  await fs.appendFile(path.join(workspacePath, 'README.md'), 'unstaged\n');
  await fs.writeFile(path.join(workspacePath, 'untracked.txt'), 'untracked\n');

  const stashRef = await stashWorkingTree(workspacePath);
  await startRebase('main', workspacePath);
  await applyStash(stashRef, workspacePath);
  await dropStash(stashRef, workspacePath);

  const status = await getWorkingTreeStatus(workspacePath);
  assert.match(status, /^M  feature\.txt$/m);
  assert.match(status, /^ M README\.md$/m);
  assert.match(status, /^\?\? untracked\.txt$/m);
  assert.equal(
    await isAncestor(
      await git(workspacePath, ['rev-parse', 'refs/remotes/origin/main']),
      (
        await getHeadCommit(workspacePath)
      ).sha,
      workspacePath
    ),
    true
  );

  const statusBeforeRepeat = status;
  await fetchBranch(fileUrl(remotePath), 'main', workspacePath, gitEnvironment);
  assert.equal(
    await isAncestor(
      await git(workspacePath, ['rev-parse', 'refs/remotes/origin/main']),
      (
        await getHeadCommit(workspacePath)
      ).sha,
      workspacePath
    ),
    true
  );
  assert.equal(await getWorkingTreeStatus(workspacePath), statusBeforeRepeat);

  await fs.writeFile(
    path.join(workspacePath, 'preserved-stash.txt'),
    'first\n'
  );
  const preservedStash = await stashWorkingTree(workspacePath);
  await fs.writeFile(
    path.join(workspacePath, 'unrelated-stash.txt'),
    'unrelated\n'
  );
  const unrelatedStash = await stashWorkingTree(workspacePath);
  assert.equal(
    (await getStashEntry(preservedStash, workspacePath))?.commitSha,
    preservedStash
  );
  assert.equal(
    (await getStashEntry(unrelatedStash, workspacePath))?.commitSha,
    unrelatedStash
  );
  await dropStash(preservedStash, workspacePath);
  assert.equal(await getStashEntry(preservedStash, workspacePath), null);
  assert.equal(
    (await getStashEntry(unrelatedStash, workspacePath))?.commitSha,
    unrelatedStash
  );
  await assert.rejects(
    dropStash(preservedStash, workspacePath),
    /no longer available/
  );
  await dropStash(unrelatedStash, workspacePath);

  await git(seedPath, ['checkout', '-B', 'agentic/conflict', initialSha]);
  await fs.writeFile(path.join(seedPath, 'README.md'), '# Feature version\n');
  await commit(seedPath, 'Feature conflict');
  await git(seedPath, ['push', '-f', 'origin', 'agentic/conflict']);
  await git(seedPath, ['checkout', 'main']);
  await fs.writeFile(path.join(seedPath, 'README.md'), '# Target version\n');
  await commit(seedPath, 'Target conflict');
  await git(seedPath, ['push', 'origin', 'main']);

  await cloneRepository(
    fileUrl(remotePath),
    conflictWorkspacePath,
    root,
    gitEnvironment
  );
  await fetchBranch(
    fileUrl(remotePath),
    'main',
    conflictWorkspacePath,
    gitEnvironment
  );
  await fetchBranch(
    fileUrl(remotePath),
    'agentic/conflict',
    conflictWorkspacePath,
    gitEnvironment
  );
  await checkoutRemoteBranch('agentic/conflict', conflictWorkspacePath);
  await assert.rejects(
    startRebase('main', conflictWorkspacePath),
    /CONFLICT|conflict/i
  );
  assert.deepEqual(
    await git(conflictWorkspacePath, [
      'diff',
      '--name-only',
      '--diff-filter=U',
    ]),
    'README.md'
  );
  await fs.writeFile(
    path.join(conflictWorkspacePath, 'README.md'),
    '# Target version\n\n# Feature version\n'
  );
  await git(conflictWorkspacePath, ['add', 'README.md']);
  await execFile('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
    cwd: conflictWorkspacePath,
    env: gitEnvironment,
  });
  assert.equal(
    await isAncestor(
      await git(conflictWorkspacePath, [
        'rev-parse',
        'refs/remotes/origin/main',
      ]),
      (
        await getHeadCommit(conflictWorkspacePath)
      ).sha,
      conflictWorkspacePath
    ),
    true
  );

  console.log('Target synchronization integration test passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function configureIdentity(targetDir: string) {
  await git(targetDir, ['config', 'user.name', 'Target Sync Test']);
  await git(targetDir, ['config', 'user.email', 'target-sync@example.com']);
}

async function commit(targetDir: string, message: string) {
  await git(targetDir, ['add', '--all']);
  await git(targetDir, ['commit', '-m', message]);
}

async function git(targetDir: string, args: string[]) {
  const result = await execFile('git', args, {
    cwd: targetDir,
    env: gitEnvironment,
  });
  return result.stdout.trim();
}

function fileUrl(targetPath: string) {
  return new URL(`file://${targetPath}`).toString();
}
