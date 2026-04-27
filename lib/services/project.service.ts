import xpath from 'xpath';

import {
  CustomProjectResolver,
  ProjectInfo,
  ProjectType,
} from '../interface.js';
import {
  currentFolderName,
  fileExists,
  findFiles,
  readFile,
  readJson,
  readXmlAsDom,
} from './fs.service.js';
import { getCurrentBranch } from './git.service.js';

const PROJECT_INFO_TASK_EXCLUDE_PATTERN =
  '(^\\.|node_modules|coverage|dist|build|target|out|\\.gradle|\\.mvn|\\.angular|\\.nx|\\.turbo|\\.venv|venv|__pycache__|site-packages|\\.tox|\\.pytest_cache)';
const PROJECT_INFO_TASK_PATTERN_FLAGS = 'i';

export const isMavenWorkspace = (): boolean => {
  return !!findPomXmlFiles()?.length;
};

export const isNpmWorkspace = (): boolean => {
  return !!findPackageJsonFiles()?.length;
};

export const isPipWorkspace = (): boolean => {
  return !!findSetupPyFiles()?.length;
};

export const findProjectNamesNpm = (): string[] => {
  return findPackageJsonFiles()
    .map((f) => readJson(f)?.name)
    .filter(Boolean);
};

export const findProjectNamesMaven = (): string[] => {
  return findPomXmlFiles()
    .map((f) => readXmlAsDom(f))
    .filter(Boolean)
    .map(
      (document) =>
        xpath
          .select(
            'string(//*[local-name()="project"]/*[local-name()="artifactId"])',
            document!,
            true
          )
          ?.toString() || ''
    )
    .filter(Boolean);
};

export const findProjectNamesPip = (): string[] => {
  return Array.from(
    new Set(
      findSetupPyFiles()
        .map((f) => readFile(f))
        .map((content) => /name=\s?"(?<name>.*)"/.exec(content)?.groups?.name!)
        .filter(Boolean)
    )
  );
};

export const findProjectNamesRepo = (): string[] => {
  return [currentFolderName()];
};

export const findProjectRepositoriesNpm = (sanitizeRepoUrl: boolean) => {
  return Array.from(
    new Set(
      findPackageJsonFiles()
        .map((f) => readJson(f)?.repository?.url)
        .filter(Boolean)
        .map((url) => sanitizeRepositoryUrl(url, sanitizeRepoUrl))
    )
  );
};

export const findProjectRepositoriesMaven = (
  sanitizeRepoUrl: boolean
): string[] => {
  return Array.from(
    new Set(
      findPomXmlFiles()
        .map((f) => readXmlAsDom(f))
        .filter(Boolean)
        .flatMap((document) =>
          xpath.select(
            'string(//*[local-name()="project"]/*[local-name()="scm"]/*[local-name()="connection" or local-name()="developerConnection"][last()])',
            document!,
            true
          )
        )
        .filter(Boolean)
        .map((url) => sanitizeRepositoryUrl(url!.toString(), sanitizeRepoUrl))
    )
  );
};

export const findProjectRepositoriesRepo = (
  sanitizeRepoUrl: boolean
): string[] => {
  const gitConfigPath = findFiles('.git/config')[0];
  if (!gitConfigPath) {
    return [];
  }
  const gitConfig = readFile(gitConfigPath);
  const repoUrl = /\[remote.?["']origin["']\]\n\s*url\s?=\s?(?<url>.*)/.exec(
    gitConfig
  )?.groups?.url;
  if (repoUrl && repoUrl.length) {
    return [sanitizeRepositoryUrl(repoUrl, sanitizeRepoUrl)];
  } else {
    return [];
  }
};

export const findProjectNameCustomProjectResolver = (
  customProjectResolver: CustomProjectResolver
): string[] => {
  return Array.from(
    new Set(
      findFiles(
        customProjectResolver.filePattern,
        PROJECT_INFO_TASK_PATTERN_FLAGS,
        PROJECT_INFO_TASK_EXCLUDE_PATTERN,
        PROJECT_INFO_TASK_PATTERN_FLAGS
      )
    )
  )
    .map((f) => readFile(f))
    .map(
      (content) =>
        new RegExp(customProjectResolver.projectNamePattern, 'i').exec(content)
          ?.groups?.projectName!
    )
    .filter(Boolean);
};

export async function resolveProjectInfo(
  customProjectResolvers: CustomProjectResolver[] = []
): Promise<ProjectInfo> {
  const rootPackageJson = readJson('package.json');
  if (rootPackageJson?.name) {
    return addRepositoryInfo(
      {
        type: ProjectType.NPM,
        name: rootPackageJson.name,
        names: [rootPackageJson.name],
      },
      { includeMavenRepositories: false }
    );
  }

  let names: string[] = [];
  let info: ProjectInfo | undefined;

  if (customProjectResolvers?.length) {
    for (let resolver of customProjectResolvers) {
      names = findProjectNameCustomProjectResolver(resolver);
      if (names.length) {
        info = {
          type: resolver.type,
          name: names[0],
          names,
        };
        break;
      }
    }
  }

  if (!names.length) {
    if (isNpmWorkspace()) {
      names = findProjectNamesNpm();
      info = {
        type: ProjectType.NPM,
        name: names[0],
        names,
      };
    } else if (isMavenWorkspace()) {
      names = findProjectNamesMaven();
      info = {
        type: ProjectType.MAVEN,
        name: names[0],
        names,
      };
    } else if (isPipWorkspace()) {
      names = findProjectNamesPip();
      info = {
        type: ProjectType.PIP,
        name: names[0],
        names,
      };
    } else {
      names = findProjectNamesRepo();
      info = {
        type: ProjectType.REPO,
        name: names[0],
        names,
      };
    }
  }

  if (!names.length || !info?.name) {
    throw new Error('No project name could be resolved for current workspace');
  }

  return addRepositoryInfo(info, { includeMavenRepositories: true });
}

async function addRepositoryInfo(
  info: ProjectInfo,
  options: { includeMavenRepositories: boolean }
): Promise<ProjectInfo> {
  const rootPackageJson = readJson('package.json');
  const repos = findProjectRepositoriesRepoRoot(true);
  const reposNpm = rootPackageJson?.repository?.url
    ? [sanitizeRepositoryUrl(rootPackageJson.repository.url, true)]
    : [];
  const reposMaven = options.includeMavenRepositories
    ? findProjectRepositoriesMaven(true)
    : [];
  const repositories = Array.from(
    new Set([...repos, ...reposNpm, ...reposMaven])
  );
  const branch = await getCurrentBranch();

  return {
    ...info,
    branch,
    repository: repositories[0],
    repositories,
  };
}

function findProjectRepositoriesRepoRoot(sanitizeRepoUrl: boolean): string[] {
  const gitConfigPath = '.git/config';
  if (!fileExists(gitConfigPath)) {
    return [];
  }

  const gitConfig = readFile(gitConfigPath);
  const repoUrl = /\[remote.?["']origin["']\]\n\s*url\s?=\s?(?<url>.*)/.exec(
    gitConfig
  )?.groups?.url;

  return repoUrl ? [sanitizeRepositoryUrl(repoUrl, sanitizeRepoUrl)] : [];
}

function findPackageJsonFiles() {
  return findFiles(
    'package.json',
    'i',
    PROJECT_INFO_TASK_EXCLUDE_PATTERN,
    PROJECT_INFO_TASK_PATTERN_FLAGS
  );
}

function findPomXmlFiles() {
  return findFiles('pom.xml', 'i', '.teamcity');
}

function findSetupPyFiles() {
  return findFiles(
    'setup.py',
    'i',
    PROJECT_INFO_TASK_EXCLUDE_PATTERN,
    PROJECT_INFO_TASK_PATTERN_FLAGS
  );
}

function sanitizeRepositoryUrl(rawUrl: string, sanitizeRepoUrl: boolean) {
  let sanitizedUrl = rawUrl
    .replace(/^scm:.*?:/gi, '')
    .replace('git+', '')
    .replace('git@', 'https://')
    .replace(/(?<!https?):/gi, '/');

  if (sanitizeRepoUrl && sanitizedUrl.includes('@')) {
    const [, url] = sanitizedUrl.split('@');
    let [domainName, ...path] = url.split('/');
    if (domainName.includes('gitlab')) {
      domainName = 'gitlab.com';
    }
    if (domainName.includes('github')) {
      domainName = 'github.com';
    }
    return `https://${domainName}/${path.join('/')}`;
  }

  return sanitizedUrl;
}
