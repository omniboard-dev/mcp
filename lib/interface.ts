export interface CustomProjectResolver {
  type: string;
  filePattern: string;
  projectNamePattern: string;
}

export interface Settings {
  customProjectResolvers?: CustomProjectResolver[];
  projectsBlacklistPattern?: string;
  projectsBlacklistExplicit?: string[];
}

export interface ProjectInfo {
  name: string;
  names: string[];
  type?: ProjectType | string;
  repository?: string;
  repositories?: string[];
  branch?: string;
  [key: string]: unknown;
}

export enum ProjectType {
  NPM = 'npm',
  MAVEN = 'MAVEN',
  PIP = 'pip',
  REPO = 'repo',
}

export interface McpApiProject {
  id: number;
  name: string;
  lastAnalysisDate?: string | Date;
}

export interface McpApiCheck {
  name: string;
  type: string;
  description: string | null;
  agentic: boolean;
  prompt: string | null;
  runKey?: string | null;
  agenticRuns?: McpApiAgenticRun[];
}

export interface McpApiCheckSummary extends McpApiCheck {
  value: boolean | null;
}

export interface McpApiChecksResponse {
  project: McpApiProject;
  checks: McpApiCheckSummary[];
}

export interface McpApiRunResponse {
  project: Pick<McpApiProject, 'id' | 'name'>;
  check: McpApiCheck;
  run: McpApiAgenticRun;
  result: unknown;
}

export interface McpApiMatchedProject {
  id: number;
  name: string;
  lastAnalysisDate?: string | Date | null;
  updateDate?: string | Date | null;
  value?: boolean | string | null;
  result?: unknown;
}

export interface McpApiMatchedProjectsResponse {
  check: McpApiCheck;
  run: McpApiAgenticRun | null;
  runs: McpApiAgenticRun[];
  projects: McpApiMatchedProject[];
  total: number;
}

export interface McpApiAgenticRun {
  runKey?: string;
  key?: string;
  id?: string | number;
  checkName?: string;
  check?: Partial<McpApiCheck> | null;
  project?: Partial<McpApiProject> | null;
  prompt?: string | null;
  status?: AgenticRunStatus | string | null;
  progress?: Record<string, unknown> | null;
  result?: unknown;
  isActive?: boolean;
  active?: boolean;
  creationDate?: string | Date | null;
  updateDate?: string | Date | null;
  [key: string]: unknown;
}

export interface AgenticRunAgentContext {
  goal: string;
  instructions: string[];
  validation: {
    optional: boolean;
    requiredEnv: 'OMNIBOARD_API_KEY';
    tool: 'omniboard_local_validate_agentic_run';
    skipWhenMissingEnv: boolean;
  };
}

export interface AgenticRunValidationResponse {
  checkName: string;
  runKey: string;
  run: AgenticRunSummary;
  skipped: boolean;
  skipReason?: string;
  command: string;
  outputPath: string;
  value?: boolean;
  stillMatches?: boolean;
  resolved?: boolean;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  generatedJsonCleanedUp: boolean;
  progressReport?: AgenticRunProgressReportResult;
}

export interface AgenticRunsResponse {
  project: McpApiProject;
  runs: AgenticRunSummary[];
  total: number;
}

export interface AgenticRunResponse {
  project: Pick<McpApiProject, 'id' | 'name'>;
  run: AgenticRunSummary;
  result?: unknown;
  agentContext?: AgenticRunAgentContext;
  progressReport?: AgenticRunProgressReportResult;
}

export interface AgenticRunMatchedProject {
  id: number;
  name: string;
  lastAnalysisDate?: string | Date | null;
  updateDate?: string | Date | null;
  value?: boolean | string | null;
  result?: unknown;
}

export interface AgenticRunMatchedProjectsResponse {
  check: McpApiCheck;
  run: AgenticRunSummary | null;
  runs: AgenticRunSummary[];
  projects: AgenticRunMatchedProject[];
  total: number;
}

export interface AgenticRunSummary {
  runKey: string;
  checkName: string;
  check?: Partial<McpApiCheck> | null;
  project?: Partial<McpApiProject> | null;
  prompt?: string | null;
  status?: AgenticRunStatus | string | null;
  progress?: Record<string, unknown> | null;
  result?: unknown;
  isActive: boolean;
  creationDate?: string | Date | null;
  updateDate?: string | Date | null;
  raw?: McpApiAgenticRun;
}

export const AGENTIC_RUN_STATUS_VALUES = [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
] as const;

export type AgenticRunStatus = (typeof AGENTIC_RUN_STATUS_VALUES)[number];

export const AGENTIC_RUN_PROGRESS_STATUS_VALUES = [
  'pending',
  'in_progress',
  'implemented',
  'needs_input',
  'verified',
  'committed',
  'pushed',
  'mr_created',
  'merged',
  'blocked',
  'failed',
] as const;

export type AgenticRunProgressStatus =
  (typeof AGENTIC_RUN_PROGRESS_STATUS_VALUES)[number];

export interface AgenticRunProgressUpsertInput {
  runKey: string;
  projectName: string;
  status?: AgenticRunProgressStatus;
  repositoryUrl?: string | null;
  localPath?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  mergeRequestUrl?: string | null;
  mergeRequestState?: string | null;
  mergeRequestDetailedStatus?: string | null;
  pipelineStatus?: string | null;
  pipelineUrl?: string | null;
  pipelineFailureSummary?: string | null;
  error?: string | null;
  notes?: string | null;
  verification?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  lastUpdateSource?: string;
}

export interface AgenticRunProgressUpsertResponse {
  changed: boolean;
  progress?: Record<string, unknown>;
  row?: Record<string, unknown>;
  run?: AgenticRunSummary;
  [key: string]: unknown;
}

export interface AgenticRunProgressBulkResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: AgenticRunProgressBulkRowResult[];
}

export interface AgenticRunProgressBulkRowResult {
  index: number;
  success: boolean;
  result?: AgenticRunProgressUpsertResponse;
  error?: string;
}

export interface AgenticRunProgressReportResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  changed?: boolean;
  payload?: AgenticRunProgressUpsertInput;
  response?: AgenticRunProgressUpsertResponse;
}
