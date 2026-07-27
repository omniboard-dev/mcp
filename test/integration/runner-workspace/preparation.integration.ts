import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runWorkspacePreparationIntegration(context: any) {
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
  } = context;

  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      repositoryUrl: 'https://gitlab.example.com/unrelated/project.git',
    }),
    /not registered on the matched Omniboard project/
  );
  progress.length = 0;

  state.projectRepositoryUrls = [
    'https://untrusted.example.com/group/project.git',
  ];
  state.expectedProjectPath = 'group/project';
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    }),
    /does not match credential host/
  );

  state.projectRepositoryUrls = ['http://gitlab.example.com/group/project.git'];
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    }),
    /secure HTTPS/
  );

  state.projectRepositoryUrls = [
    'git@gitlab.example.com:group/project.git',
    'https://gitlab.example.com/group/project.git',
  ];
  state.expectedProjectPath = 'group/project';
  state.includeProjectPath = false;
  state.canPush = false;
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      repositoryUrl: 'https://gitlab.example.com/group/project.git',
    }),
    /requires effective pushCode/
  );
  assert.equal(
    repositoryAccessRequests.at(-1),
    'https://gitlab.example.com/group/project.git'
  );
  await assert.rejects(fs.access(runnerRoot));

  state.projectRepositoryUrls = [
    'https://gitlab.example.com/group/project.git',
  ];
  state.expectedProjectPath = 'other/project';
  state.includeProjectPath = true;
  state.canPush = true;
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    }),
    /does not match repository URL project/
  );

  if (process.platform !== 'win32') {
    state.projectRepositoryUrls = [registeredFileRepositoryUrl];
    state.expectedProjectPath = 'group/project';
    state.includeProjectPath = true;
    state.canPush = true;
    const outsideRunnerRoot = path.join(root, 'outside-runner-root');
    await fs.mkdir(outsideRunnerRoot);
    await fs.symlink(outsideRunnerRoot, path.join(root, '.omniboard'), 'dir');
    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      }),
      /must be a real directory/
    );
    assert.deepEqual(await fs.readdir(outsideRunnerRoot), []);
    await fs.rm(path.join(root, '.omniboard'));
    await fs.rm(outsideRunnerRoot, { recursive: true });
  }

  state.includeProjectPath = true;
  const missingRemotePath = path.join(root, 'group', 'missing.git');
  state.projectRepositoryUrls = [pathToFileUrl(missingRemotePath)];
  state.expectedProjectPath = normalizeProjectPath(missingRemotePath);
  state.canPush = true;
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    })
  );
  assert.deepEqual(await fs.readdir(path.join(runnerRoot, 'workspaces')), []);

  state.projectRepositoryUrls = [registeredFileRepositoryUrl];
  state.repositoryAccessHost = 'gitlab.example.com';
  state.expectedProjectPath = 'group/project';
  state.canPush = true;
  progress.length = 0;

  state.projectProgressBranch = 'agentic/retry-guard';
  const retryPrepared = await prepareRunnerWorkspace({
    runKey: 'run-uxf',
    projectName: 'project-a',
    branch: 'agentic/retry-guard',
  });
  await fs.appendFile(
    path.join(retryPrepared.workspace.localPath, 'README.md'),
    '\nFirst unexpected commit.\n'
  );
  await commitForTest(
    retryPrepared.workspace.localPath,
    'test: unexpected intermediate commit'
  );
  await fs.appendFile(
    path.join(retryPrepared.workspace.localPath, 'README.md'),
    '\nSecond unexpected commit.\n'
  );
  await commitForTest(
    retryPrepared.workspace.localPath,
    'fix: update icon registry'
  );
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: retryPrepared.workspace.localPath,
    }),
    /no verified runner commit to resume/
  );
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      branch: 'agentic/retry-guard',
    }),
    /retained workspace contains an unverified local commit/
  );
  await fs.rm(retryPrepared.workspace.localPath, {
    recursive: true,
    force: true,
  });
  await fs.rm(
    path.join(
      runnerRoot,
      'state',
      `${path.basename(retryPrepared.workspace.localPath)}.json`
    ),
    { force: true }
  );
  state.projectProgressBranch = 'agentic/run-uxf';
  progress.length = 0;

  await fs.writeFile(path.join(runnerRoot, '.gitignore'), 'custom/\n');

  const prepared = await prepareRunnerWorkspace({
    runKey: 'run-uxf',
    projectName: 'project-a',
    repositoryUrl: pathToFileUrl(remotePath).replace(/\.git$/, ''),
  });
  assert.equal(prepared.workspace.branch, 'agentic/run-uxf');
  assert.equal(
    prepared.workspace.commitMessage,
    'fix(OB-123): update icon registry'
  );
  assert.equal(prepared.workspace.targetBranch, 'main');
  assert.equal(prepared.workspace.projectPath, 'group/project');
  assert.match(prepared.workspace.preparedHeadSha, /^[a-f0-9]{40}$/);
  assert.equal(prepared.prompt, 'Update the icon registry.');
  assert.equal(progress.at(-1).localPath, prepared.workspace.localPath);
  const preparedAgain = await prepareRunnerWorkspace({
    runKey: 'run-uxf',
    projectName: 'project-a',
  });
  assert.equal(preparedAgain.workspace.localPath, prepared.workspace.localPath);
  const progressCountBeforeBranchMismatch = progress.length;
  await assert.rejects(
    prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      branch: 'agentic/other-branch',
    }),
    /Retained runner workspace branch.*does not match resolved branch/
  );
  progress.length = progressCountBeforeBranchMismatch;
  assert.equal(
    path.dirname(prepared.workspace.localPath),
    path.join(runnerRoot, 'workspaces')
  );
  assert.equal(
    await fs.readFile(path.join(runnerRoot, '.gitignore'), 'utf8'),
    'custom/\nworkspaces/\nstate/\n'
  );
  await assert.rejects(
    fs.access(
      path.join(prepared.workspace.localPath, '.git', 'omniboard-runner.json')
    )
  );
  const stateFileName = `${path.basename(prepared.workspace.localPath)}.json`;
  await fs.access(path.join(runnerRoot, 'state', stateFileName));
  assert.deepEqual(await fs.readdir(path.join(runnerRoot, 'state')), [
    stateFileName,
  ]);
  const stateFilePath = path.join(runnerRoot, 'state', stateFileName);
  const originalStateContent = await fs.readFile(stateFilePath, 'utf8');
  assert.doesNotMatch(originalStateContent, /test-token/);
  const tamperedState = JSON.parse(originalStateContent);
  tamperedState.state.targetBranch = 'tampered-target';
  await fs.writeFile(stateFilePath, JSON.stringify(tamperedState, null, 2));
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
    }),
    /metadata integrity validation failed/
  );
  await fs.writeFile(stateFilePath, originalStateContent);

  const externalWorktree = path.join(root, 'external-worktree');
  await fs.mkdir(externalWorktree);
  await fs.writeFile(
    path.join(externalWorktree, 'outside.txt'),
    'outside workspace\n'
  );
  await execFile('git', ['config', 'core.worktree', externalWorktree], {
    cwd: prepared.workspace.localPath,
  });
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix UXF icon registry',
    }),
    /Git worktree .* is outside runner workspace/
  );
  await execFile(
    'git',
    [
      '--git-dir',
      path.join(prepared.workspace.localPath, '.git'),
      'config',
      '--unset',
      'core.worktree',
    ],
    { cwd: root }
  );
  progress.splice(1);

  await execFile(
    'git',
    [
      'remote',
      'set-url',
      'origin',
      pathToFileUrl(path.join(root, 'unauthorized.git')),
    ],
    { cwd: prepared.workspace.localPath }
  );
  await fs.writeFile(
    path.join(prepared.workspace.localPath, '.git', 'hooks', 'pre-commit'),
    `#!/bin/sh
  printf "%s|%s" "$OMNIBOARD_API_KEY_MCP" "$OMNIBOARD_API_KEY" > "${serverSecretLeakPath}"
  `,
    { mode: 0o700 }
  );
  await fs.writeFile(
    path.join(prepared.workspace.localPath, '.git', 'hooks', 'pre-push'),
    `#!/bin/sh
  printf "%s" "$OMNIBOARD_GIT_TOKEN" > "${tokenLeakPath}"
  `,
    { mode: 0o700 }
  );
  if (process.platform !== 'win32') {
    const cleanFilterPath = path.join(
      prepared.workspace.localPath,
      '.git',
      'omniboard-clean-filter.sh'
    );
    await fs.writeFile(
      cleanFilterPath,
      `#!/bin/sh
  printf "%s" "\${UNRELATED_RUNNER_SECRET-unset}" > "${ambientSecretLeakPath}"
  cat
  `,
      { mode: 0o700 }
    );
    await execFile(
      'git',
      ['config', 'filter.omniboard-test.clean', cleanFilterPath],
      { cwd: prepared.workspace.localPath }
    );
    await fs.writeFile(
      path.join(prepared.workspace.localPath, '.gitattributes'),
      'README.md filter=omniboard-test\n'
    );
  }
  await fs.appendFile(
    path.join(prepared.workspace.localPath, 'README.md'),
    '\nUpdated by the runner.\n'
  );

  const progressBeforeFinalizationStateChecks = progress.length;
  state.projectProgressBranch = 'agentic/reassigned';
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix UXF icon registry',
    }),
    /provider branch.*does not match runner workspace branch/i
  );
  state.projectProgressBranch = 'agentic/run-uxf';

  state.projectRepositoryUrls = [
    pathToFileUrl(path.join(root, 'group', 'replacement.git')),
  ];
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix UXF icon registry',
    }),
    /project repository does not match the runner workspace repository/
  );
  state.projectRepositoryUrls = [registeredFileRepositoryUrl];
  assert.equal(progress.length, progressBeforeFinalizationStateChecks);

  const progressBeforeIdentityCheck = progress.length;
  state.expectedProjectPath = 'other/project';
  await assert.rejects(
    finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix UXF icon registry',
    }),
    /GitLab project identity changed/
  );
  state.expectedProjectPath = 'group/project';
  progress.splice(progressBeforeIdentityCheck);

  return { prepared, stateFileName };
}
