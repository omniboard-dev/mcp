import assert from 'node:assert/strict';
import http from 'node:http';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { createStructuredToolResult } = await import('../../dist/mcp/shared.js');
const {
  matchedProjectsOutputSchema,
  progressBulkReportOutputSchema,
  runnerWorkspaceReleaseOutputSchema,
} = await import('../../dist/mcp/output-schemas.js');
const { createAgenticRunProjectList } = await import(
  '../../dist/services/agentic-runs.service.js'
);
const { prepareNextRunnerProjects } = await import(
  '../../dist/services/runner-batch-preparation.service.js'
);
const { isAgenticRunResultTargeted } = await import(
  '../../dist/services/analyzer-validation.service.js'
);
const { getAgenticRunContinuationDecision } = await import(
  '../../dist/services/agentic-run-continuation.service.js'
);
const { RunnerExecutionLeaseConflictError } = await import(
  '../../dist/services/runner-execution.service.js'
);

assert.equal(isAgenticRunResultTargeted(true, 'fulfilled'), true);
assert.equal(isAgenticRunResultTargeted(false, 'fulfilled'), false);
assert.equal(isAgenticRunResultTargeted(false, 'unfulfilled'), true);
assert.equal(isAgenticRunResultTargeted(true, 'unfulfilled'), false);
assert.equal(isAgenticRunResultTargeted(undefined, 'unchecked'), true);
assert.equal(isAgenticRunResultTargeted(false, 'unchecked'), false);

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

const pendingRetryContinuation = getAgenticRunContinuationDecision({
  project: { currentlyMatchesCheck: true },
  progress: {
    status: 'pending_retry',
    retryInstructions: [
      {
        id: 1,
        instruction: 'Reuse the existing parser.',
        requestedFromStatus: 'failed',
        requestedBy: { id: 7, firstname: 'Tomas', lastname: 'Trajan' },
        creationDate: '2026-08-20T08:00:00.000Z',
      },
    ],
  },
  providerSync: { success: true, diagnostics: [] },
} as any);
assert.equal(pendingRetryContinuation.action, 'continue');
assert.equal(pendingRetryContinuation.reason, 'operator_retry_requested');
assert(
  pendingRetryContinuation.instructions.some((instruction) =>
    instruction.includes('Reuse the existing parser.')
  )
);

const run = {
  runKey: 'run-icons',
  checkName: 'icon-registry',
  targetFulfillment: 'fulfilled',
  prompt: 'Large migration prompt',
  status: 'active',
  isActive: true,
};
const retryDiscoveryRequests: any[] = [];
const unfulfilledRetryProject = project(
  'project-unfulfilled-retry',
  'pending_retry',
  {},
  'unfulfilled'
);
const nonTargetedRetryProject = {
  ...project('a-project-non-targeted', 'pending_retry'),
  targetedByRun: false,
};
const unfulfilledRetryBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, limit: 1 },
  {
    listProjects: async (options) => {
      retryDiscoveryRequests.push(options);
      return createAgenticRunProjectList(
        {
          check: {
            name: 'icon-registry',
            type: 'regex',
            description: null,
            agentic: true,
            prompt: 'Large migration prompt',
          },
          run,
          runs: [run],
          projects: [nonTargetedRetryProject, unfulfilledRetryProject],
          total: 2,
          totalsByFulfillment: fulfillmentTotals({
            fulfilled: 1,
            unfulfilled: 1,
          }),
        },
        {
          statuses: options.statuses,
          view: options.view,
        }
      );
    },
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) => ({
      run,
      project: unfulfilledRetryProject,
      projectState: {
        run,
        project: {
          id: unfulfilledRetryProject.id,
          name: projectName,
          currentlyMatchesCheck: false,
          fulfillment: 'unfulfilled',
        },
        progress: unfulfilledRetryProject.progress,
        providerSync: {
          attempted: true,
          success: true,
          error: null,
          diagnostics: [],
        },
      },
      continuation: {
        action: 'stop' as const,
        reason: 'change_dismissed' as const,
        instructions: [],
        diagnostics: [],
      },
      prompt: run.prompt,
      instructions: [],
    }),
  }
);
assert.equal(retryDiscoveryRequests.length, 1);
assert.deepEqual(retryDiscoveryRequests[0].statuses, [
  'pending',
  'pending_retry',
  'blocked',
  'failed',
]);
assert.equal(unfulfilledRetryBatch.candidatesTotal, 1);
assert.equal(
  unfulfilledRetryBatch.results[0].projectName,
  unfulfilledRetryProject.name
);
assert.equal(unfulfilledRetryBatch.results[0].outcome, 'stopped');

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
    totalsByFulfillment: fulfillmentTotals({ fulfilled: projects.length }),
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

const pendingWithoutStoredProgress = {
  ...project('project-pending', 'failed'),
  progress: null,
};
const pendingWithoutStoredProgressList = createAgenticRunProjectList(
  {
    check: {
      name: 'icon-registry',
      type: 'regex',
      description: null,
      agentic: true,
      prompt: 'Large migration prompt',
    },
    run,
    runs: [run],
    projects: [pendingWithoutStoredProgress],
    total: 1,
    totalsByFulfillment: fulfillmentTotals({ fulfilled: 1 }),
  },
  { statuses: ['pending'] }
);
assert.equal(pendingWithoutStoredProgressList.total, 1);
assert.equal(
  pendingWithoutStoredProgressList.projects[0].name,
  pendingWithoutStoredProgress.name
);

const pendingWithoutStoredProgressBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, statuses: ['pending'], limit: 1 },
  {
    listProjects: async () => pendingWithoutStoredProgressList,
    isWorkspacePreparationInProgress: () => false,
    hasActiveExecutionLease: () => false,
    prepareWorkspace: async ({ projectName }) =>
      preparation(projectName, 'continue', true),
  }
);
assert.equal(
  pendingWithoutStoredProgressBatch.results[0].projectName,
  pendingWithoutStoredProgress.name
);
assert.equal(
  pendingWithoutStoredProgressBatch.results[0].initialStatus,
  'pending'
);

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
    totalsByFulfillment: fulfillmentTotals({ fulfilled: 3 }),
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
    totalsByFulfillment: fulfillmentTotals({
      fulfilled: sizedProjects.length,
    }),
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
    'project-small-total',
    'project-small-json',
    'project-large-json',
    'project-size-unknown',
  ]
);
assert.deepEqual(rankedBatch.results[0].sizeRanking, {
  metadataAvailable: true,
  relevantExtensions: ['json'],
  relevantLines: 80,
  relevantFiles: 1,
  totalLines: 100,
  totalFiles: 100,
});

const sourceSizedProjects = [
  projectWithSizeBreakdown('project-small-source', 10, 10, 10_000),
  projectWithSizeBreakdown('project-large-source', 100, 1, 0),
];
const sourceSizedCandidates = createAgenticRunProjectList(
  {
    check: {
      name: 'typescript-migration',
      type: 'regex',
      description: 'Update TypeScript source.',
      agentic: true,
      prompt: 'Update TypeScript source.',
    },
    run: {
      ...run,
      checkName: 'typescript-migration',
      prompt: 'Update TypeScript source.',
    },
    runs: [run],
    projects: sourceSizedProjects,
    total: sourceSizedProjects.length,
    totalsByFulfillment: fulfillmentTotals({
      fulfilled: sourceSizedProjects.length,
    }),
  },
  { statuses: ['failed'] }
);
const sourceRankedBatch = await prepareNextRunnerProjects(
  {
    runKey: run.runKey,
    statuses: ['failed'],
    limit: 2,
    relevantSourceExtensions: ['ts'],
  },
  batchDependencies(sourceSizedCandidates)
);
assert.deepEqual(
  sourceRankedBatch.results.map(({ projectName }) => projectName),
  ['project-small-source', 'project-large-source']
);
assert.deepEqual(sourceRankedBatch.results[0].sizeRanking, {
  metadataAvailable: true,
  relevantExtensions: ['ts'],
  relevantLines: 10,
  relevantFiles: 1,
  totalLines: 10,
  totalFiles: 2,
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
assert.equal(inferredRankedBatch.results[0].projectName, 'project-small-total');

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
    totalsByFulfillment: fulfillmentTotals({
      fulfilled: multiDotProjects.length,
    }),
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
  'project-small-overall'
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
    ['project-typescript-result', ['ts'], 20],
    ['project-json-result', ['json'], 10],
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
  'project-small-uppercase-fallback'
);
assert.deepEqual(
  uppercaseResultBatch.results[0].sizeRanking.relevantExtensions,
  ['json']
);
assert.equal(uppercaseResultBatch.results[0].sizeRanking.relevantLines, 100);

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
  'project-small-nested-fallback'
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
  'project-more-json-lines'
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
assert.equal(urlPathBatch.results[0].projectName, 'project-small-overall');

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
  totalsByFulfillment: fulfillmentTotals({ fulfilled: projects.length }),
};
const bulkProgressPageSizes: number[] = [];
const bulkProgressStatuses = new Map<string, string>();
let retryableBulkFailuresRemaining = 1;
const apiServer = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Content-Type', 'application/json');
  if (
    request.method === 'GET' &&
    url.pathname === '/mcp-cli/matched-projects'
  ) {
    const fulfilledProjects = bulkProgressStatuses.size
      ? [...bulkProgressStatuses].map(([name, status]) => project(name, status))
      : projects;
    response.end(
      JSON.stringify({
        ...apiResponse,
        projectGroups: {
          fulfilled: fulfilledProjects,
          unfulfilled: [
            {
              ...project('project-unfulfilled', 'pending', {}, 'unfulfilled'),
              value: false,
            },
          ],
          unchecked: [project('project-unchecked', 'pending', {}, 'unchecked')],
        },
        total: fulfilledProjects.length + 2,
        totalsByFulfillment: fulfillmentTotals({
          fulfilled: fulfilledProjects.length,
          unfulfilled: 1,
          unchecked: 1,
        }),
      })
    );
    return;
  }
  if (request.method === 'PUT' && url.pathname === '/mcp-cli/progress/bulk') {
    let serializedBody = '';
    for await (const chunk of request) {
      serializedBody += chunk;
    }
    const body = JSON.parse(serializedBody);
    bulkProgressPageSizes.push(body.items.length);
    assert(body.items.length <= 25);
    if (retryableBulkFailuresRemaining > 0) {
      retryableBulkFailuresRemaining -= 1;
      response.statusCode = 503;
      response.setHeader('x-request-id', 'bulk-retry-1');
      response.end(JSON.stringify({ message: 'Temporary bulk failure' }));
      return;
    }
    for (const item of body.items) {
      if (item.projectName !== 'explicit-error') {
        bulkProgressStatuses.set(item.projectName, item.status);
      }
    }
    const explicitErrors = body.items.filter(
      (item) => item.projectName === 'explicit-error'
    ).length;
    response.end(
      JSON.stringify({
        successCount: body.items.length - explicitErrors,
        errorCount: explicitErrors,
        results: body.items.map((item, index) =>
          item.projectName === 'explicit-error'
            ? {
                index,
                runKey: item.runKey,
                projectName: item.projectName,
                status: 'error',
                error: 'Explicit item validation failed.',
              }
            : {
                index,
                runKey: item.runKey,
                projectName: item.projectName,
                status: 'success',
                id: index + 1,
                changed: true,
              }
        ),
      })
    );
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
  assert(names.includes('omniboard_runner_report_agentic_run_progress_bulk'));
  assert(names.includes('omniboard_runner_heartbeat_agentic_run_workspace'));
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
  assert.equal(listedContent.unfilteredTotal, 6);
  assert.equal(listedContent.returned, 1);
  assert.equal(listedContent.hasMore, true);
  assert.deepEqual(listedContent.statuses, ['failed']);
  assert.deepEqual(
    listedContent.totalsByFulfillment,
    fulfillmentTotals({ fulfilled: 4, unfulfilled: 1, unchecked: 1 })
  );
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

  const allResultGroups = await client.callTool({
    name: 'omniboard_runner_list_agentic_run_projects',
    arguments: {
      runKey: run.runKey,
      view: 'summary',
    },
  });
  assert(!allResultGroups.isError);
  const allResultGroupsContent = matchedProjectsOutputSchema.parse(
    allResultGroups.structuredContent
  );
  assert.deepEqual(
    new Set(
      allResultGroupsContent.projects.map(({ fulfillment }) => fulfillment)
    ),
    new Set(['fulfilled', 'unfulfilled', 'unchecked'])
  );

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

  const bulkProgress = await client.callTool({
    name: 'omniboard_runner_report_agentic_run_progress_bulk',
    arguments: {
      items: Array.from({ length: 51 }, (_, index) => ({
        runKey: run.runKey,
        projectName: `bulk-project-${index + 1}`,
        status: 'pending',
        notes: 'Reset after runner bug.',
      })),
    },
  });
  assert(!bulkProgress.isError);
  const bulkProgressContent = progressBulkReportOutputSchema.parse(
    bulkProgress.structuredContent
  );
  assert.deepEqual(
    {
      total: bulkProgressContent.total,
      successCount: bulkProgressContent.successCount,
      errorCount: bulkProgressContent.errorCount,
      pageCount: bulkProgressContent.pageCount,
    },
    { total: 51, successCount: 51, errorCount: 0, pageCount: 3 }
  );
  assert.equal(bulkProgressContent.verifiedCount, 51);
  assert.equal(bulkProgressContent.residualCount, 0);
  assert.deepEqual(bulkProgressPageSizes, [25, 25, 25, 1]);
  assert.equal(bulkProgressContent.results[25].index, 25);
  assert.equal(bulkProgressContent.results[50].index, 50);

  bulkProgressStatuses.set('explicit-error', 'pending');
  const explicitErrorProgress = await client.callTool({
    name: 'omniboard_runner_report_agentic_run_progress_bulk',
    arguments: {
      items: [
        {
          runKey: run.runKey,
          projectName: 'explicit-error',
          status: 'pending',
        },
      ],
    },
  });
  assert(!explicitErrorProgress.isError);
  const explicitErrorContent = progressBulkReportOutputSchema.parse(
    explicitErrorProgress.structuredContent
  );
  assert.equal(explicitErrorContent.successCount, 0);
  assert.equal(explicitErrorContent.errorCount, 1);
  assert.equal(explicitErrorContent.verifiedCount, 0);
  assert.equal(explicitErrorContent.residualCount, 1);
  assert.equal(explicitErrorContent.results[0].status, 'error');
  assert.match(
    explicitErrorContent.residuals[0].verificationError,
    /explicitly rejected/
  );

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

function project(name, status, progress = {}, fulfillment = 'fulfilled') {
  return {
    id: name.charCodeAt(name.length - 1),
    name,
    value: true,
    result: { large: 'payload' },
    fulfillment,
    targetedByRun: true,
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

function projectWithSizeBreakdown(
  name,
  sourceLines,
  typescriptLines,
  otherLines
) {
  return {
    ...project(name, 'failed'),
    projectSize: {
      totalFiles: otherLines > 0 ? 3 : 2,
      totalLines: sourceLines + otherLines,
      byExtension: {
        ts: 1,
        html: 1,
        ...(otherLines > 0 ? { json: 1 } : {}),
      },
      linesByExtension: {
        ts: typescriptLines,
        html: sourceLines - typescriptLines,
        ...(otherLines > 0 ? { json: otherLines } : {}),
      },
      breakdownVersion: 1,
      source: {
        totalFiles: 2,
        totalLines: sourceLines,
        byExtension: { ts: 1, html: 1 },
        linesByExtension: {
          ts: typescriptLines,
          html: sourceLines - typescriptLines,
        },
      },
      others: {
        totalFiles: otherLines > 0 ? 1 : 0,
        totalLines: otherLines,
        byExtension: otherLines > 0 ? { json: 1 } : {},
        linesByExtension: otherLines > 0 ? { json: otherLines } : {},
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
      totalsByFulfillment: fulfillmentTotals({
        fulfilled: candidateProjects.length,
      }),
    },
    { statuses: ['failed'] }
  );
}

function fulfillmentTotals(overrides = {}) {
  return {
    fulfilled: 0,
    unfulfilled: 0,
    unchecked: 0,
    ...overrides,
  };
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
