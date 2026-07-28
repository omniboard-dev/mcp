import assert from 'node:assert/strict';
import http from 'node:http';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { createStructuredToolResult } = await import('../../dist/mcp/shared.js');
const { matchedProjectsOutputSchema } = await import(
  '../../dist/mcp/output-schemas.js'
);
const { createAgenticRunProjectList } = await import(
  '../../dist/services/agentic-runs.service.js'
);
const { prepareNextRunnerProjects } = await import(
  '../../dist/services/runner-batch-preparation.service.js'
);

const structuredResult = createStructuredToolResult({
  total: 1,
  projects: [{ name: 'project-a' }],
});
assert.deepEqual(structuredResult.structuredContent, {
  total: 1,
  projects: [{ name: 'project-a' }],
});
assert.equal(
  JSON.parse(structuredResult.content[0].text).projects[0].name,
  'project-a'
);

const run = {
  runKey: 'run-uxf',
  checkName: 'uxf-icon-registry',
  prompt: 'Large migration prompt',
  status: 'active',
  isActive: true,
};
const projects = [
  project('project-a', 'failed', { error: 'clone failed' }),
  project('project-b', 'blocked', {
    mergeRequestDetailedStatus: 'conflict',
  }),
  project('project-c', 'failed', { pipelineStatus: 'failed' }),
  project('project-d', 'done'),
];
const filteredList = createAgenticRunProjectList(
  {
    check: {
      name: 'uxf-icon-registry',
      type: 'regex',
      description: null,
      agentic: true,
      prompt: 'Large migration prompt',
      agenticRuns: [run],
    },
    run,
    runs: [run],
    projects,
    total: projects.length,
  },
  {
    statuses: ['failed', 'blocked', 'failed'],
    offset: 1,
    limit: 1,
    view: 'summary',
  }
);
assert.equal(filteredList.total, 3);
assert.equal(filteredList.unfilteredTotal, 4);
assert.equal(filteredList.returned, 1);
assert.equal(filteredList.hasMore, true);
assert.deepEqual(filteredList.statuses, ['failed', 'blocked']);
assert.equal(filteredList.projects[0].name, 'project-b');
assert(!('result' in filteredList.projects[0]));
assert(!('prompt' in filteredList.run));
assert(!('prompt' in filteredList.check));
assert(!('agenticRuns' in filteredList.check));

const batchCandidates = createAgenticRunProjectList(
  {
    check: {
      name: 'uxf-icon-registry',
      type: 'regex',
      description: null,
      agentic: true,
      prompt: null,
    },
    run,
    runs: [run],
    projects: projects.slice(0, 3),
    total: 3,
  },
  { statuses: ['failed', 'blocked'] }
);
const batch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed', 'blocked'], limit: 1 },
  {
    listProjects: async () => batchCandidates,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) => {
      if (projectName === 'project-a') {
        return preparation(projectName, 'wait');
      }
      if (projectName === 'project-b') {
        throw new Error('provider unavailable');
      }
      return preparation(projectName, 'continue', true);
    },
  }
);
assert.equal(batch.candidatesTotal, 3);
assert.equal(batch.examined, 3);
assert.equal(batch.hasMore, false);
assert.deepEqual(batch.summary, {
  prepared: 1,
  waiting: 1,
  stopped: 0,
  failed: 1,
});
assert.deepEqual(
  batch.results.map(({ projectName, outcome }) => [projectName, outcome]),
  [
    ['project-a', 'waiting'],
    ['project-b', 'failed'],
    ['project-c', 'prepared'],
  ]
);

const preparationsInProgress = new Set<string>();
const activeExecutionLeases = new Set<string>();
let signalFirstPreparationStarted!: () => void;
let releaseFirstPreparation!: () => void;
const firstPreparationStarted = new Promise<void>((resolve) => {
  signalFirstPreparationStarted = resolve;
});
const firstPreparationRelease = new Promise<void>((resolve) => {
  releaseFirstPreparation = resolve;
});
const concurrentDependencies = {
  listProjects: async () => batchCandidates,
  isWorkspacePreparationInProgress: (_runKey: string, projectName: string) =>
    preparationsInProgress.has(projectName),
  hasActiveExecutionLease: (_runKey: string, projectName: string) =>
    activeExecutionLeases.has(projectName),
  prepareWorkspace: async ({ projectName }) => {
    preparationsInProgress.add(projectName);
    try {
      if (projectName === 'project-a') {
        signalFirstPreparationStarted();
        await firstPreparationRelease;
      }
      activeExecutionLeases.add(projectName);
      return preparation(projectName, 'continue', true);
    } finally {
      preparationsInProgress.delete(projectName);
    }
  },
};
const firstConcurrentBatch = prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed', 'blocked'], limit: 1 },
  concurrentDependencies
);
await firstPreparationStarted;
const secondConcurrentBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed', 'blocked'], limit: 1 },
  concurrentDependencies
);
releaseFirstPreparation();
const completedFirstConcurrentBatch = await firstConcurrentBatch;
assert.deepEqual(
  completedFirstConcurrentBatch.results.map(({ projectName, outcome }) => [
    projectName,
    outcome,
  ]),
  [['project-a', 'prepared']]
);
assert.deepEqual(
  secondConcurrentBatch.results.map(({ projectName, outcome, reason }) => [
    projectName,
    outcome,
    reason ?? null,
  ]),
  [
    ['project-a', 'waiting', 'preparation_in_progress'],
    ['project-b', 'prepared', null],
  ]
);
assert.deepEqual(secondConcurrentBatch.summary, {
  prepared: 1,
  waiting: 1,
  stopped: 0,
  failed: 0,
});
const staleOverlappingBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed', 'blocked'], limit: 1 },
  concurrentDependencies
);
assert.deepEqual(
  staleOverlappingBatch.results.map(({ projectName, outcome, reason }) => [
    projectName,
    outcome,
    reason ?? null,
  ]),
  [
    ['project-a', 'waiting', 'execution_lease_active'],
    ['project-b', 'waiting', 'execution_lease_active'],
    ['project-c', 'prepared', null],
  ]
);

const apiResponse = {
  check: {
    name: 'uxf-icon-registry',
    type: 'regex',
    description: null,
    agentic: true,
    prompt: 'Large migration prompt',
  },
  run,
  runs: [run],
  projects,
  total: projects.length,
};
const apiServer = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && url.pathname === '/mcp/matched-projects') {
    response.end(JSON.stringify(apiResponse));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'Not found' }));
});
await new Promise<void>((resolve) =>
  apiServer.listen(0, '127.0.0.1', () => resolve())
);
const apiAddress = apiServer.address();
assert(apiAddress && typeof apiAddress !== 'string');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    OMNIBOARD_API_KEY_MCP: 'registration-test-key',
    OMNIBOARD_API_URL: `http://127.0.0.1:${apiAddress.port}`,
  },
});
const client = new Client({ name: 'runner-tools-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert(names.includes('omniboard_runner_list_agentic_runs'));
  assert(names.includes('omniboard_runner_list_agentic_run_projects'));
  assert(names.includes('omniboard_runner_prepare_next_agentic_run_projects'));
  assert(names.includes('omniboard_runner_prepare_agentic_run_workspace'));
  assert(names.includes('omniboard_runner_finalize_agentic_run_workspace'));
  assert(names.includes('omniboard_runner_report_agentic_run_progress'));
  assert(tools.every((tool) => tool.outputSchema));

  const projectListTool = tools.find(
    (tool) => tool.name === 'omniboard_runner_list_agentic_run_projects'
  );
  for (const property of ['statuses', 'offset', 'limit', 'view']) {
    assert(property in projectListTool.inputSchema.properties);
  }

  const batchPrepareTool = tools.find(
    (tool) => tool.name === 'omniboard_runner_prepare_next_agentic_run_projects'
  );
  assert('statuses' in batchPrepareTool.inputSchema.properties);
  assert('limit' in batchPrepareTool.inputSchema.properties);

  const listedProjects = await client.callTool({
    name: 'omniboard_runner_list_agentic_run_projects',
    arguments: {
      runKey: run.runKey,
      statuses: ['failed'],
      limit: 1,
      view: 'summary',
    },
  });
  assert(!listedProjects.isError);
  const listedContent = matchedProjectsOutputSchema.parse(
    listedProjects.structuredContent
  );
  assert.equal(listedContent.total, 2);
  assert.equal(listedContent.unfilteredTotal, 4);
  assert.equal(listedContent.returned, 1);
  assert.equal(listedContent.hasMore, true);
  assert.deepEqual(listedContent.statuses, ['failed']);
  assert.equal(listedContent.projects[0].name, 'project-a');
  assert(!('result' in listedContent.projects[0]));
  assert(!('prompt' in listedContent.run));
  assert(!('prompt' in listedContent.check));
  assert.deepEqual(JSON.parse(listedProjects.content[0].text), listedContent);

  const finalizeTool = tools.find(
    (tool) => tool.name === 'omniboard_runner_finalize_agentic_run_workspace'
  );
  assert(!finalizeTool.inputSchema.required.includes('commitMessage'));

  const runnerProgressTool = tools.find(
    (tool) => tool.name === 'omniboard_runner_report_agentic_run_progress'
  );
  const progressProperties = runnerProgressTool.inputSchema.properties;
  for (const property of [
    'resolution',
    'resolutionReason',
    'mergeRequestState',
    'mergeRequestDetailedStatus',
    'pipelineStatus',
    'pipelineUrl',
    'pipelineFailureSummary',
  ]) {
    assert(property in progressProperties);
  }

  console.log('Dedicated runner MCP tool registration test passed.');
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) =>
    apiServer.close((error) => (error ? reject(error) : resolve()))
  );
}

function project(name, status, progress = {}) {
  return {
    id: name.charCodeAt(name.length - 1),
    name,
    value: true,
    result: { large: 'payload' },
    repositoryUrl: `https://gitlab.example.com/group/${name}.git`,
    progress: {
      status,
      ...progress,
    },
  };
}

function preparation(projectName, action, withWorkspace = false) {
  return {
    run,
    project: projects.find((item) => item.name === projectName),
    projectState: {
      run,
      project: {
        id: 1,
        name: projectName,
        currentlyMatchesCheck: true,
      },
      progress: { status: 'failed' },
      providerSync: {
        attempted: true,
        success: true,
        diagnostics: [],
      },
    },
    continuation: {
      action,
      reason: action === 'wait' ? 'provider_sync_failed' : 'retry_failed_work',
      instructions: [],
      diagnostics: [],
    },
    ...(withWorkspace
      ? {
          workspace: {
            localPath: `/tmp/${projectName}`,
          },
        }
      : {}),
    prompt: 'Update the icon registry.',
    instructions: [],
  };
}
