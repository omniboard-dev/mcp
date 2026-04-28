import {
  ActionableCheckResultResponse,
  ActionableChecksResponse,
  ProjectInfo,
  Settings,
} from '../interface.js';
import * as api from './api.service.js';
import { resolveProjectInfo } from './project.service.js';

let settingsCache: Settings | undefined;
let projectCache: ProjectInfo | undefined;
let checksCache: ActionableChecksResponse | undefined;
const resultCache = new Map<string, ActionableCheckResultResponse>();

export async function listActionableChecks() {
  const data = await getActionableChecks();

  return {
    project: data.project,
    checks: data.checks.map((check) => ({
      name: check.name,
      type: check.type,
      description: check.description,
      prompt: check.prompt,
      value: check.value,
    })),
  };
}

export async function getActionableCheckResults(name: string) {
  const data = await getActionableChecks();
  const check = data.checks.find((check) => check.name === name);

  if (!check) {
    const availableChecks = data.checks.map((check) => check.name).join(', ');
    throw new Error(
      `Actionable check "${name}" was not found for project "${
        data.project.name
      }"${availableChecks ? `. Available checks: ${availableChecks}` : ''}`
    );
  }

  if (!resultCache.has(name)) {
    const result = await api.getActionableCheckResult(await getProject(), name);
    resultCache.set(name, {
      ...result,
      agentContext: {
        goal: `Resolve actionable Omniboard check "${name}" for this project.`,
        instructions: [
          'Use the check metadata, prompt, and result details as the primary context for the change.',
          'Inspect the local codebase before editing and make the smallest coherent change that resolves the actionable check.',
          'After changing the code, run the relevant project build, test, or lint command when available.',
          'If `OMNIBOARD_API_KEY` is available, optionally run the `omniboard_validate_actionable_check_fix` tool for this check to confirm whether it still matches.',
          'If `OMNIBOARD_API_KEY` is not available, skip analyzer validation and report that it was skipped.',
        ],
        validation: {
          optional: true,
          requiredEnv: 'OMNIBOARD_API_KEY',
          tool: 'omniboard_validate_actionable_check_fix',
          skipWhenMissingEnv: true,
        },
      },
    });
  }

  return resultCache.get(name)!;
}

async function getActionableChecks() {
  if (!checksCache) {
    checksCache = await api.getActionableChecks(await getProject());
  }

  return checksCache;
}

async function getProject() {
  if (!projectCache) {
    if (!settingsCache) {
      settingsCache = await api.getSettings();
    }
    projectCache = await resolveProjectInfo(
      settingsCache.customProjectResolvers
    );
    validateProjectAllowed(projectCache, settingsCache);
  }

  return projectCache;
}

function validateProjectAllowed(project: ProjectInfo, settings: Settings) {
  const { projectsBlacklistPattern, projectsBlacklistExplicit } = settings;

  if (
    projectsBlacklistPattern &&
    new RegExp(projectsBlacklistPattern, 'i').test(project.name)
  ) {
    throw new Error(
      `Project "${project.name}" matched the Omniboard blacklist pattern`
    );
  }

  if (
    projectsBlacklistExplicit &&
    projectsBlacklistExplicit.some(
      (projectName) => projectName === project.name
    )
  ) {
    throw new Error(
      `Project "${project.name}" is explicitly blacklisted in Omniboard settings`
    );
  }
}
