import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalDateNow = Date.now;
let now = Date.parse('2026-07-27T10:00:00.000Z');
let sequence = 0;
let renewResult: 'success' | 'network' | 'server' | 'conflict' = 'success';
const timers: FakeTimer[] = [];
const executions = new Map<string, any>();
const leaseTokens = new Map<string, string>();
const acquireBodies: any[] = [];
const releaseRequests: string[] = [];

interface FakeTimer {
  callback: () => void;
  cleared: boolean;
  unref: () => FakeTimer;
}

try {
  Date.now = () => now;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert.equal(delay, 30_000);
    const timer: FakeTimer = {
      callback,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: FakeTimer) => {
    timer.cleared = true;
  }) as unknown as typeof clearInterval;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.pathname.endsWith('/acquire')) {
      acquireBodies.push(body);
      sequence += 1;
      const execution = createExecution(`execution-${sequence}`, body);
      const leaseToken = `token-${sequence}`;
      executions.set(execution.executionKey, execution);
      leaseTokens.set(execution.executionKey, leaseToken);
      return jsonResponse({ execution, leaseToken });
    }

    const match = /\/run-executions\/([^/]+)\/(renew|checkpoint|release)$/.exec(
      url.pathname
    );
    assert(match, `Unexpected request: ${url.pathname}`);
    const execution = executions.get(match[1]);
    assert(execution);

    if (match[2] === 'renew') {
      assert.equal(body.leaseToken, leaseTokens.get(execution.executionKey));
      if (renewResult === 'network') throw new TypeError('network unavailable');
      if (renewResult === 'server') {
        return jsonResponse({ message: 'temporarily unavailable' }, 503);
      }
      if (renewResult === 'conflict') {
        return jsonResponse({ message: 'lease is invalid' }, 409);
      }
      execution.leaseExpiresAt = new Date(now + 120_000).toISOString();
      const leaseToken = `${body.leaseToken}-renewed`;
      leaseTokens.set(execution.executionKey, leaseToken);
      return jsonResponse({ execution, leaseToken });
    }

    assert.equal(body.leaseToken, leaseTokens.get(execution.executionKey));
    if (match[2] === 'release') {
      releaseRequests.push(execution.executionKey);
      return jsonResponse(execution);
    }

    return jsonResponse(execution);
  }) as typeof fetch;

  process.env.OMNIBOARD_API_KEY_MCP_CLI = 'lease-test-key';
  process.env.OMNIBOARD_API_URL = 'http://runner.test';

  const {
    acquireRunnerExecution,
    checkpointRunnerExecution,
    releaseAllRunnerExecutions,
    releaseRunnerExecution,
    releaseRunnerExecutionByIdentity,
  } = await import('../../dist/services/runner-execution.service.js');

  const first = await acquireRunnerExecution(acquireInput('run-transient'));
  const firstTimer = timers.at(-1)!;

  renewResult = 'server';
  await trigger(firstTimer);
  await checkpointRunnerExecution(first, { phase: 'preparing' });

  renewResult = 'network';
  await trigger(firstTimer);
  await checkpointRunnerExecution(first, { phase: 'preparing' });

  now += 60_000;
  renewResult = 'success';
  await trigger(firstTimer);
  now += 60_001;
  await checkpointRunnerExecution(first, { phase: 'preparing' });
  await releaseRunnerExecution(first.executionKey);
  assert.equal(firstTimer.cleared, true);

  const releasable = await acquireRunnerExecution(
    acquireInput('run-release-by-identity')
  );
  const releasableTimer = timers.at(-1)!;
  assert.deepEqual(
    await releaseRunnerExecutionByIdentity(
      'run-release-by-identity',
      'project-a'
    ),
    {
      runKey: 'run-release-by-identity',
      projectName: 'project-a',
      executionKey: releasable.executionKey,
      released: true,
    }
  );
  assert.equal(releasableTimer.cleared, true);
  assert.deepEqual(
    await releaseRunnerExecutionByIdentity(
      'run-release-by-identity',
      'project-a'
    ),
    {
      runKey: 'run-release-by-identity',
      projectName: 'project-a',
      executionKey: null,
      released: false,
    }
  );

  const rejected = await acquireRunnerExecution(acquireInput('run-rejected'));
  const rejectedTimer = timers.at(-1)!;
  renewResult = 'conflict';
  await trigger(rejectedTimer);
  await assert.rejects(
    checkpointRunnerExecution(rejected, { phase: 'preparing' }),
    /is not leased by this MCP CLI process/
  );
  assert.equal(rejectedTimer.cleared, true);

  const expired = await acquireRunnerExecution(acquireInput('run-expired'));
  const expiredTimer = timers.at(-1)!;
  const confirmedExpiry = Date.parse(expired.leaseExpiresAt!);
  renewResult = 'network';
  await trigger(expiredTimer);
  now = confirmedExpiry;
  await assert.rejects(
    checkpointRunnerExecution(expired, { phase: 'preparing' }),
    /is not leased by this MCP CLI process/
  );
  assert.equal(expiredTimer.cleared, true);

  const reacquiredExpired = await acquireRunnerExecution(
    acquireInput('run-expired')
  );
  assert.equal('leaseToken' in acquireBodies.at(-1), false);
  await releaseRunnerExecution(reacquiredExpired.executionKey);

  const shutdownA = await acquireRunnerExecution(
    acquireInput('run-shutdown-a')
  );
  const shutdownB = await acquireRunnerExecution(
    acquireInput('run-shutdown-b')
  );
  await releaseAllRunnerExecutions();
  assert.deepEqual(
    releaseRequests.slice(-2).sort(),
    [shutdownA.executionKey, shutdownB.executionKey].sort()
  );
  assert.equal(timers.at(-2)?.cleared, true);
  assert.equal(timers.at(-1)?.cleared, true);

  console.log('Runner execution lease renewal test passed.');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  Date.now = originalDateNow;
}

function acquireInput(runKey: string) {
  return {
    runKey,
    projectName: 'project-a',
    repositoryUrl: 'https://gitlab.example.com/group/project.git',
    sourceControlProvider: 'gitlab' as const,
    sourceControlRepositoryId: 'group/project',
    branch: `agentic/${runKey}`,
  };
}

function createExecution(executionKey: string, input: any) {
  const timestamp = new Date(now).toISOString();
  return {
    executionKey,
    runKey: input.runKey,
    checkName: 'test-check',
    projectName: input.projectName,
    repositoryUrl: input.repositoryUrl,
    sourceControlProvider: input.sourceControlProvider,
    sourceControlRepositoryId: input.sourceControlRepositoryId,
    branch: input.branch,
    targetBranch: null,
    commitMessage: null,
    preparedHeadSha: null,
    commitSha: null,
    phase: 'preparing',
    recovery: null,
    generation: 1,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: new Date(now + 120_000).toISOString(),
    heartbeatAt: timestamp,
    completedAt: null,
    cleanupAfter: null,
    stateVersion: 1,
    creationDate: timestamp,
    updateDate: timestamp,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function trigger(timer: FakeTimer) {
  assert.equal(timer.cleared, false);
  timer.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
