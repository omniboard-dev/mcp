import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runAgenticRunIntegration } from './runner-workspace/agentic-run.integration.ts';
import { runPostMergeRequestContinuationIntegration } from './runner-workspace/continuation.integration.ts';
import { runWorkspaceCredentialsIntegration } from './runner-workspace/credentials.integration.ts';
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
  repositoryAccessProvider: 'gitlab',
  expectedProjectPath: normalizeProjectPath(remotePath),
  includeProjectPath: true,
  mergeRequestPayload: undefined,
  bitbucketPullRequestPayload: undefined,
  bitbucketAuthorization: undefined,
  bitbucketPullRequestCreateCount: 0,
  bitbucketPullRequestLookupCount: 0,
  bitbucketPullRequestLookupFailures: 0,
  bitbucketProviderSnapshotCount: 0,
  bitbucketPullRequestState: 'OPEN',
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
  projectArchived: false,
  projectProgressStatus: 'pending',
  projectProgressResolution: null,
  projectRetryInstructions: [],
  projectProgressBranch: 'agentic/run-icons',
  projectPipelineStatus: null,
  projectPipelineUrl: null,
  projectPipelineFailureReason: 'script_failure',
  projectPipelineFailureSummary: 'unit-tests failed',
  projectPipelineTraceExcerpt: 'Expected true, received false',
  projectMergeRequestUrl: null,
  projectMergeRequestState: null,
  projectMergeRequestDetailedStatus: null,
  projectMatchesCheck: true,
  projectFulfillment: 'fulfilled',
  providerSyncSuccess: true,
  runnerExecution: null,
  runnerLeaseToken: null,
  recoveryCheckpointFailures: 0,
  runnerCompletionByIdentityPhases: [],
};

function matchedProject(fulfillment: string, value: boolean | string) {
  return {
    id: 1,
    name: 'project-a',
    value,
    result: { value },
    fulfillment,
    repositoryUrl: state.projectRepositoryUrls[0],
    repositoryUrls: state.projectRepositoryUrls,
  };
}

try {
  process.chdir(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"project-a"}');
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'MCP Startup User'], {
    cwd: root,
  });
  await execFile('git', ['config', 'user.email', 'startup@example.com'], {
    cwd: root,
  });
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

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp-cli/run-executions/acquire'
    ) {
      let execution = state.runnerExecution;
      if (!execution) {
        execution = createRunnerExecution(body);
        state.runnerExecution = execution;
      } else if (
        execution.phase === 'preparing' &&
        !execution.preparedHeadSha
      ) {
        Object.assign(execution, {
          repositoryUrl: body.repositoryUrl,
          sourceControlProvider: body.sourceControlProvider,
          sourceControlRepositoryId: body.sourceControlRepositoryId,
          branch: body.branch,
          commitMessage: body.commitMessage ?? null,
        });
      } else if (
        execution.sourceControlProvider !== body.sourceControlProvider ||
        execution.sourceControlRepositoryId !==
          body.sourceControlRepositoryId ||
        execution.branch !== body.branch
      ) {
        response.statusCode = 409;
        return send(response, {
          message:
            'Existing runner execution identity does not match the request',
        });
      }
      if (
        state.runnerLeaseToken &&
        body.leaseToken !== state.runnerLeaseToken
      ) {
        response.statusCode = 409;
        return send(response, {
          message: 'Runner execution is leased by another MCP CLI process',
        });
      }
      state.runnerLeaseToken = body.leaseToken ?? 'a'.repeat(64);
      execution.leaseOwner = body.leaseOwner;
      execution.leaseExpiresAt = new Date(Date.now() + 300_000).toISOString();
      execution.heartbeatAt = new Date().toISOString();
      return send(response, {
        execution,
        leaseToken: state.runnerLeaseToken,
      });
    }

    const runnerExecutionMatch =
      /^\/mcp-cli\/run-executions\/([^/]+)\/(renew|checkpoint|reinitialize|complete|release)$/.exec(
        url.pathname
      );
    if (runnerExecutionMatch && state.runnerExecution) {
      const [, executionKey, operation] = runnerExecutionMatch;
      const execution = state.runnerExecution;
      if (executionKey !== execution.executionKey) {
        response.statusCode = 404;
        return send(response, { message: 'Runner execution not found' });
      }
      if (body.leaseToken !== state.runnerLeaseToken) {
        response.statusCode = 409;
        return send(response, { message: 'Runner execution lease is invalid' });
      }
      if (
        operation !== 'renew' &&
        operation !== 'release' &&
        body.expectedStateVersion !== execution.stateVersion
      ) {
        response.statusCode = 409;
        return send(response, {
          message: 'Runner execution state version changed',
        });
      }
      if (operation === 'renew') {
        execution.heartbeatAt = new Date().toISOString();
        execution.leaseExpiresAt = new Date(Date.now() + 300_000).toISOString();
        return send(response, {
          execution,
          leaseToken: state.runnerLeaseToken,
        });
      }
      if (operation === 'checkpoint') {
        if (body.recovery && state.recoveryCheckpointFailures > 0) {
          state.recoveryCheckpointFailures -= 1;
          response.statusCode = 503;
          return send(response, {
            message: 'Forced recovery checkpoint failure',
          });
        }
        for (const key of [
          'phase',
          'targetBranch',
          'commitMessage',
          'preparedHeadSha',
          'commitSha',
          'recovery',
        ]) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            execution[key] = body[key];
          }
        }
        execution.stateVersion += 1;
        return send(response, execution);
      }
      if (operation === 'reinitialize') {
        Object.assign(execution, {
          generation: execution.generation + 1,
          phase: 'preparing',
          targetBranch: null,
          preparedHeadSha: null,
          commitSha: null,
          recovery: null,
          stateVersion: execution.stateVersion + 1,
        });
        return send(response, execution);
      }
      if (operation === 'complete') {
        execution.phase = body.phase;
        execution.stateVersion += 1;
      }
      state.runnerLeaseToken = null;
      execution.leaseOwner = null;
      execution.leaseExpiresAt = null;
      execution.heartbeatAt = null;
      return send(response, execution);
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp-cli/run-executions/complete-by-identity'
    ) {
      const execution = state.runnerExecution;
      state.runnerCompletionByIdentityPhases.push(body.phase);
      if (!execution) {
        return send(response, { completed: false, execution: null });
      }
      execution.phase = body.phase;
      execution.stateVersion += 1;
      state.runnerLeaseToken = null;
      execution.leaseOwner = null;
      execution.leaseExpiresAt = null;
      execution.heartbeatAt = null;
      return send(response, { completed: true, execution });
    }

    if (request.method === 'GET' && url.pathname === '/mcp-cli/settings') {
      return send(response, {});
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp-cli/run-project-state/refresh'
    ) {
      assert.equal(body.runKey, 'run-icons');
      assert.equal(body.projectName, 'project-a');
      return send(response, {
        run: {
          runKey: 'run-icons',
          checkName: 'icon-registry',
          prompt: 'Update the icon registry.',
          branchName: 'agentic/run-icons',
          commitMessage: 'fix(OB-123): update icon registry',
          status: 'active',
          isActive: true,
        },
        project: {
          id: 1,
          name: 'project-a',
          currentlyMatchesCheck: state.projectMatchesCheck,
          fulfillment: state.projectFulfillment,
          repositoryUrl: state.projectRepositoryUrls[0],
          repositoryUrls: state.projectRepositoryUrls,
        },
        progress: {
          status: state.projectProgressStatus,
          resolution: state.projectProgressResolution,
          branch: state.projectProgressBranch,
          mergeRequestUrl: state.projectMergeRequestUrl,
          mergeRequestState: state.projectMergeRequestState,
          mergeRequestDetailedStatus: state.projectMergeRequestDetailedStatus,
          pipelineStatus: state.projectPipelineStatus,
          pipelineUrl: state.projectPipelineUrl,
          pipelineFailureSummary:
            state.projectPipelineStatus === 'failed'
              ? state.projectPipelineFailureSummary
              : null,
          retryInstructions: state.projectRetryInstructions,
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
                    traceExcerpt: state.projectPipelineTraceExcerpt,
                  },
                ]
              : [],
        },
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp-cli/run-project-state/provider-snapshot'
    ) {
      state.bitbucketProviderSnapshotCount += 1;
      assert.equal(body.runKey, 'run-icons');
      assert.equal(body.projectName, 'project-a');
      assert.equal(body.provider, 'bitbucket_data_center');
      assert.equal(body.repositoryId, 'OB/project-a');
      assert.equal(body.changeRequestId, '17');
      state.providerSyncSuccess = true;
      state.projectMergeRequestUrl = body.mergeRequestUrl;
      state.projectMergeRequestState = body.mergeRequestState;
      state.projectMergeRequestDetailedStatus = body.mergeRequestDetailedStatus;
      state.projectPipelineStatus = body.pipelineStatus;
      state.projectPipelineUrl = body.pipelineUrl;
      if (body.mergeRequestState === 'merged') {
        state.projectProgressStatus = 'done';
        state.projectProgressResolution = 'merged';
      } else if (body.mergeRequestState === 'declined') {
        state.projectProgressStatus = 'failed';
        state.projectProgressResolution = null;
      } else {
        state.projectProgressStatus = 'mr_created';
        state.projectProgressResolution = null;
      }
      return send(response, {
        run: {
          runKey: 'run-icons',
          checkName: 'icon-registry',
          prompt: 'Update the icon registry.',
          branchName: 'agentic/run-icons',
          commitMessage: 'fix(OB-123): update icon registry',
          status: 'active',
          isActive: true,
        },
        project: {
          id: 1,
          name: 'project-a',
          currentlyMatchesCheck: state.projectMatchesCheck,
          fulfillment: state.projectFulfillment,
          repositoryUrl: state.projectRepositoryUrls[0],
          repositoryUrls: state.projectRepositoryUrls,
        },
        progress: {
          status: state.projectProgressStatus,
          resolution: state.projectProgressResolution,
          branch: state.projectProgressBranch,
          commitSha: body.commitSha,
          mergeRequestUrl: state.projectMergeRequestUrl,
          mergeRequestState: state.projectMergeRequestState,
          mergeRequestDetailedStatus: state.projectMergeRequestDetailedStatus,
          pipelineStatus: state.projectPipelineStatus,
          pipelineUrl: state.projectPipelineUrl,
          pipelineFailureSummary: body.pipelineFailureSummary,
        },
        providerSync: {
          attempted: true,
          success: true,
          error: null,
          diagnostics: body.diagnostics ?? [],
        },
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/mcp-cli/matched-projects'
    ) {
      state.matchedProjectsLookupCount += 1;
      return send(response, {
        check: { name: 'icon-registry', type: 'regex', agentic: true },
        run: {
          runKey: 'run-icons',
          checkName: 'icon-registry',
          prompt: 'Update the icon registry.',
          status: 'active',
          isActive: true,
        },
        runs: [
          {
            runKey: 'run-icons',
            checkName: 'icon-registry',
            prompt: 'Update the icon registry.',
            status: 'active',
            isActive: true,
          },
        ],
        projectGroups: {
          fulfilled:
            state.projectFulfillment === 'fulfilled'
              ? [matchedProject('fulfilled', true)]
              : [],
          unfulfilled:
            state.projectFulfillment === 'unfulfilled'
              ? [matchedProject('unfulfilled', false)]
              : [],
          unchecked:
            state.projectFulfillment === 'unchecked'
              ? [matchedProject('unchecked', 'unchecked')]
              : [],
        },
        total: 1,
        totalsByFulfillment: {
          fulfilled: state.projectFulfillment === 'fulfilled' ? 1 : 0,
          unfulfilled: state.projectFulfillment === 'unfulfilled' ? 1 : 0,
          unchecked: state.projectFulfillment === 'unchecked' ? 1 : 0,
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/mcp-cli/run') {
      state.agenticRunLookupCount += 1;
      return send(response, {
        project: { id: 1, name: 'project-a' },
        check: {
          name: 'icon-registry',
          type: 'regex',
          agentic: true,
          prompt: 'Update the icon registry.',
        },
        run: {
          runKey: 'run-icons',
          checkName: 'icon-registry',
          prompt: 'Update the icon registry.',
          branchName: 'agentic/run-icons',
          commitMessage: 'fix(OB-123): update icon registry',
          status: 'active',
          isActive: true,
        },
        result: { value: true },
      });
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/mcp-cli/repository-access'
    ) {
      assert(state.projectRepositoryUrls.includes(body.repositoryUrl));
      repositoryAccessRequests.push(body.repositoryUrl);
      if (state.repositoryAccessProvider === 'bitbucket_data_center') {
        return send(response, {
          provider: 'bitbucket_data_center',
          host: 'bitbucket.example.com',
          apiBaseUrl: `http://127.0.0.1:${getServerPort(
            server
          )}/bitbucket/rest/api/latest`,
          username: 'omniboard-service',
          token: 'bitbucket-token',
        });
      }
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

    if (request.method === 'PUT' && url.pathname === '/mcp-cli/progress') {
      progress.push(body);
      return send(response, { changed: true, row: body });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/bitbucket/rest/api/latest/projects/OB/repos/project-a'
    ) {
      state.bitbucketAuthorization = request.headers.authorization;
      return send(response, {
        archived: state.projectArchived,
        state: 'AVAILABLE',
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname ===
        '/bitbucket/rest/api/latest/projects/OB/repos/project-a/pull-requests/17'
    ) {
      if (state.bitbucketPullRequestLookupFailures > 0) {
        state.bitbucketPullRequestLookupFailures -= 1;
        response.statusCode = 503;
        return send(response, { message: 'Temporary provider failure' });
      }
      return send(response, {
        id: 17,
        state: state.bitbucketPullRequestState,
        title: 'Fix icon registry',
        updatedDate: Date.parse('2026-07-28T15:00:00.000Z'),
        fromRef: {
          id: 'refs/heads/agentic/run-icons',
          latestCommit: 'bitbucket-head',
        },
        toRef: { id: 'refs/heads/main', latestCommit: 'main-head' },
        links: {
          self: [
            {
              href: 'https://bitbucket.example.com/projects/OB/repos/project-a/pull-requests/17',
            },
          ],
        },
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname ===
        '/bitbucket/rest/api/latest/projects/OB/repos/project-a/pull-requests/17/merge'
    ) {
      return send(response, { canMerge: true, conflicted: false, vetoes: [] });
    }

    if (
      request.method === 'GET' &&
      url.pathname ===
        '/bitbucket/rest/build-status/latest/commits/bitbucket-head'
    ) {
      assert.equal(url.searchParams.get('limit'), '100');
      return send(response, { values: [] });
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
        title: 'Fix icon registry',
        source_branch: 'agentic/run-icons',
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
      assert.equal(url.searchParams.get('source_branch'), 'agentic/run-icons');
      assert.equal(url.searchParams.get('target_branch'), 'main');
      return send(response, [
        {
          id: 9,
          iid: 3,
          web_url:
            'https://gitlab.example.com/group/project/-/merge_requests/3',
          state: 'opened',
          title: 'Fix icon registry',
        },
      ]);
    }

    if (
      request.method === 'GET' &&
      /\/gitlab\/api\/v4\/projects\/.+$/.test(url.pathname)
    ) {
      return send(response, {
        archived: state.projectArchived,
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
    process.env.OMNIBOARD_API_KEY_MCP_CLI = 'test-mcp-key';
    process.env.OMNIBOARD_API_KEY = 'test-analyzer-key';
    process.env.OMNIBOARD_API_URL = `http://127.0.0.1:${getServerPort(server)}`;
    process.env.UNRELATED_RUNNER_SECRET = 'ambient-secret';
    delete process.env.OMNIBOARD_MCP_CLI_ALLOW_LOCAL_TRANSPORTS;
    const {
      prepareRunnerWorkspace,
      finalizeRunnerWorkspace,
      resolveRunnerGitValues,
    } = await import('../../dist/services/runner-workspace.service.js');
    const { writeRunnerState } = await import(
      '../../dist/services/runner-execution.service.js'
    );
    const { withGitCredentials } = await import(
      '../../dist/services/runner-workspace-repository.service.js'
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
      withGitCredentials,
    };

    await runAgenticRunIntegration(context);
    Object.assign(context, await runWorkspacePreparationIntegration(context));
    await runWorkspaceCredentialsIntegration(context);
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

function createRunnerExecution(input: any) {
  const now = new Date().toISOString();
  return {
    executionKey: '11111111-2222-4333-8444-555555555555',
    runKey: input.runKey,
    checkName: 'icon-registry',
    projectName: input.projectName,
    repositoryUrl: input.repositoryUrl,
    sourceControlProvider: input.sourceControlProvider,
    sourceControlRepositoryId: input.sourceControlRepositoryId,
    branch: input.branch,
    targetBranch: null,
    commitMessage: input.commitMessage ?? null,
    preparedHeadSha: null,
    commitSha: null,
    phase: 'preparing',
    recovery: null,
    generation: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    completedAt: null,
    cleanupAfter: null,
    stateVersion: 1,
    creationDate: now,
    updateDate: now,
  };
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
