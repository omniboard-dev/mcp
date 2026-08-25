import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
let requestCount = 0;

try {
  process.env.OMNIBOARD_API_KEY_MCP_CLI = 'http-timeout-test-key';
  process.env.OMNIBOARD_API_URL = 'http://api-timeout.test';
  process.env.OMNIBOARD_API_REQUEST_TIMEOUT_MS = '10';
  process.env.OMNIBOARD_API_IDEMPOTENT_RETRIES = '0';
  process.env.OMNIBOARD_PROVIDER_REQUEST_TIMEOUT_MS = '10';
  process.env.OMNIBOARD_PROVIDER_IDEMPOTENT_RETRIES = '0';

  globalThis.fetch = ((_input, init) => {
    requestCount += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true }
      );
    });
  }) as typeof fetch;

  const api = await import('../../dist/services/api.service.js');
  const { fetchWithTimeout } = await import(
    '../../dist/services/http.service.js'
  );
  api.createApiService();

  await assert.rejects(
    api.getRunnerAgenticRuns(),
    /Omniboard API GET http:\/\/api-timeout\.test\/mcp-cli\/runs transport failed: timed out after 10ms/
  );
  await assert.rejects(
    fetchWithTimeout(
      'https://gitlab.example.com/api/v4/projects/group%2Fproject'
    ),
    /Provider GET https:\/\/gitlab\.example\.com\/api\/v4\/projects\/group%2Fproject transport failed: timed out after 10ms/
  );
  assert.equal(requestCount, 2);

  requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    throw new TypeError('fetch failed', {
      cause: { code: 'ECONNRESET' },
    });
  }) as typeof fetch;

  await assert.rejects(
    api.acquireRunnerExecution({
      runKey: 'run-a',
      projectName: 'project-a',
      repositoryUrl: 'https://gitlab.example.com/group/project.git',
      sourceControlProvider: 'gitlab',
      sourceControlRepositoryId: 'group/project',
      branch: 'agentic/run-a',
      leaseOwner: 'runner-a',
    }),
    /POST http:\/\/api-timeout\.test\/mcp-cli\/run-executions\/acquire transport failed: fetch failed \(ECONNRESET\)/
  );
  assert.equal(
    requestCount,
    1,
    'Non-idempotent acquire requests must not be retried blindly.'
  );

  console.log('HTTP timeout and retry policy test passed.');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.OMNIBOARD_API_REQUEST_TIMEOUT_MS;
  delete process.env.OMNIBOARD_API_IDEMPOTENT_RETRIES;
  delete process.env.OMNIBOARD_PROVIDER_REQUEST_TIMEOUT_MS;
  delete process.env.OMNIBOARD_PROVIDER_IDEMPOTENT_RETRIES;
}
