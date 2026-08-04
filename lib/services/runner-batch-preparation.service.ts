import {
  AgenticRunMatchedProject,
  AgenticRunProgressStatus,
  RunnerWorkspacePrepareResult,
} from '../interface.js';
import { listAgenticRunProjects } from './agentic-runs.service.js';
import {
  hasActiveRunnerExecutionLease,
  RunnerExecutionLeaseConflictError,
} from './runner-execution.service.js';
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
  const { sourceSelection, projectExtensions } = resolveSourceSelection(
    options.relevantSourceExtensions,
    discovery.run?.prompt ?? discovery.check.prompt,
    discovery.check.description,
    discovery.projects
  );
  const candidates = discovery.projects
    .map((project, index) => ({
      project,
      sizeRanking: createProjectSizeRanking(project, projectExtensions[index]),
    }))
    .sort(compareRankedProjects);
  sourceSelection.projectsWithSize = candidates.filter(
    ({ sizeRanking }) => sizeRanking.metadataAvailable
  ).length;
  sourceSelection.projectsWithoutSize =
    candidates.length - sourceSelection.projectsWithSize;
  const summary = {
    prepared: 0,
    waiting: 0,
    stopped: 0,
    failed: 0,
  };
  const results: RunnerBatchPreparationProjectResult[] = [];
  let nextCandidateIndex = 0;

  while (nextCandidateIndex < candidates.length && summary.prepared < limit) {
    const { project, sizeRanking } = candidates[nextCandidateIndex];
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
      });
    } catch (error) {
      if (error instanceof RunnerExecutionLeaseConflictError) {
        summary.waiting += 1;
        results.push({
          projectName: project.name,
          initialStatus,
          outcome: 'waiting',
          sizeRanking,
          reason: 'execution_lease_active',
        });
        continue;
      }
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
    candidatesTotal: discovery.total,
    examined: results.length,
    hasMore: nextCandidateIndex < candidates.length,
    sourceSelection,
    summary,
    results,
  };
}

function resolveSourceSelection(
  requestedExtensions: string[] | undefined,
  prompt: string | null | undefined,
  description: string | null | undefined,
  projects: AgenticRunMatchedProject[]
): ResolvedRunnerBatchSourceSelection {
  if (requestedExtensions !== undefined) {
    if (
      requestedExtensions.length === 0 ||
      requestedExtensions.some(
        (extension) => normalizeExtension(extension) === undefined
      )
    ) {
      throw new Error(
        'Relevant source extensions must contain only valid file extensions.'
      );
    }
    const extensions = normalizeExtensions(requestedExtensions);
    return {
      sourceSelection: {
        extensions,
        origin: 'explicit',
        projectsWithSize: 0,
        projectsWithoutSize: 0,
      },
      projectExtensions: projects.map(() => extensions),
    };
  }

  const promptExtensions = normalizeExtensions(
    extractPromptExtensions([prompt, description].filter(Boolean).join(' '))
  );
  const projectExtensions = projects.map((project) => {
    const availableExtensions = new Set(
      normalizeExtensions(
        project.projectSize
          ? [
              ...Object.keys(project.projectSize.byExtension),
              ...Object.keys(project.projectSize.linesByExtension),
            ]
          : []
      )
    );
    return normalizeExtensions([
      ...promptExtensions,
      ...extractResultExtensions(project.result, availableExtensions),
    ]);
  });
  const inferredExtensions = normalizeExtensions(projectExtensions.flat());

  return {
    sourceSelection: {
      extensions: inferredExtensions,
      origin:
        inferredExtensions.length > 0
          ? 'prompt_and_results'
          : 'total_project_fallback',
      projectsWithSize: 0,
      projectsWithoutSize: 0,
    },
    projectExtensions,
  };
}

function createProjectSizeRanking(
  project: AgenticRunMatchedProject,
  relevantExtensions: string[]
): RunnerBatchProjectSizeRanking {
  const projectSize = project.projectSize;
  if (!projectSize) {
    return {
      metadataAvailable: false,
      relevantExtensions: [...relevantExtensions],
      relevantLines: null,
      relevantFiles: null,
      totalLines: null,
      totalFiles: null,
    };
  }

  const selectedExtensions = relevantExtensions.length
    ? relevantExtensions
    : Object.keys(projectSize.linesByExtension);

  return {
    metadataAvailable: true,
    relevantExtensions: [...selectedExtensions],
    relevantLines: selectedExtensions.reduce(
      (total, extension) =>
        total + (projectSize.linesByExtension[extension] ?? 0),
      0
    ),
    relevantFiles: selectedExtensions.reduce(
      (total, extension) => total + (projectSize.byExtension[extension] ?? 0),
      0
    ),
    totalLines: projectSize.totalLines,
    totalFiles: projectSize.totalFiles,
  };
}

function compareRankedProjects(
  left: {
    project: AgenticRunMatchedProject;
    sizeRanking: RunnerBatchProjectSizeRanking;
  },
  right: {
    project: AgenticRunMatchedProject;
    sizeRanking: RunnerBatchProjectSizeRanking;
  }
) {
  if (
    left.sizeRanking.metadataAvailable !== right.sizeRanking.metadataAvailable
  ) {
    return left.sizeRanking.metadataAvailable ? -1 : 1;
  }

  for (const key of [
    'relevantLines',
    'relevantFiles',
    'totalLines',
    'totalFiles',
  ] as const) {
    const difference =
      (left.sizeRanking[key] ?? Number.MAX_SAFE_INTEGER) -
      (right.sizeRanking[key] ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) {
      return difference;
    }
  }

  return left.project.name.localeCompare(right.project.name);
}

const PROMPT_EXTENSION_KEYWORDS: ReadonlyArray<
  readonly [RegExp, readonly string[]]
> = [
  [/\bjson\b/i, ['json']],
  [/\byaml\b/i, ['yaml', 'yml']],
  [/\btypescript\b/i, ['ts', 'tsx']],
  [/\bjavascript\b/i, ['js', 'jsx', 'mjs', 'cjs']],
  [/\bhtml\b/i, ['html']],
  [/\bcss\b/i, ['css', 'scss', 'sass', 'less']],
  [/\bjava\b/i, ['java']],
  [/\bkotlin\b/i, ['kt', 'kts']],
  [/\bpython\b/i, ['py']],
  [/\brust\b/i, ['rs']],
  [/\bgolang\b/i, ['go']],
];

function extractPromptExtensions(text: string) {
  const extensions = extractFileLikeExtensions(text);
  for (const [pattern, matchingExtensions] of PROMPT_EXTENSION_KEYWORDS) {
    if (pattern.test(text)) {
      extensions.push(...matchingExtensions);
    }
  }
  return extensions;
}

function extractResultExtensions(
  value: unknown,
  availableExtensions: Set<string>,
  filePathContext = false
): string[] {
  if (typeof value === 'string') {
    if (!filePathContext) {
      return [];
    }
    return normalizeExtensions(extractFileLikeExtensions(value)).filter(
      (extension) =>
        availableExtensions.size === 0 || availableExtensions.has(extension)
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      extractResultExtensions(item, availableExtensions, filePathContext)
    );
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    extractResultExtensions(
      child,
      availableExtensions,
      filePathContext || isResultFilePathContextKey(key)
    )
  );
}

function isResultFilePathContextKey(key: string) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .map((segment) => segment.toLowerCase());
  return segments.some((segment) =>
    /^(?:files?|paths?|sources?|targets?)$/.test(segment)
  );
}

function extractFileLikeExtensions(text: string) {
  const textWithUrlPathnames = text.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi,
    (url) => {
      try {
        return new URL(url).pathname;
      } catch {
        return ' ';
      }
    }
  );
  return [
    ...textWithUrlPathnames.matchAll(
      /(?:^|[\\/\w@.-])\.([a-z][a-z0-9+-]{0,15})(?=$|[^a-z0-9+.-])/gi
    ),
  ].map((match) => match[1]);
}

function normalizeExtensions(extensions: string[]) {
  const normalized = extensions
    .map(normalizeExtension)
    .filter((extension): extension is string => Boolean(extension));
  return [...new Set(normalized)];
}

function normalizeExtension(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '[none]') {
    return trimmed;
  }
  const pathExtension = trimmed.match(/\.([a-z][a-z0-9+-]{0,15})$/)?.[1];
  const extension = pathExtension ?? trimmed.replace(/^\*?\./, '');
  return /^[a-z][a-z0-9+-]{0,15}$/.test(extension) ? extension : undefined;
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
