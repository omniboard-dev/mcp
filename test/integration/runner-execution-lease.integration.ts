import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const root = await fs.mkdtemp('/tmp/omniboard-runner-context-');
try {
  process.chdir(root);
  globalThis.fetch = async () => {
    throw new Error('Unexpected API execution call');
  };
  globalThis.setInterval = (() => {
    throw new Error('Unexpected execution timer');
  }) as typeof setInterval;
  const {
    acquireRunnerExecution,
    runnerExecutionLocalPath,
    heartbeatRunnerExecution,
    releaseAllRunnerExecutions,
  } = await import('../../dist/services/runner-execution.service.js');
  const input = {
    runKey: 'migration',
    projectName: 'test-project',
    repositoryUrl: 'https://gitlab.example.com/group/project.git',
    sourceControlProvider: 'gitlab' as const,
    sourceControlRepositoryId: 'group/project',
    branch: 'agentic/migration',
  };
  const first = await acquireRunnerExecution(input);
  const localPath = runnerExecutionLocalPath(first);
  assert(localPath);
  assert.equal(
    heartbeatRunnerExecution(input.runKey, input.projectName).required,
    false
  );
  await releaseAllRunnerExecutions();
  const restarted = await acquireRunnerExecution(input);
  assert.equal(runnerExecutionLocalPath(restarted), localPath);
  assert.equal(restarted.executionKey, first.executionKey);
  await releaseAllRunnerExecutions();
  const { mergeBitbucketPullRequest } = await import(
    '../../dist/services/bitbucket-data-center.service.js'
  );
  let providerAllowsMerge = false;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      'https://bitbucket.example.com/rest/api/latest/projects/OB/repos/project/pull-requests/7/merge'
    );
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { version: 3 });
    return new Response(
      JSON.stringify(
        providerAllowsMerge
          ? { state: 'MERGED' }
          : { message: 'Build must pass' }
      ),
      { status: providerAllowsMerge ? 200 : 409 }
    );
  };
  const access = {
    provider: 'bitbucket_data_center' as const,
    host: 'bitbucket.example.com',
    apiBaseUrl: 'https://bitbucket.example.com/rest/api/latest',
    username: 'test',
    token: 'test',
  };
  assert.equal(
    (await mergeBitbucketPullRequest(access, 'OB/project', 7, 3)).merged,
    false
  );
  providerAllowsMerge = true;
  assert.equal(
    (await mergeBitbucketPullRequest(access, 'OB/project', 7, 3)).merged,
    true
  );
  console.log(
    'Runner context uses no execution API, timer, heartbeat or release requirement.'
  );
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  process.chdir(originalCwd);
  await fs.rm(root, { recursive: true, force: true });
}
