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
let bitbucketPullRequestPayload;
let bitbucketAuthorization;
let bitbucketPullRequestCreateCount = 0;
let bitbucketPullRequestLookupCount = 0;
let mergeRequestCreateCount = 0;
let mergeRequestLookupCount = 0;
let pipelineRetryCount = 0;
let agenticRunLookupCount = 0;
let matchedProjectsLookupCount = 0;
let canPush = true;
let projectProgressStatus = 'pending';
let projectProgressBranch = 'agentic/run-uxf';
let projectPipelineStatus = null;
let projectPipelineUrl = null;
let projectPipelineFailureReason = 'script_failure';
let projectMergeRequestUrl = null;
let projectMergeRequestState = null;
let projectMatchesCheck = true;
let providerSyncSuccess = true;

try {
  process.chdir(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"project-a"}');
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

    if (request.method === 'GET' && url.pathname === '/settings/cli') {
      return send(response, {});
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp/run-project-state/refresh'
    ) {
      assert.equal(body.runKey, 'run-uxf');
      assert.equal(body.projectName, 'project-a');
      return send(response, {
        run: {
          runKey: 'run-uxf',
          checkName: 'uxf-icon-registry',
          prompt: 'Update the icon registry.',
          branchName: 'agentic/run-uxf',
          commitMessage: 'fix(OB-123): update icon registry',
          status: 'active',
          isActive: true,
        },
        project: {
          id: 1,
          name: 'project-a',
          currentlyMatchesCheck: projectMatchesCheck,
          repositoryUrl: projectRepositoryUrls[0],
          repositoryUrls: projectRepositoryUrls,
        },
        progress: {
          status: projectProgressStatus,
          branch: projectProgressBranch,
          mergeRequestUrl: projectMergeRequestUrl,
          mergeRequestState: projectMergeRequestState,
          pipelineStatus: projectPipelineStatus,
          pipelineUrl: projectPipelineUrl,
          pipelineFailureSummary:
            projectPipelineStatus === 'failed' ? 'unit-tests failed' : null,
        },
        providerSync: {
          attempted: !!projectMergeRequestUrl,
          success: providerSyncSuccess,
          error: providerSyncSuccess ? null : 'provider unavailable',
          diagnostics:
            projectPipelineStatus === 'failed'
              ? [
                  {
                    name: 'unit-tests',
                    stage: 'test',
                    status: 'failed',
                    failureReason: projectPipelineFailureReason,
                    traceExcerpt: 'Expected true, received false',
                  },
                ]
              : [],
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/mcp/matched-projects') {
      matchedProjectsLookupCount += 1;
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
      agenticRunLookupCount += 1;
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
          branchName: 'agentic/run-uxf',
          commitMessage: 'fix(OB-123): update icon registry',
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

    if (
      request.method === 'GET' &&
      url.pathname === '/bitbucket/rest/api/latest/projects/OB/repos/project-a'
    ) {
      bitbucketAuthorization = request.headers.authorization;
      return send(response, {
        archived: false,
        state: 'AVAILABLE',
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname ===
        '/bitbucket/rest/api/latest/projects/OB/repos/project-a/pull-requests'
    ) {
      bitbucketPullRequestLookupCount += 1;
      assert.equal(url.searchParams.get('state'), 'OPEN');
      assert.equal(url.searchParams.get('at'), 'refs/heads/main');
      if (!url.searchParams.has('start')) {
        return send(response, {
          values: [],
          isLastPage: false,
          nextPageStart: 25,
        });
      }
      assert.equal(url.searchParams.get('start'), '25');
      return send(response, {
        values: [
          {
            id: 17,
            state: 'OPEN',
            title: bitbucketPullRequestPayload.title,
            fromRef: bitbucketPullRequestPayload.fromRef,
            toRef: bitbucketPullRequestPayload.toRef,
            links: {
              self: [
                {
                  href: 'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17',
                },
              ],
            },
          },
        ],
        isLastPage: true,
      });
    }
    if (
      request.method === 'POST' &&
      url.pathname ===
        '/bitbucket/rest/api/latest/projects/OB/repos/project-a/pull-requests'
    ) {
      bitbucketPullRequestCreateCount += 1;
      bitbucketAuthorization = request.headers.authorization;
      bitbucketPullRequestPayload = body;
      if (bitbucketPullRequestCreateCount > 1) {
        response.statusCode = 409;
        return send(response, {
          errors: [{ message: 'A pull request already exists.' }],
        });
      }
      response.statusCode = 201;
      return send(response, {
        id: 17,
        state: 'OPEN',
        title: body.title,
        fromRef: body.fromRef,
        toRef: body.toRef,
        links: {
          self: [
            {
              href: 'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17',
            },
          ],
        },
      });
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
      request.method === 'POST' &&
      /\/gitlab\/api\/v4\/projects\/.+\/pipelines\/321\/retry$/.test(
        url.pathname
      )
    ) {
      pipelineRetryCount += 1;
      assert.equal(request.headers['private-token'], 'test-token');
      response.statusCode = 201;
      return send(response, {
        id: 321,
        status: 'pending',
        web_url: 'https://gitlab.example.com/group/project/-/pipelines/321',
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
    const {
      prepareRunnerWorkspace,
      finalizeRunnerWorkspace,
      resolveRunnerGitValues,
    } = await import('../dist/services/runner-workspace.service.js');

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
      getAgenticRun,
      reportAgenticRunProgress,
      reportRunnerAgenticRunProgress,
    } = await import('../dist/services/agentic-runs.service.js');
    const { validateAgenticRun } = await import(
      '../dist/services/analyzer-validation.service.js'
    );
    const { getAgenticRunContinuationDecision } = await import(
      '../dist/services/agentic-run-continuation.service.js'
    );

    const continuationDecision = (status, mergeRequestDetailedStatus = null) =>
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
        progress: { status, mergeRequestDetailedStatus },
        providerSync: { attempted: false, success: true, diagnostics: [] },
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
    const {
      createChangeRequest,
      resolveGitUsername,
      retryFailedPipeline,
      validateRepositoryAccess,
    } = await import('../dist/services/source-control.service.js');

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
      bitbucketAuthorization,
      `Basic ${Buffer.from('omniboard-service:bitbucket-token').toString(
        'base64'
      )}`
    );
    assert.deepEqual(bitbucketPullRequestPayload.fromRef, {
      id: 'refs/heads/agentic/run-uxf',
      repository: {
        slug: 'project-a',
        project: { key: 'OB' },
      },
    });
    assert.deepEqual(bitbucketPullRequestPayload.toRef, {
      id: 'refs/heads/main',
      repository: {
        slug: 'project-a',
        project: { key: 'OB' },
      },
    });
    assert.equal(
      bitbucketPullRequestPayload.description,
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
    assert.equal(bitbucketPullRequestCreateCount, 2);
    assert.equal(bitbucketPullRequestLookupCount, 2);
    assert.equal(
      bitbucketPullRequestPayload.description,
      'Use `\\n` when documenting escaped line breaks.'
    );

    await reportRunnerAgenticRunProgress('run-uxf', 'project-a', {
      status: 'in_progress',
      localPath: '/runner/project-a',
      metadata: { executionMode: 'caller-controlled' },
    });
    const callerControlledProgress = progress.at(-1);
    assert.equal(
      callerControlledProgress.metadata.executionMode,
      'dedicated-runner'
    );
    assert.equal(callerControlledProgress.localPath, '/runner/project-a');
    assert.equal('pipelineStatus' in callerControlledProgress, false);
    assert.equal('mergeRequestUrl' in callerControlledProgress, false);

    await reportAgenticRunProgress('run-uxf', { status: 'in_progress' });
    assert.equal(progress.at(-1).localPath, root);
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

    projectProgressBranch = 'agentic/retry-guard';
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
    projectProgressBranch = 'agentic/run-uxf';
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
    assert.equal(
      preparedAgain.workspace.localPath,
      prepared.workspace.localPath
    );
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
    projectProgressBranch = 'agentic/reassigned';
    await assert.rejects(
      finalizeRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
        localPath: prepared.workspace.localPath,
        mergeRequestTitle: 'Fix UXF icon registry',
      }),
      /provider branch.*does not match runner workspace branch/i
    );
    projectProgressBranch = 'agentic/run-uxf';

    projectRepositoryUrls = [
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
    projectRepositoryUrls = [registeredFileRepositoryUrl];
    assert.equal(progress.length, progressBeforeFinalizationStateChecks);

    const progressBeforeIdentityCheck = progress.length;
    expectedProjectPath = 'other/project';
    await assert.rejects(
      finalizeRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
        localPath: prepared.workspace.localPath,
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
      mergeRequestTitle: 'Fix UXF icon registry',
      mergeRequestDescription:
        '## Summary\\n- Update the icon registry.\\n\\n## Verification\\n- Tests passed.',
    });

    assert.match(finalized.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(
      finalized.mergeRequest.url,
      'https://gitlab.example.com/group/project/-/merge_requests/3'
    );
    assert.equal(
      mergeRequestPayload.description,
      '## Summary\n- Update the icon registry.\n\n## Verification\n- Tests passed.'
    );
    const retried = await finalizeRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
      localPath: prepared.workspace.localPath,
      mergeRequestTitle: 'Fix UXF icon registry',
      mergeRequestDescription:
        '## Summary\n- Update the icon registry.\n\n## Verification\n- Tests passed.',
    });
    assert.equal(retried.commitSha, finalized.commitSha);

    projectProgressStatus = 'failed';
    projectPipelineStatus = 'failed';
    projectMergeRequestUrl =
      'https://gitlab.example.com/group/project/-/merge_requests/3';
    projectMergeRequestState = 'opened';
    const failedPipelineContinuation = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
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

    projectPipelineFailureReason = 'runner_system_failure';
    projectPipelineUrl =
      'https://gitlab.example.com/group/project/-/pipelines/321';
    const pipelineRetriesBeforeInfrastructureWait = pipelineRetryCount;
    const matchedLookupsBeforeInfrastructureWait = matchedProjectsLookupCount;
    const runLookupsBeforeInfrastructureWait = agenticRunLookupCount;
    const infrastructureFailureContinuation = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
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
      pipelineRetryCount,
      pipelineRetriesBeforeInfrastructureWait + 1
    );
    assert(
      infrastructureFailureContinuation.instructions.some((instruction) =>
        instruction.includes('retry was requested successfully')
      )
    );
    assert.equal(
      matchedProjectsLookupCount,
      matchedLookupsBeforeInfrastructureWait
    );
    assert.equal(agenticRunLookupCount, runLookupsBeforeInfrastructureWait);
    projectPipelineFailureReason = 'script_failure';
    projectPipelineUrl = null;

    const matchedLookupsBeforeProviderWait = matchedProjectsLookupCount;
    const runLookupsBeforeProviderWait = agenticRunLookupCount;
    providerSyncSuccess = false;
    const providerFailureContinuation = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    });
    assert.equal(providerFailureContinuation.continuation.action, 'wait');
    assert.equal(
      providerFailureContinuation.continuation.reason,
      'provider_sync_failed'
    );
    assert.equal(providerFailureContinuation.workspace, undefined);
    assert.equal(matchedProjectsLookupCount, matchedLookupsBeforeProviderWait);
    assert.equal(agenticRunLookupCount, runLookupsBeforeProviderWait);
    providerSyncSuccess = true;

    projectProgressStatus = 'future_status';
    projectPipelineStatus = null;
    const unsupportedStatusContinuation = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    });
    assert.equal(unsupportedStatusContinuation.continuation.action, 'wait');
    assert.equal(
      unsupportedStatusContinuation.continuation.reason,
      'unsupported_progress_status'
    );
    assert.equal(unsupportedStatusContinuation.workspace, undefined);

    projectProgressStatus = 'merged';
    projectPipelineStatus = 'success';
    projectMergeRequestState = 'merged';
    const matchedLookupsBeforeMergedStop = matchedProjectsLookupCount;
    const runLookupsBeforeMergedStop = agenticRunLookupCount;
    const mergedPreparation = await prepareRunnerWorkspace({
      runKey: 'run-uxf',
      projectName: 'project-a',
    });
    assert.equal(mergedPreparation.projectState.progress.status, 'merged');
    assert.equal(mergedPreparation.continuation.action, 'stop');
    assert.equal(mergedPreparation.workspace, undefined);
    assert.equal(matchedProjectsLookupCount, matchedLookupsBeforeMergedStop);
    assert.equal(agenticRunLookupCount, runLookupsBeforeMergedStop);

    const mergeRequestCreateCountBeforeStoppedFinalize =
      mergeRequestCreateCount;
    const progressCountBeforeStoppedFinalize = progress.length;
    await assert.rejects(
      finalizeRunnerWorkspace({
        runKey: 'run-uxf',
        projectName: 'project-a',
        localPath: prepared.workspace.localPath,
        mergeRequestTitle: 'Fix UXF icon registry',
      }),
      /finalization is not permitted.*"stop".*change_merged/
    );
    assert.equal(
      mergeRequestCreateCount,
      mergeRequestCreateCountBeforeStoppedFinalize
    );
    assert.equal(progress.length, progressCountBeforeStoppedFinalize);

    const progressCountBeforeLocalStop = progress.length;
    const runLookupsBeforeLocalStop = agenticRunLookupCount;
    const localMergedRun = await getAgenticRun('run-uxf');
    assert.equal(localMergedRun.continuation.action, 'stop');
    assert.deepEqual(
      localMergedRun.agentContext.instructions,
      mergedPreparation.instructions
    );
    assert.equal(localMergedRun.agentContext.validation.allowed, false);
    assert.equal(agenticRunLookupCount, runLookupsBeforeLocalStop);
    assert.equal(progress.length, progressCountBeforeLocalStop);

    const skippedMergedValidation = await validateAgenticRun('run-uxf');
    assert.equal(skippedMergedValidation.skipped, true);
    assert.equal(skippedMergedValidation.continuation.action, 'stop');
    assert.equal(skippedMergedValidation.progressReport, undefined);
    assert.equal(progress.length, progressCountBeforeLocalStop);

    const runLookupCountBeforeNoMatch = agenticRunLookupCount;
    const progressCountBeforeNoMatch = progress.length;
    projectMatchesCheck = false;
    const localNoMatchRun = await getAgenticRun('run-uxf');
    assert.equal(localNoMatchRun.continuation.action, 'stop');
    assert.equal(
      localNoMatchRun.continuation.reason,
      'project_no_longer_matches'
    );
    assert.equal(agenticRunLookupCount, runLookupCountBeforeNoMatch);
    assert.equal(progress.length, progressCountBeforeNoMatch);
    projectMatchesCheck = true;

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
        'in_progress',
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
