import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runAgenticRunIntegration } from './runner-workspace/agentic-run.integration.ts';
import { runPostMergeRequestContinuationIntegration } from './runner-workspace/continuation.integration.ts';
import { runWorkspacePreparationIntegration } from './runner-workspace/preparation.integration.ts';
import { runWorkspaceRecoveryIntegration } from './runner-workspace/recovery.integration.ts';

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
const progress: any[] = [];
const repositoryAccessRequests: string[] = [];
const state: Record<string, any> = {
  projectRepositoryUrls: [registeredFileRepositoryUrl],
  repositoryAccessHost: 'gitlab.example.com',
  expectedProjectPath: normalizeProjectPath(remotePath),
  includeProjectPath: true,
  mergeRequestPayload: undefined,
  bitbucketPullRequestPayload: undefined,
  bitbucketAuthorization: undefined,
  bitbucketPullRequestCreateCount: 0,
  bitbucketPullRequestLookupCount: 0,
  mergeRequestCreateCount: 0,
  mergeRequestLookupCount: 0,
  mergeRequestDetailedStatus: 'mergeable',
  mergeRequestRebaseInProgress: false,
  mergeRequestRebaseRequestCount: 0,
  mergeRequestTargetBranch: 'main',
  mergeRequestLookupFailures: 0,
  pipelineRetryCount: 0,
  agenticRunLookupCount: 0,
  matchedProjectsLookupCount: 0,
  canPush: true,
  projectProgressStatus: 'pending',
  projectProgressBranch: 'agentic/run-uxf',
  projectPipelineStatus: null,
  projectPipelineUrl: null,
  projectPipelineFailureReason: 'script_failure',
  projectMergeRequestUrl: null,
  projectMergeRequestState: null,
  projectMergeRequestDetailedStatus: null,
  projectMatchesCheck: true,
  providerSyncSuccess: true,
};

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
          currentlyMatchesCheck: state.projectMatchesCheck,
          repositoryUrl: state.projectRepositoryUrls[0],
          repositoryUrls: state.projectRepositoryUrls,
        },
        progress: {
          status: state.projectProgressStatus,
          branch: state.projectProgressBranch,
          mergeRequestUrl: state.projectMergeRequestUrl,
          mergeRequestState: state.projectMergeRequestState,
          mergeRequestDetailedStatus: state.projectMergeRequestDetailedStatus,
          pipelineStatus: state.projectPipelineStatus,
          pipelineUrl: state.projectPipelineUrl,
          pipelineFailureSummary:
            state.projectPipelineStatus === 'failed'
              ? 'unit-tests failed'
              : null,
        },
        providerSync: {
          attempted: !!state.projectMergeRequestUrl,
          success: state.providerSyncSuccess,
          error: state.providerSyncSuccess ? null : 'provider unavailable',
          diagnostics:
            state.projectPipelineStatus === 'failed'
              ? [
                  {
                    name: 'unit-tests',
                    stage: 'test',
                    status: 'failed',
                    failureReason: state.projectPipelineFailureReason,
                    traceExcerpt: 'Expected true, received false',
                  },
                ]
              : [],
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/mcp/matched-projects') {
      state.matchedProjectsLookupCount += 1;
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
            repositoryUrl: state.projectRepositoryUrls[0],
            repositoryUrls: state.projectRepositoryUrls,
          },
        ],
        total: 1,
      });
    }

    if (request.method === 'GET' && url.pathname === '/mcp/run') {
      state.agenticRunLookupCount += 1;
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
      assert(state.projectRepositoryUrls.includes(body.repositoryUrl));
      repositoryAccessRequests.push(body.repositoryUrl);
      return send(response, {
        provider: 'gitlab',
        host: state.repositoryAccessHost,
        apiBaseUrl: `http://127.0.0.1:${getServerPort(server)}/gitlab/api/v4`,
        ...(state.includeProjectPath
          ? { projectPath: state.expectedProjectPath }
          : {}),
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
      state.bitbucketAuthorization = request.headers.authorization;
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
      state.bitbucketPullRequestLookupCount += 1;
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
            title: state.bitbucketPullRequestPayload.title,
            fromRef: state.bitbucketPullRequestPayload.fromRef,
            toRef: state.bitbucketPullRequestPayload.toRef,
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
      state.bitbucketPullRequestCreateCount += 1;
      state.bitbucketAuthorization = request.headers.authorization;
      state.bitbucketPullRequestPayload = body;
      if (state.bitbucketPullRequestCreateCount > 1) {
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
      assert.equal(body.variables.projectPath, state.expectedProjectPath);
      return send(response, {
        data: {
          project: {
            userPermissions: {
              pushCode: state.canPush,
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
      state.pipelineRetryCount += 1;
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
      /\/gitlab\/api\/v4\/projects\/.+\/merge_requests\/3$/.test(url.pathname)
    ) {
      if (state.mergeRequestLookupFailures > 0) {
        state.mergeRequestLookupFailures -= 1;
        response.statusCode = 503;
        return send(response, { message: 'Temporary provider failure' });
      }
      assert.equal(url.searchParams.get('include_rebase_in_progress'), 'true');
      return send(response, {
        id: 9,
        iid: 3,
        web_url: 'https://gitlab.example.com/group/project/-/merge_requests/3',
        state: 'opened',
        title: 'Fix UXF icon registry',
        source_branch: 'agentic/run-uxf',
        target_branch: state.mergeRequestTargetBranch,
        detailed_merge_status: state.mergeRequestDetailedStatus,
        rebase_in_progress: state.mergeRequestRebaseInProgress,
      });
    }

    if (
      request.method === 'PUT' &&
      /\/gitlab\/api\/v4\/projects\/.+\/merge_requests\/3\/rebase$/.test(
        url.pathname
      )
    ) {
      state.mergeRequestRebaseRequestCount += 1;
      state.mergeRequestRebaseInProgress = true;
      response.statusCode = 202;
      return send(response, { rebase_in_progress: true });
    }

    if (
      request.method === 'GET' &&
      /\/gitlab\/api\/v4\/projects\/.+\/merge_requests$/.test(url.pathname)
    ) {
      state.mergeRequestLookupCount += 1;
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
      state.mergeRequestCreateCount += 1;
      state.mergeRequestPayload = body;
      if (state.mergeRequestCreateCount > 1) {
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
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );

  try {
    process.env.OMNIBOARD_API_KEY_MCP = 'test-mcp-key';
    process.env.OMNIBOARD_API_KEY = 'test-analyzer-key';
    process.env.OMNIBOARD_API_URL = `http://127.0.0.1:${getServerPort(server)}`;
    process.env.UNRELATED_RUNNER_SECRET = 'ambient-secret';
    delete process.env.OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS;
    const {
      prepareRunnerWorkspace,
      finalizeRunnerWorkspace,
      resolveRunnerGitValues,
    } = await import('../../dist/services/runner-workspace.service.js');
    const { writeRunnerState } = await import(
      '../../dist/services/runner-workspace-store.service.js'
    );

    const context = {
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
    };

    await runAgenticRunIntegration(context);
    Object.assign(context, await runWorkspacePreparationIntegration(context));
    await runWorkspaceRecoveryIntegration(context);
    await runPostMergeRequestContinuationIntegration(context);

    console.log('Dedicated runner integration test passed.');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
} finally {
  process.chdir(originalCwd);
  await fs.rm(root, { recursive: true, force: true });
}

async function commitForTest(targetDir: string, message: string) {
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

function normalizeProjectPath(value: string) {
  return value.replace(/^\/+/, '').replace(/\.git$/, '');
}

function pathToFileUrl(value: string) {
  return new URL(`file://${value}`).toString();
}

async function readJsonBody(
  request: import('node:http').IncomingMessage
): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
    : {};
}

function send(response: import('node:http').ServerResponse, body: unknown) {
  response.end(JSON.stringify(body));
}

function getServerPort(server: import('node:http').Server) {
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}
