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
  actionable: boolean;
  prompt: string | null;
}

export interface McpApiCheckSummary extends McpApiCheck {
  value: boolean | null;
}

export interface McpApiChecksResponse {
  project: McpApiProject;
  checks: McpApiCheckSummary[];
}

export interface McpApiCheckResultResponse {
  project: Pick<McpApiProject, 'id' | 'name'>;
  check: McpApiCheck;
  result: unknown;
}

export interface ActionableCheckSummary {
  name: string;
  type: string;
  description: string | null;
  prompt: string | null;
  value: boolean | null;
}

export interface ActionableChecksResponse {
  project: McpApiProject;
  checks: ActionableCheckSummary[];
}

export interface ActionableCheckResultResponse {
  project: Pick<McpApiProject, 'id' | 'name'>;
  check: McpApiCheck;
  result: unknown;
  agentContext?: ActionableCheckAgentContext;
}

export interface ActionableCheckAgentContext {
  goal: string;
  instructions: string[];
  validation: {
    optional: boolean;
    requiredEnv: 'OMNIBOARD_API_KEY';
    tool: 'omniboard_validate_actionable_check_fix';
    skipWhenMissingEnv: boolean;
  };
}

export interface ActionableCheckValidationResponse {
  checkName: string;
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
}
