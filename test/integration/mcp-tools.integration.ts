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
    status: 'pending',
    workflow: {
      outcome: 'actionable',
      nextAction: 'prepare',
      maintenance: [],
      reason: 'operator_retry_requested',
      instruction: 'Reassess the migration.',
    },
    retryInstructions: [
      {
        id: 1,
        disposition: 'accepted',
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

assert.throws(
  () =>
    getAgenticRunContinuationDecision({
      progress: {},
      providerSync: { success: true, diagnostics: [] },
    } as any),
  /workflow contract is missing/
);
for (const [outcome, nextAction] of [
  ['actionable', 'prepare'],
  ['waiting', 'wait'],
  ['dismissed', 'stop'],
  ['complete', 'stop'],
] as const) {
  const decision = getAgenticRunContinuationDecision({
    progress: {
      workflow: {
        outcome,
        nextAction,
        maintenance: [],
        reason: 'server_decision',
        instruction: 'Server instruction',
      },
    },
    providerSync: { success: true, diagnostics: [] },
  } as any);
  assert.equal(decision.outcome, outcome);
  assert.equal(
    decision.action,
    nextAction === 'prepare' ? 'continue' : nextAction
  );
}

const run = {
  runKey: 'run-icons',
  checkName: 'icon-registry',
  targetFulfillment: 'fulfilled',
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

const selectionRequests: any[] = [];
const selectedNames = ['server-first', 'server-second', 'server-third'];
const sizeRanking = {
  metadataAvailable: false,
  relevantExtensions: [],
  relevantLines: null,
  relevantFiles: null,
  totalLines: null,
  totalFiles: null,
};
const selection = (names: string[], hasMore = false) => ({
  assessments: [],
  candidates: names.map((name) => ({
    project: project(name, 'mr_created'),
    sizeRanking,
  })),
  examined: names,
  candidatesTotal: 3,
  hasMore,
  requestedStatuses: ['mr_created'],
  sourceSelection: {
    extensions: [],
    origin: 'total_project_fallback',
    projectsWithSize: 0,
    projectsWithoutSize: 3,
  },
});
const selectedBatch = await prepareNextRunnerProjects(
  { runKey: run.runKey, limit: 1 },
  {
    nextProjects: async (options) => {
      selectionRequests.push(options);
      return selectionRequests.length === 1
        ? selection(selectedNames.slice(0, 2), true)
        : selection(selectedNames.slice(2));
    },
    isWorkspacePreparationInProgress: (_run, name) => name === 'server-first',
    prepareWorkspace: async ({ projectName }) =>
      preparation(
        projectName,
        projectName === 'server-second' ? 'wait' : 'continue',
        projectName === 'server-third'
      ),
  } as any
);
assert.deepEqual(
  selectedBatch.results.map((result) => [result.projectName, result.outcome]),
  [
    ['server-first', 'waiting'],
    ['server-second', 'waiting'],
    ['server-third', 'prepared'],
  ]
);
assert.deepEqual(selectionRequests[1].excludeProjectNames, [
  'server-first',
  'server-second',
]);
assert.equal(selectedBatch.summary.prepared, 1);
assert.equal(selectedBatch.hasMore, false);
const emptyBatch = await prepareNextRunnerProjects({ runKey: run.runKey }, {
  nextProjects: async () => selection([]),
  isWorkspacePreparationInProgress: () => false,
  prepareWorkspace: async () => {
    throw new Error('No server-authorized candidate');
  },
} as any);
assert.equal(emptyBatch.results.length, 0);

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
  const instructions = client.getInstructions();
  assert(instructions);
  assert.match(instructions, /Prime directive.*open, green, mergeable MR/);
  assert.match(instructions, /Never merge it automatically/);
  assert.match(
    instructions,
    /pending work, then started\/published work, then failed\/blocked\/retry work/
  );
  assert.match(
    instructions,
    /Duplicate effort on unfinished work is an accepted efficiency tradeoff/
  );
  assert.match(instructions, /A completed migration must not be republished/);
  assert.match(
    instructions,
    /Mandatory preflight for every agent and environment/
  );
  assert.match(
    instructions,
    /On stop\/change_merged, leave retained local work untouched/
  );
  assert.match(
    instructions,
    /Do not replay whole files from an old migration commit/
  );
  assert.match(
    instructions,
    /old local test results do not validate a newly assembled remote commit/
  );
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert(names.includes('omniboard_runner_list_agentic_runs'));
  assert(names.includes('omniboard_runner_list_agentic_run_projects'));
  assert(names.includes('omniboard_runner_prepare_next_agentic_run_projects'));
  assert(names.includes('omniboard_runner_prepare_agentic_run_workspace'));
  assert(names.includes('omniboard_runner_finalize_agentic_run_workspace'));
  assert(!names.includes('omniboard_runner_merge_agentic_run'));
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
      workflow: {
        outcome: 'actionable',
        nextAction: 'prepare',
        maintenance: [],
        reason: 'active_work',
        instruction: 'Server instruction',
      },
      status,
      ...progress,
    },
  };
}

function fulfillmentTotals(overrides = {}) {
  return {
    fulfilled: 0,
    unfulfilled: 0,
    unchecked: 0,
    ...overrides,
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
