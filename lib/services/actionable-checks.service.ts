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

export async function initializeActionableChecksService() {
  settingsCache = await api.getSettings();
  projectCache = await resolveProjectInfo(settingsCache.customProjectResolvers);
  validateProjectAllowed(projectCache, settingsCache);
}

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
    resultCache.set(
      name,
      await api.getActionableCheckResult(await getProject(), name)
    );
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
