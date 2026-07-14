import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(cp.execFile);
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'omniboard-mcp-runner-test-')
);
const remotePath = path.join(root, 'group', 'project.git');
const seedPath = path.join(root, 'seed');
const originalCwd = process.cwd();
const registeredFileRepositoryUrl = pathToFileUrl(remotePath);
const tokenLeakPath = path.join(root, 'token-leak.txt');
const serverSecretLeakPath = path.join(root, 'server-secret-leak.txt');
const ambientSecretLeakPath = path.join(root, 'ambient-secret-leak.txt');
const runnerRoot = path.join(root, '.omniboard', 'mcp');
const progress = [];
const repositoryAccessRequests = [];
let projectRepositoryUrls = [registeredFileRepositoryUrl];
let repositoryAccessHost = 'gitlab.example.com';
let expectedProjectPath = normalizeProjectPath(remotePath);
let includeProjectPath = true;
let mergeRequestPayload;
let mergeRequestCreateCount = 0;
let mergeRequestLookupCount = 0;
let canPush = true;

try {
  process.chdir(root);
  await fs.mkdir(path.dirname(remotePath), { recursive: true });
  await execFile('git', ['init', '--bare', remotePath]);
  await fs.mkdir(seedPath);
  await execFile('git', ['init'], { cwd: seedPath });
  await execFile('git', ['config', 'user.name', 'Runner Test'], {
    cwd: seedPath,
  });
  await execFile('git', ['config', 'user.email', 'runner@example.com'], {
    cwd: seedPath,
  });
  await fs.writeFile(path.join(seedPath, 'README.md'), '# Runner test\n');
  await execFile('git', ['add', 'README.md'], { cwd: seedPath });
  await execFile('git', ['commit', '-m', 'Initial commit'], { cwd: seedPath });
  await execFile('git', ['branch', '-M', 'main'], { cwd: seedPath });
  await execFile(
    'git',
    ['remote', 'add', 'origin', pathToFileUrl(remotePath)],
    {
      cwd: seedPath,
    }
  );
  await execFile('git', ['push', '-u', 'origin', 'main'], { cwd: seedPath });
  await execFile('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: remotePath,
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const body = await readJsonBody(request);
    response.setHeader('Content-Type', 'application/json');

    if (request.method === 'GET' && url.pathname === '/mcp/matched-projects') {
      return send(response, {
        check: { name: 'uxf-icon-registry', type: 'regex', agentic: true },
        run: {
          runKey: 'run-uxf',
          checkName: 'uxf-icon-registry',
          prompt: 'Update the icon registry.',
          status: 'active',
          isActive: true,
        },
        runs: [
          {
            runKey: 'run-uxf',
            checkName: 'uxf-icon-registry',
            prompt: 'Update the icon registry.',
            status: 'active',
            isActive: true,
          },
        ],
        projects: [
          {
            id: 1,
            name: 'project-a',
            value: true,
            result: { value: true },
            repositoryUrl: projectRepositoryUrls[0],
            repositoryUrls: projectRepositoryUrls,
          },
        ],
        total: 1,
      });
    }

    if (request.method === 'GET' && url.pathname === '/mcp/run') {
      return send(response, {
        project: { id: 1, name: 'project-a' },
        check: {
          name: 'uxf-icon-registry',
          type: 'regex',
          agentic: true,
          prompt: 'Update the icon registry.',
        },
        run: {
          runKey: 'run-uxf',
          checkName: 'uxf-icon-registry',
          prompt: 'Update the icon registry.',
          status: 'active',
          isActive: true,
        },
        result: { value: true },
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp/repository-access'
    ) {
      assert(projectRepositoryUrls.includes(body.repositoryUrl));
      repositoryAccessRequests.push(body.repositoryUrl);
      return send(response, {
        provider: 'gitlab',
        host: repositoryAccessHost,
        apiBaseUrl: `http://127.0.0.1:${server.address().port}/gitlab/api/v4`,
        ...(includeProjectPath ? { projectPath: expectedProjectPath } : {}),
        token: 'test-token',
      });
    }

    if (
      request.method === 'PUT' &&
      url.pathname === '/agentic-check-run-progress'
    ) {
      progress.push(body);
      return send(response, { changed: true, row: body });
    }

    if (request.method === 'POST' && url.pathname === '/gitlab/api/graphql') {
      assert.equal(body.variables.projectPath, expectedProjectPath);
      return send(response, {
        data: {
          project: {
            userPermissions: {
              pushCode: canPush,
              createMergeRequestIn: true,
              createMergeRequestFrom: true,
            },
          },
        },
      });
    }

    if (
      request.method === 'GET' &&
      /\/gitlab\/api\/v4\/projects\/.+\/merge_requests$/.test(url.pathname)
    ) {
      mergeRequestLookupCount += 1;
      assert.equal(url.searchParams.get('state'), 'opened');
      assert.equal(url.searchParams.get('source_branch'), 'agentic/run-uxf');
      assert.equal(url.searchParams.get('target_branch'), 'main');
      return send(response, [
        {
          id: 9,
          iid: 3,
          web_url:
            'https://gitlab.example.com/group/project/-/merge_requests/3',
          state: 'opened',
          title: 'Fix UXF icon registry',
        },
      ]);
    }

    if (
      request.method === 'GET' &&
      /\/gitlab\/api\/v4\/projects\/.+$/.test(url.pathname)
    ) {
      return send(response, {
        archived: false,
        repository_access_level: 'enabled',
        merge_requests_access_level: 'enabled',
        permissions: {
          project_access: { access_level: 30 },
          group_access: null,
        },
      });
    }

    if (
      request.method === 'POST' &&
      /\/gitlab\/api\/v4\/projects\/.+\/merge_requests$/.test(url.pathname)
    ) {
      mergeRequestCreateCount += 1;
      mergeRequestPayload = body;
      if (mergeRequestCreateCount > 1) {
        response.statusCode = 409;
        return send(response, {
          message: 'Cannot Create: This merge request already exists',
        });
      }
      response.statusCode = 201;
      return send(response, {
        id: 9,
        iid: 3,
        web_url: 'https://gitlab.example.com/group/project/-/merge_requests/3',
        state: 'opened',
        title: body.title,
      });
    }

    response.statusCode = 404;
    return send(response, {
      message: `Unhandled ${request.method} ${url.pathname}`,
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    process.env.OMNIBOARD_API_KEY_MCP = 'test-mcp-key';
    process.env.OMNIBOARD_API_KEY = 'test-analyzer-key';
    process.env.OMNIBOARD_API_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.UNRELATED_RUNNER_SECRET = 'ambient-secret';
    delete process.env.OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS;
    const { prepareRunnerWorkspace, finalizeRunnerWorkspace } = await import(
      '../dist/services/runner-workspace.service.js'
    );
    const { reportRunnerAgenticRunProgress } = await import(
      '../dist/services/agentic-runs.service.js'
    );

    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      }),
      /secure HTTPS/
    );
    process.env.OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS = 'true';

    await reportRunnerAgenticRunProgress('run-uxf', 'project-a', {
      status: 'in_progress',
      metadata: { executionMode: 'caller-controlled' },
    });
    assert.equal(progress.at(-1).metadata.executionMode, 'dedicated-runner');
    progress.length = 0;

    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
        repositoryUrl: 'https://gitlab.example.com/unrelated/project.git',
      }),
      /not registered on the matched Omniboard project/
    );
    progress.length = 0;

    projectRepositoryUrls = ['https://untrusted.example.com/group/project.git'];
    expectedProjectPath = 'group/project';
    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      }),
      /does not match credential host/
    );

    projectRepositoryUrls = ['http://gitlab.example.com/group/project.git'];
    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      }),
      /secure HTTPS/
    );

    projectRepositoryUrls = [
      'git@gitlab.example.com:group/project.git',
      'https://gitlab.example.com/group/project.git',
    ];
    expectedProjectPath = 'group/project';
    includeProjectPath = false;
    canPush = false;
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

    projectRepositoryUrls = ['https://gitlab.example.com/group/project.git'];
    expectedProjectPath = 'other/project';
    includeProjectPath = true;
    canPush = true;
    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      }),
      /does not match repository URL project/
    );

    if (process.platform !== 'win32') {
      projectRepositoryUrls = [registeredFileRepositoryUrl];
      expectedProjectPath = 'group/project';
      includeProjectPath = true;
      canPush = true;
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

    includeProjectPath = true;
    const missingRemotePath = path.join(root, 'group', 'missing.git');
    projectRepositoryUrls = [pathToFileUrl(missingRemotePath)];
    expectedProjectPath = normalizeProjectPath(missingRemotePath);
    canPush = true;
    await assert.rejects(
      prepareRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
      })
    );
    assert.deepEqual(await fs.readdir(path.join(runnerRoot, 'workspaces')), []);

    projectRepositoryUrls = [registeredFileRepositoryUrl];
    repositoryAccessHost = 'gitlab.example.com';
    expectedProjectPath = 'group/project';
    canPush = true;
    progress.length = 0;

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
        commitMessage: 'fix: update icon registry',
      }),
      /no verified runner commit to resume/
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
    progress.length = 0;

    await fs.writeFile(path.join(runnerRoot, '.gitignore'), 'custom/\n');

    const prepared = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      repositoryUrl: pathToFileUrl(remotePath).replace(/\.git$/, ''),
      branch: 'agentic/run-uxf',
    });
    assert.equal(prepared.workspace.branch, 'agentic/run-uxf');
    assert.equal(prepared.workspace.targetBranch, 'main');
    assert.equal(prepared.workspace.projectPath, 'group/project');
    assert.match(prepared.workspace.preparedHeadSha, /^[a-f0-9]{40}$/);
    assert.equal(prepared.prompt, 'Update the icon registry.');
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
        commitMessage: 'fix: update icon registry',
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
        commitMessage: 'fix: update icon registry',
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

    const progressBeforeIdentityCheck = progress.length;
    expectedProjectPath = 'other/project';
    await assert.rejects(
      finalizeRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
        localPath: prepared.workspace.localPath,
        commitMessage: 'fix: update icon registry',
        mergeRequestTitle: 'Fix UXF icon registry',
      }),
      /GitLab project identity changed/
    );
    expectedProjectPath = 'group/project';
    progress.splice(progressBeforeIdentityCheck);

    const finalized = await finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      commitMessage: 'fix: update icon registry',
      mergeRequestTitle: 'Fix UXF icon registry',
    });

    assert.match(finalized.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(
      finalized.mergeRequest.url,
      'https://gitlab.example.com/group/project/-/merge_requests/3'
    );
    const retried = await finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      commitMessage: 'fix: update icon registry',
      mergeRequestTitle: 'Fix UXF icon registry',
    });
    assert.equal(retried.commitSha, finalized.commitSha);
    await assert.rejects(fs.access(tokenLeakPath));
    await assert.rejects(fs.access(serverSecretLeakPath));
    if (process.platform !== 'win32') {
      assert.equal(await fs.readFile(ambientSecretLeakPath, 'utf8'), 'unset');
    }

    assert.equal(mergeRequestCreateCount, 2);
    assert.equal(mergeRequestLookupCount, 1);
    assert.deepEqual(await fs.readdir(path.join(runnerRoot, 'state')), [
      stateFileName,
    ]);
    assert.equal(mergeRequestPayload.source_branch, 'agentic/run-uxf');
    assert.equal(mergeRequestPayload.target_branch, 'main');
    assert.deepEqual(
      progress.map((item) => item.status),
      [
        'in_progress',
        'committed',
        'pushed',
        'mr_created',
        'committed',
        'pushed',
        'mr_created',
      ]
    );
    const { stdout } = await execFile(
      'git',
      ['show-ref', '--verify', 'refs/heads/agentic/run-uxf'],
      { cwd: remotePath }
    );
    assert.match(stdout, /^[a-f0-9]{40}/);

    if (process.platform !== 'win32') {
      const realWorkspacePath = `${prepared.workspace.localPath}-real`;
      await fs.rename(prepared.workspace.localPath, realWorkspacePath);
      await fs.symlink(realWorkspacePath, prepared.workspace.localPath, 'dir');
      await assert.rejects(
        finalizeRunnerWorkspace({
          runKey: 'run-uxf',
          projectName: 'project-a',
          localPath: prepared.workspace.localPath,
          commitMessage: 'fix: update icon registry',
          mergeRequestTitle: 'Fix UXF icon registry',
        }),
        /must not be a symlink/
      );
    }

    console.log('Dedicated runner integration test passed.');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
} finally {
  process.chdir(originalCwd);
  await fs.rm(root, { recursive: true, force: true });
}

async function commitForTest(targetDir, message) {
  await execFile('git', ['add', '--all'], { cwd: targetDir });
  await execFile(
    'git',
    [
      '-c',
      'user.name=Runner Test',
      '-c',
      'user.email=runner@example.com',
      'commit',
      '-m',
      message,
    ],
    { cwd: targetDir }
  );
}

function normalizeProjectPath(value) {
  return value.replace(/^\/+/, '').replace(/\.git$/, '');
}

function pathToFileUrl(value) {
  return new URL(`file://${value}`).toString();
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
    : {};
}

function send(response, body) {
  response.end(JSON.stringify(body));
}
