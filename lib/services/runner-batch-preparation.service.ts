import {
  AgenticRunProgressStatus,
  RunnerWorkspacePrepareResult,
} from '../interface.js';
import { listAgenticRunProjects } from './agentic-runs.service.js';
import { hasActiveRunnerExecutionLease } from './runner-execution.service.js';
import {
  isRunnerWorkspacePreparationInProgress,
  prepareRunnerWorkspace,
} from './runner-workspace-preparation.service.js';

const DEFAULT_STATUSES: AgenticRunProgressStatus[] = ['blocked', 'failed'];
const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 10;

export interface PrepareNextRunnerProjectsOptions {
  runKey: string;
  statuses?: AgenticRunProgressStatus[];
  limit?: number;
}

export interface RunnerBatchPreparationResult {
  runKey: string;
  requestedStatuses: AgenticRunProgressStatus[];
  requestedLimit: number;
  candidatesTotal: number;
  examined: number;
  hasMore: boolean;
  summary: {
    prepared: number;
    waiting: number;
    stopped: number;
    failed: number;
  };
  results: RunnerBatchPreparationProjectResult[];
}

export interface RunnerBatchPreparationProjectResult {
  projectName: string;
  initialStatus: AgenticRunProgressStatus | null;
  outcome: 'prepared' | 'waiting' | 'stopped' | 'failed';
  preparation?: RunnerWorkspacePrepareResult;
  reason?: 'preparation_in_progress' | 'execution_lease_active';
  error?: string;
}

export interface RunnerBatchPreparationDependencies {
  listProjects: typeof listAgenticRunProjects;
  prepareWorkspace: typeof prepareRunnerWorkspace;
  isWorkspacePreparationInProgress: typeof isRunnerWorkspacePreparationInProgress;
  hasActiveExecutionLease: typeof hasActiveRunnerExecutionLease;
}

const defaultDependencies: RunnerBatchPreparationDependencies = {
  listProjects: listAgenticRunProjects,
  prepareWorkspace: prepareRunnerWorkspace,
  isWorkspacePreparationInProgress: isRunnerWorkspacePreparationInProgress,
  hasActiveExecutionLease: hasActiveRunnerExecutionLease,
};

export async function prepareNextRunnerProjects(
  options: PrepareNextRunnerProjectsOptions,
  dependencies: RunnerBatchPreparationDependencies = defaultDependencies
): Promise<RunnerBatchPreparationResult> {
  const statuses = [...new Set(options.statuses ?? DEFAULT_STATUSES)];
  const limit = options.limit ?? DEFAULT_LIMIT;
  assertOptions(statuses, limit);

  const discovery = await dependencies.listProjects({
    runKey: options.runKey,
    statuses,
    view: 'full',
  });
  const summary = {
    prepared: 0,
    waiting: 0,
    stopped: 0,
    failed: 0,
  };
  const results: RunnerBatchPreparationProjectResult[] = [];
  let nextCandidateIndex = 0;

  while (
    nextCandidateIndex < discovery.projects.length &&
    summary.prepared < limit
  ) {
    const project = discovery.projects[nextCandidateIndex];
    nextCandidateIndex += 1;
    const initialStatus = project.progress?.status ?? null;

    const unavailableReason = dependencies.isWorkspacePreparationInProgress(
      options.runKey,
      project.name
    )
      ? 'preparation_in_progress'
      : dependencies.hasActiveExecutionLease(options.runKey, project.name)
      ? 'execution_lease_active'
      : null;
    if (unavailableReason) {
      summary.waiting += 1;
      results.push({
        projectName: project.name,
        initialStatus,
        outcome: 'waiting',
        reason: unavailableReason,
      });
      continue;
    }

    try {
      const preparation = await dependencies.prepareWorkspace({
        runKey: options.runKey,
        projectName: project.name,
      });
      const outcome = preparation.workspace
        ? 'prepared'
        : preparation.continuation.action === 'wait'
        ? 'waiting'
        : preparation.continuation.action === 'stop'
        ? 'stopped'
        : null;
      if (!outcome) {
        throw new Error(
          'Runner preparation permitted work but returned no workspace.'
        );
      }

      summary[outcome] += 1;
      results.push({
        projectName: project.name,
        initialStatus,
        outcome,
        preparation,
      });
    } catch (error) {
      summary.failed += 1;
      results.push({
        projectName: project.name,
        initialStatus,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    runKey: options.runKey,
    requestedStatuses: statuses,
    requestedLimit: limit,
    candidatesTotal: discovery.total,
    examined: results.length,
    hasMore: nextCandidateIndex < discovery.projects.length,
    summary,
    results,
  };
}

function assertOptions(statuses: AgenticRunProgressStatus[], limit: number) {
  if (statuses.length === 0) {
    throw new Error('At least one project progress status is required.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(
      `Batch preparation limit must be an integer between 1 and ${MAX_LIMIT}.`
    );
  }
}
