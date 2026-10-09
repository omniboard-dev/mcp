import {
  AgenticRunMatchedProject,
  AgenticRunProgressStatus,
  AgenticRunWorkflowDecision,
  RunnerWorkspacePrepareResult,
} from '../interface.js';
import { nextAgenticRunProjects } from './api.service.js';
import {
  isRunnerWorkspacePreparationInProgress,
  prepareRunnerWorkspace,
} from './runner-workspace-preparation.service.js';

export interface PrepareNextRunnerProjectsOptions {
  runKey: string;
  statuses?: AgenticRunProgressStatus[];
  limit?: number;
  relevantSourceExtensions?: string[];
}

export type RunnerBatchSourceSelectionOrigin =
  | 'explicit'
  | 'prompt_and_results'
  | 'total_project_fallback';

export interface RunnerBatchSourceSelection {
  extensions: string[];
  origin: RunnerBatchSourceSelectionOrigin;
  projectsWithSize: number;
  projectsWithoutSize: number;
}

interface ResolvedRunnerBatchSourceSelection {
  sourceSelection: RunnerBatchSourceSelection;
  projectExtensions: string[][];
}

export interface RunnerBatchProjectSizeRanking {
  metadataAvailable: boolean;
  relevantExtensions: string[];
  relevantLines: number | null;
  relevantFiles: number | null;
  totalLines: number | null;
  totalFiles: number | null;
}

export interface RunnerBatchPreparationResult {
  runKey: string;
  requestedStatuses: AgenticRunProgressStatus[];
  requestedLimit: number;
  candidatesTotal: number;
  examined: number;
  hasMore: boolean;
  sourceSelection: RunnerBatchSourceSelection;
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
  sizeRanking: RunnerBatchProjectSizeRanking;
  preparation?: RunnerWorkspacePrepareResult;
  reason?: string;
  error?: string;
}

export interface RunnerBatchPreparationDependencies {
  nextProjects: typeof nextAgenticRunProjects;
  prepareWorkspace: typeof prepareRunnerWorkspace;
  isWorkspacePreparationInProgress: typeof isRunnerWorkspacePreparationInProgress;
}

const defaultDependencies: RunnerBatchPreparationDependencies = {
  nextProjects: nextAgenticRunProjects,
  prepareWorkspace: prepareRunnerWorkspace,
  isWorkspacePreparationInProgress: isRunnerWorkspacePreparationInProgress,
};

export async function prepareNextRunnerProjects(
  options: PrepareNextRunnerProjectsOptions,
  dependencies: RunnerBatchPreparationDependencies = defaultDependencies
): Promise<RunnerBatchPreparationResult> {
  const limit = options.limit ?? 1;
  let selection = await dependencies.nextProjects(options);
  const statuses = selection.requestedStatuses;
  const sourceSelection = selection.sourceSelection;
  const candidatesTotal = selection.candidatesTotal;
  const excluded = new Set<string>();
  const summary = {
    prepared: 0,
    waiting: 0,
    stopped: 0,
    failed: 0,
  };
  const results: RunnerBatchPreparationProjectResult[] = [];
  const recordAssessments = () => {
    for (const assessment of selection.assessments) {
      if (assessment.workflow.nextAction === 'prepare') continue;
      const outcome =
        assessment.workflow.nextAction === 'wait' ? 'waiting' : 'stopped';
      summary[outcome]++;
      results.push({
        projectName: assessment.projectName,
        initialStatus: assessment.initialStatus,
        sizeRanking: assessment.sizeRanking,
        outcome,
        reason: assessment.workflow.reason,
      });
    }
  };
  recordAssessments();
  let nextCandidateIndex = 0;
  while (summary.prepared < limit) {
    if (nextCandidateIndex >= selection.candidates.length) {
      selection.examined.forEach((name) => excluded.add(name));
      if (!selection.hasMore) break;
      selection = await dependencies.nextProjects({
        ...options,
        limit: limit - summary.prepared,
        excludeProjectNames: [...excluded],
      });
      recordAssessments();
      nextCandidateIndex = 0;
      continue;
    }
    const { project, sizeRanking } = selection.candidates[nextCandidateIndex++];
    const initialStatus = project.progress?.status ?? 'pending';

    const unavailableReason = dependencies.isWorkspacePreparationInProgress(
      options.runKey,
      project.name
    )
      ? 'preparation_in_progress'
      : null;
    if (unavailableReason) {
      summary.waiting += 1;
      results.push({
        projectName: project.name,
        initialStatus,
        outcome: 'waiting',
        sizeRanking,
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
        sizeRanking,
        preparation,
        ...([
          'waiting_for_ci',
          'waiting_for_review',
          'merge_request_ready',
        ].includes(preparation.continuation.reason)
          ? {
              reason: preparation.continuation.reason as
                | 'waiting_for_ci'
                | 'waiting_for_review'
                | 'merge_request_ready',
            }
          : {}),
      });
    } catch (error) {
      summary.failed += 1;
      results.push({
        projectName: project.name,
        initialStatus,
        outcome: 'failed',
        sizeRanking,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    runKey: options.runKey,
    requestedStatuses: statuses,
    requestedLimit: limit,
    candidatesTotal,
    examined: results.length,
    hasMore:
      nextCandidateIndex < selection.candidates.length || selection.hasMore,
    sourceSelection,
    summary,
    results,
  };
}

export interface RunnerProjectSelection {
  assessments: {
    projectName: string;
    initialStatus: AgenticRunProgressStatus;
    workflow: AgenticRunWorkflowDecision;
    sizeRanking: RunnerBatchProjectSizeRanking;
  }[];
  candidates: {
    project: AgenticRunMatchedProject;
    sizeRanking: RunnerBatchProjectSizeRanking;
  }[];
  examined: string[];
  candidatesTotal: number;
  hasMore: boolean;
  requestedStatuses: AgenticRunProgressStatus[];
  sourceSelection: RunnerBatchSourceSelection;
}
