import { ProjectInfo, Settings } from '../interface.js';
import * as api from './api.service.js';
import { resolveProjectInfo } from './project.service.js';

let settingsCache: Settings | undefined;
let projectCache: ProjectInfo | undefined;

export async function getOmniboardSettings() {
  if (!settingsCache) {
    settingsCache = await api.getSettings();
  }

  return settingsCache;
}

export async function getOmniboardProject() {
  if (!projectCache) {
    const settings = await getOmniboardSettings();
    projectCache = await resolveProjectInfo(settings.customProjectResolvers);
    validateProjectAllowed(projectCache, settings);
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
