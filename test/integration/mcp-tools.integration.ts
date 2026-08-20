import assert from 'node:assert/strict';
import http from 'node:http';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { createStructuredToolResult } = await import('../../dist/mcp/shared.js');
const { matchedProjectsOutputSchema, runnerWorkspaceReleaseOutputSchema } =
  await import('../../dist/mcp/output-schemas.js');
const { createAgenticRunProjectList } = await import(
  '../../dist/services/agentic-runs.service.js'
);
const { prepareNextRunnerProjects } = await import(
  '../../dist/services/runner-batch-preparation.service.js'
);
const { RunnerExecutionLeaseConflictError } = await import(
  '../../dist/services/runner-execution.service.js'
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
  runKey: 'run-icons',
  checkName: 'icon-registry',
  prompt: 'Large migration prompt',
  status: 'active',
  isActive: true,
};
const projects = [
  {
    ...project('project-a', 'failed', { error: 'clone failed' }),
    projectSize: {
      totalFiles: 3,
      totalLines: 20,
      byExtension: { ts: 2, json: 1 },
      linesByExtension: { ts: 15, json: 5 },
      breakdownVersion: 1,
      source: {
        totalFiles: 2,
        totalLines: 15,
        byExtension: { ts: 2 },
        linesByExtension: { ts: 15 },
      },
      others: {
        totalFiles: 1,
        totalLines: 5,
        byExtension: { json: 1 },
        linesByExtension: { json: 5 },
      },
    },
  },
  project('project-b', 'blocked', {
    mergeRequestDetailedStatus: 'conflict',
  }),
  project('project-c', 'failed', { pipelineStatus: 'failed' }),
  project('project-d', 'done'),
];
const filteredList = createAgenticRunProjectList(
  {
    check: {
      name: 'icon-registry',
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
      name: 'icon-registry',
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

const sizedProjects = [
  sizedProject('project-small-total', 100, 80),
  sizedProject('project-small-json', 1_000, 10),
  sizedProject('project-large-json', 5_000, 40),
  project('project-size-unknown', 'failed'),
];
const sizedCandidates = createAgenticRunProjectList(
  {
    check: {
      name: 'json-registry',
      type: 'regex',
      description: 'Update the generated JSON registry.',
      agentic: true,
      prompt: 'Update registry.json across matching projects.',
    },
    run: {
      ...run,
      checkName: 'json-registry',
      prompt: 'Update registry.json across matching projects.',
    },
    runs: [run],
    projects: sizedProjects,
    total: sizedProjects.length,
  },
  { statuses: ['failed'] }
);
const rankedBatch = await prepareNextRunnerProjects(
  {
    runKey: run.runKey,
    statuses: ['failed'],
    limit: 4,
    relevantSourceExtensions: ['.JSON'],
  },
  {
    listProjects: async () => sizedCandidates,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) =>
      preparation(projectName, 'continue', true),
  }
);
assert.deepEqual(rankedBatch.sourceSelection, {
  extensions: ['json'],
  origin: 'explicit',
  projectsWithSize: 3,
  projectsWithoutSize: 1,
});
assert.deepEqual(
  rankedBatch.results.map(({ projectName }) => projectName),
  [
    'project-small-json',
    'project-large-json',
    'project-small-total',
    'project-size-unknown',
  ]
);
assert.deepEqual(rankedBatch.results[0].sizeRanking, {
  metadataAvailable: true,
  relevantExtensions: ['json'],
  relevantLines: 10,
  relevantFiles: 1,
  totalLines: 1_000,
  totalFiles: 100,
});

const inferredRankedBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  {
    listProjects: async () => sizedCandidates,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) =>
      preparation(projectName, 'continue', true),
  }
);
assert.deepEqual(inferredRankedBatch.sourceSelection.extensions, ['json']);
assert.equal(inferredRankedBatch.sourceSelection.origin, 'prompt_and_results');
assert.equal(inferredRankedBatch.results[0].projectName, 'project-small-json');

const multiDotProjects = [
  sizedProject('project-few-typescript-lines', 1_000, 990),
  sizedProject('project-small-overall', 100, 10),
];
const multiDotCandidates = createAgenticRunProjectList(
  {
    check: {
      name: 'component-migration',
      type: 'regex',
      description: 'Update the selected component source file.',
      agentic: true,
      prompt: 'Update src/app.component.ts across matching projects.',
    },
    run: {
      ...run,
      checkName: 'component-migration',
      prompt: 'Update src/app.component.ts across matching projects.',
    },
    runs: [run],
    projects: multiDotProjects,
    total: multiDotProjects.length,
  },
  { statuses: ['failed'] }
);
const multiDotRankedBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  {
    listProjects: async () => multiDotCandidates,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) =>
      preparation(projectName, 'continue', true),
  }
);
assert.deepEqual(multiDotRankedBatch.sourceSelection.extensions, ['ts']);
assert.equal(
  multiDotRankedBatch.results[0].projectName,
  'project-few-typescript-lines'
);

const projectLocalResultProjects = [
  {
    ...projectWithSize('project-json-result', 1_010, {
      json: 10,
      ts: 1_000,
    }),
    result: { files: ['config.json'] },
  },
  {
    ...projectWithSize('project-typescript-result', 20, { ts: 20 }),
    result: { files: ['src/main.ts'] },
  },
];
const projectLocalResultBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 2 },
  batchDependencies(
    candidatesWithPrompt(
      'Apply the matched change.',
      projectLocalResultProjects
    )
  )
);
assert.deepEqual(projectLocalResultBatch.sourceSelection.extensions, [
  'json',
  'ts',
]);
assert.deepEqual(
  projectLocalResultBatch.results.map(({ projectName, sizeRanking }) => [
    projectName,
    sizeRanking.relevantExtensions,
    sizeRanking.relevantLines,
  ]),
  [
    ['project-json-result', ['json'], 10],
    ['project-typescript-result', ['ts'], 20],
  ]
);

const uppercaseResultProjects = [
  {
    ...projectWithSize('project-uppercase-typescript', 1_000, {
      ts: 10,
      json: 990,
    }),
    result: { files: ['src/App.TS'] },
  },
  {
    ...projectWithSize('project-small-uppercase-fallback', 100, { json: 100 }),
    result: {},
  },
];
const uppercaseResultBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt('Apply the matched change.', uppercaseResultProjects)
  )
);
assert.deepEqual(uppercaseResultBatch.sourceSelection.extensions, ['ts']);
assert.equal(
  uppercaseResultBatch.results[0].projectName,
  'project-uppercase-typescript'
);
assert.deepEqual(
  uppercaseResultBatch.results[0].sizeRanking.relevantExtensions,
  ['ts']
);
assert.equal(uppercaseResultBatch.results[0].sizeRanking.relevantLines, 10);

const profileOnlyProjects = [
  {
    ...projectWithSize('project-large-profile', 1_000, { ts: 1_000 }),
    result: { profile: 'docs/config.json' },
  },
  {
    ...projectWithSize('project-small-fallback', 100, { json: 100 }),
    result: {},
  },
];
const profileOnlyBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt('Apply the matched change.', profileOnlyProjects)
  )
);
assert.deepEqual(profileOnlyBatch.sourceSelection.extensions, []);
assert.equal(profileOnlyBatch.sourceSelection.origin, 'total_project_fallback');
assert.equal(profileOnlyBatch.results[0].projectName, 'project-small-fallback');

const nestedFileProjects = [
  {
    ...projectWithSize('project-nested-typescript', 1_000, {
      ts: 10,
      json: 990,
    }),
    result: { files: { matched: ['src/main.ts'] } },
  },
  {
    ...projectWithSize('project-small-nested-fallback', 100, { json: 100 }),
    result: {},
  },
];
const nestedFileBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt('Apply the matched change.', nestedFileProjects)
  )
);
assert.deepEqual(nestedFileBatch.sourceSelection.extensions, ['ts']);
assert.equal(
  nestedFileBatch.results[0].projectName,
  'project-nested-typescript'
);

const inferenceEdgeProjects = [
  projectWithSize('project-few-json-lines', 1_000, {
    json: 10,
    go: 990,
  }),
  projectWithSize('project-more-json-lines', 100, {
    json: 20,
    com: 80,
  }),
];
const imperativeGoBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt(
      'Go update registry.json in every project.',
      inferenceEdgeProjects
    )
  )
);
assert.deepEqual(imperativeGoBatch.sourceSelection.extensions, ['json']);
assert.equal(
  imperativeGoBatch.results[0].projectName,
  'project-few-json-lines'
);

const urlOnlyBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt(
      'Follow https://example.com/migration before updating the projects.',
      inferenceEdgeProjects
    )
  )
);
assert.deepEqual(urlOnlyBatch.sourceSelection.extensions, []);
assert.equal(urlOnlyBatch.sourceSelection.origin, 'total_project_fallback');
assert.equal(urlOnlyBatch.results[0].projectName, 'project-more-json-lines');

const urlPathBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed'], limit: 1 },
  batchDependencies(
    candidatesWithPrompt(
      'Update https://example.com/src/app.component.ts in every project.',
      multiDotProjects
    )
  )
);
assert.deepEqual(urlPathBatch.sourceSelection.extensions, ['ts']);
assert.equal(
  urlPathBatch.results[0].projectName,
  'project-few-typescript-lines'
);

let invalidExplicitPreparationStarted = false;
await assert.rejects(
  prepareNextRunnerProjects(
    {
      runKey: run.runKey,
      statuses: ['failed'],
      limit: 1,
      relevantSourceExtensions: ['.'],
    },
    {
      ...batchDependencies(sizedCandidates),
      prepareWorkspace: async ({ projectName }) => {
        invalidExplicitPreparationStarted = true;
        return preparation(projectName, 'continue', true);
      },
    }
  ),
  /Relevant source extensions must contain only valid file extensions/
);
assert.equal(invalidExplicitPreparationStarted, false);

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

const crossProcessLeaseBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['failed', 'blocked'], limit: 1 },
  {
    ...batchDependencies(batchCandidates),
    prepareWorkspace: async ({ projectName }) => {
      if (projectName === 'project-a') {
        throw new RunnerExecutionLeaseConflictError(
          'Runner execution is leased by another MCP CLI process'
        );
      }
      return preparation(projectName, 'continue', true);
    },
  }
);
assert.deepEqual(
  crossProcessLeaseBatch.results.map(({ projectName, outcome, reason }) => [
    projectName,
    outcome,
    reason ?? null,
  ]),
  [
    ['project-a', 'waiting', 'execution_lease_active'],
    ['project-b', 'prepared', null],
  ]
);
assert.deepEqual(crossProcessLeaseBatch.summary, {
  prepared: 1,
  waiting: 1,
  stopped: 0,
  failed: 0,
});

const apiResponse = {
  check: {
    name: 'icon-registry',
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
  if (
    request.method === 'GET' &&
    url.pathname === '/mcp-cli/matched-projects'
  ) {
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
    OMNIBOARD_API_KEY_MCP_CLI: 'registration-test-key',
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
  assert(names.includes('omniboard_runner_release_agentic_run_workspace'));
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
  assert('relevantSourceExtensions' in batchPrepareTool.inputSchema.properties);

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
  const listedProjectSizeFixture = projects[0];
  assert('projectSize' in listedProjectSizeFixture);
  assert.deepEqual(
    listedContent.projects[0].projectSize,
    listedProjectSizeFixture.projectSize
  );
  assert(!('result' in listedContent.projects[0]));
  assert(!('prompt' in listedContent.run));
  assert(!('prompt' in listedContent.check));
  assert.deepEqual(JSON.parse(listedProjects.content[0].text), listedContent);

  const releasedWorkspace = await client.callTool({
    name: 'omniboard_runner_release_agentic_run_workspace',
    arguments: {
      runKey: run.runKey,
      projectName: 'project-a',
    },
  });
  assert(!releasedWorkspace.isError);
  assert.deepEqual(
    runnerWorkspaceReleaseOutputSchema.parse(
      releasedWorkspace.structuredContent
    ),
    {
      runKey: run.runKey,
      projectName: 'project-a',
      executionKey: null,
      released: false,
    }
  );

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

  console.log('Dedicated runner MCP CLI tool registration test passed.');
} finally {
  const closeStartedAt = Date.now();
  await client.close();
  const closeDurationMs = Date.now() - closeStartedAt;
  await new Promise<void>((resolve, reject) =>
    apiServer.close((error) => (error ? reject(error) : resolve()))
  );
  assert.equal(transport.pid, null);
  assert(
    closeDurationMs < 1_900,
    `MCP stdio server took ${closeDurationMs}ms to close; expected graceful EOF shutdown before the client termination timeout.`
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

function sizedProject(name, totalLines, jsonLines) {
  return {
    ...project(name, 'failed'),
    projectSize: {
      totalFiles: 100,
      totalLines,
      byExtension: {
        json: 1,
        ts: 99,
      },
      linesByExtension: {
        json: jsonLines,
        ts: totalLines - jsonLines,
      },
    },
  };
}

function projectWithSize(name, totalLines, linesByExtension) {
  return {
    ...project(name, 'failed'),
    projectSize: {
      totalFiles: Object.keys(linesByExtension).length,
      totalLines,
      byExtension: Object.fromEntries(
        Object.keys(linesByExtension).map((extension) => [extension, 1])
      ),
      linesByExtension,
    },
  };
}

function candidatesWithPrompt(prompt, candidateProjects) {
  return createAgenticRunProjectList(
    {
      check: {
        name: 'source-inference',
        type: 'regex',
        description: null,
        agentic: true,
        prompt,
      },
      run: {
        ...run,
        checkName: 'source-inference',
        prompt,
      },
      runs: [run],
      projects: candidateProjects,
      total: candidateProjects.length,
    },
    { statuses: ['failed'] }
  );
}

function batchDependencies(candidates) {
  return {
    listProjects: async () => candidates,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) =>
      preparation(projectName, 'continue', true),
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
