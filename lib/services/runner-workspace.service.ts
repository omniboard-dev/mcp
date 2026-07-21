import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgenticRunContinuationDecision,
  AgenticRunProjectState,
  AgenticRunSummary,
  McpRepositoryAccess,
  RunnerWorkspaceFinalizeResult,
  RunnerWorkspacePrepareResult,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import {
  getRunnerAgenticRun,
  listAgenticRunProjects,
  reportRunnerAgenticRunProgressSafely,
  resolveAgenticRunContinuation,
} from './agentic-runs.service.js';
import {
  checkoutRemoteBranch,
  cloneRepository,
  commitAll,
  createBranch,
  fastForwardBranch,
  fetchBranch,
  getCurrentBranch,
  getDefaultBranch,
  getEffectiveRepositoryUrl,
  getHeadCommit,
  getGitNetworkEnvironment,
  getRemoteBranchCommit,
  getRepositoryPaths,
  getWorkingTreeStatus,
  isAncestor,
  pushBranch,
} from './git.service.js';
import {
  createChangeRequest,
  providerLabel,
  resolveGitUsername,
  validateRepositoryAccess,
} from './source-control.service.js';
import {
  isLocalTransportAllowed,
  isLoopbackHostname,
} from './url-security.service.js';

const RUNNER_ROOT = path.join('.omniboard', 'mcp');
const RUNNER_WORKSPACES_DIRECTORY = 'workspaces';
const RUNNER_STATE_DIRECTORY = 'state';
const RUNNER_GITIGNORE_ENTRIES = ['workspaces/', 'state/'];
const DEFAULT_AUTHOR_NAME = 'Omniboard Agent';
const DEFAULT_AUTHOR_EMAIL = 'agent@omniboard.dev';
const RUNNER_STATE_VERSION = 2;
const workspacePreparations = new Map<
  string,
  {
    options: PrepareRunnerWorkspaceOptions;
    result: Promise<RunnerWorkspacePrepareResult>;
  }
>();

interface RunnerWorkspaceStateEnvelope {
  version: typeof RUNNER_STATE_VERSION;
  state: RunnerWorkspaceState;
  signature: string;
}

export interface PrepareRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  repositoryUrl?: string;
  branch?: string;
}

export interface FinalizeRunnerWorkspaceOptions {
  runKey: string;
  projectName: string;
  localPath: string;
  commitMessage?: string;
  mergeRequestTitle?: string;
  mergeRequestDescription?: string;
  authorName?: string;
  authorEmail?: string;
}

export function prepareRunnerWorkspace(
  options: PrepareRunnerWorkspaceOptions
): Promise<RunnerWorkspacePrepareResult> {
  const preparationKey = JSON.stringify([options.runKey, options.projectName]);
  const existingPreparation = workspacePreparations.get(preparationKey);
  if (existingPreparation) {
    if (!hasMatchingPreparationOptions(existingPreparation.options, options)) {
      return Promise.reject(
        new Error(
          'Runner workspace preparation is already in progress for run "' +
            options.runKey +
            '" and project "' +
            options.projectName +
            '" with different repository or branch options.'
        )
      );
    }
    return existingPreparation.result;
  }

  const preparation = prepareRunnerWorkspaceInternal(options).finally(() =>
    workspacePreparations.delete(preparationKey)
  );
  workspacePreparations.set(preparationKey, {
    options: { ...options },
    result: preparation,
  });
  return preparation;
}

function hasMatchingPreparationOptions(
  left: PrepareRunnerWorkspaceOptions,
  right: PrepareRunnerWorkspaceOptions
) {
  return (
    left.repositoryUrl === right.repositoryUrl && left.branch === right.branch
  );
}

async function prepareRunnerWorkspaceInternal({
  runKey,
  projectName,
  repositoryUrl,
  branch,
}: PrepareRunnerWorkspaceOptions): Promise<RunnerWorkspacePrepareResult> {
  let resolvedRepositoryUrl = repositoryUrl;
  let localPath: string | undefined;
  let createdWorkspace = false;

  try {
    const projectState = await api.refreshAgenticRunProjectState(
      runKey,
      projectName
    );
    const continuation = await resolveAgenticRunContinuation(projectState);
    if (continuation.action !== 'continue') {
      return createNonContinuablePreparation(projectState, continuation);
    }

    const discovery = await listAgenticRunProjects({ runKey });
    const project = discovery.projects.find(
      (item) => item.name === projectName
    );
    if (!project) {
      throw new Error(
        'Project "' +
          projectName +
          '" does not currently match run "' +
          runKey +
          '".'
      );
    }

    const runResponse = await getRunnerAgenticRun(projectName, runKey);
    const existingWorkspace = await findRunnerWorkspace(runKey, projectName);

    const resolvedGitValues = resolveRunnerGitValues(runResponse.run, {
      branch: branch ?? projectState.progress.branch ?? undefined,
    });
    resolvedRepositoryUrl = resolveProjectRepositoryUrl(project, repositoryUrl);

    const access = await api.getRepositoryAccess(resolvedRepositoryUrl);
    const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
      resolvedRepositoryUrl,
      process.cwd()
    );
    assertAuthorizedRepositoryUrl(
      access,
      resolvedRepositoryUrl,
      effectiveRepositoryUrl
    );
    const repository = await validateRepositoryAccess(
      access,
      effectiveRepositoryUrl
    );

    let state: RunnerWorkspaceState;
    let resumed = false;
    if (existingWorkspace) {
      state = existingWorkspace.state;
      localPath = existingWorkspace.localPath;
      assertWorkspaceIdentity(state, runKey, projectName, localPath);
      if (state.branch !== resolvedGitValues.branchName) {
        throw new Error(
          'Retained runner workspace branch "' +
            state.branch +
            '" does not match resolved branch "' +
            resolvedGitValues.branchName +
            '".'
        );
      }
      if (
        repositoryIdentity(state.repositoryUrl) !==
          repositoryIdentity(resolvedRepositoryUrl) ||
        state.projectPath !== repository.repositoryId
      ) {
        throw new Error(
          'Retained runner workspace repository identity no longer matches the project.'
        );
      }
      await reconcileRunnerWorkspace(
        state,
        localPath,
        effectiveRepositoryUrl,
        access,
        projectState
      );
      resumed = true;
    } else {
      const layout = await ensureRunnerLayout();
      localPath = await fs.mkdtemp(
        path.join(layout.workspaces, slug(projectName) + '-')
      );
      createdWorkspace = true;
      localPath = await fs.realpath(localPath);
      await withGitCredentials(access, localPath, (env) =>
        cloneRepository(
          effectiveRepositoryUrl,
          localPath!,
          path.dirname(localPath!),
          env
        )
      );
      await assertGitWorkspaceIdentity(localPath);
      const targetBranch = await getDefaultBranch(localPath);
      const remoteBranchCommit = await getRemoteBranchCommit(
        resolvedGitValues.branchName,
        localPath
      );
      if (remoteBranchCommit) {
        await checkoutRemoteBranch(resolvedGitValues.branchName, localPath);
        resumed = true;
      } else {
        await createBranch(resolvedGitValues.branchName, localPath);
      }
      const preparedHeadSha = (await getHeadCommit(localPath)).sha;

      state = {
        runKey,
        checkName: runResponse.run.checkName,
        projectName,
        repositoryUrl: resolvedRepositoryUrl,
        localPath,
        branch: resolvedGitValues.branchName,
        commitMessage: resolvedGitValues.commitMessage,
        targetBranch,
        projectPath: repository.repositoryId,
        preparedHeadSha,
        provider: access.provider,
        apiBaseUrl: access.apiBaseUrl,
      };
      await writeRunnerState(state);
    }

    const progressReport = await reportRunnerAgenticRunProgressSafely(
      runKey,
      projectName,
      {
        status: 'in_progress',
        repositoryUrl: resolvedRepositoryUrl,
        localPath: state.localPath,
        branch: state.branch,
        notes: resumed
          ? 'Continued dedicated runner workspace for "' + projectName + '".'
          : 'Prepared dedicated runner workspace for "' + projectName + '".',
        metadata: {
          mcpTool: 'omniboard_runner_prepare_agentic_run_workspace',
          targetBranch: state.targetBranch,
          resumed,
        },
      }
    );

    return {
      run: runResponse.run,
      project,
      result: runResponse.result,
      projectState,
      continuation,
      workspace: state,
      prompt: runResponse.run.prompt ?? null,
      instructions: createWorkspaceInstructions(
        runKey,
        projectName,
        state,
        continuation
      ),
      progressReport,
    };
  } catch (error) {
    let cleanupError: unknown;
    if (localPath && createdWorkspace) {
      try {
        await fs.rm(localPath, { recursive: true, force: true });
        localPath = undefined;
      } catch (caught) {
        cleanupError = caught;
      }
    }

    const failureMessage = cleanupError
      ? toErrorMessage(error) +
        ' Cleanup also failed: ' +
        toErrorMessage(cleanupError)
      : toErrorMessage(error);
    await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
      status: 'failed',
      repositoryUrl: resolvedRepositoryUrl ?? null,
      localPath,
      error: failureMessage,
      notes: 'Dedicated runner workspace preparation failed.',
      metadata: {
        mcpTool: 'omniboard_runner_prepare_agentic_run_workspace',
      },
    });
    throw error;
  }
}

export async function finalizeRunnerWorkspace({
  runKey,
  projectName,
  localPath: requestedLocalPath,
  commitMessage,
  mergeRequestTitle,
  mergeRequestDescription,
  authorName = DEFAULT_AUTHOR_NAME,
  authorEmail = DEFAULT_AUTHOR_EMAIL,
}: FinalizeRunnerWorkspaceOptions): Promise<RunnerWorkspaceFinalizeResult> {
  const { state, localPath } = await readRunnerState(requestedLocalPath);
  assertWorkspaceIdentity(state, runKey, projectName, localPath);
  const projectState = await api.refreshAgenticRunProjectState(
    runKey,
    projectName
  );
  const continuation = await resolveAgenticRunContinuation(projectState);
  if (continuation.action !== 'continue') {
    throw new Error(
      `Runner workspace finalization is not permitted while the continuation decision is "${
        continuation.action
      }" (${continuation.reason}). ${continuation.instructions.join(' ')}`
    );
  }
  assertFinalizationProjectStateMatchesWorkspace(state, projectState);

  const resolvedCommitMessage =
    normalizeNonEmptyString(commitMessage) ??
    state.commitMessage ??
    defaultCommitMessage(runKey);
  state.commitMessage = resolvedCommitMessage;
  const progressReports = [];

  try {
    await assertGitWorkspaceIdentity(localPath);
    await assertCurrentRunnerBranch(state, localPath);
    const status = await getWorkingTreeStatus(localPath);
    const commitSha = status
      ? await createRunnerCommit(
          state,
          localPath,
          resolvedCommitMessage,
          authorName,
          authorEmail
        )
      : await resolveExistingRunnerCommit(
          state,
          localPath,
          resolvedCommitMessage
        );
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'committed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        notes: resolvedCommitMessage,
      })
    );

    const access = await api.getRepositoryAccess(state.repositoryUrl);
    const effectiveRepositoryUrl = await getEffectiveRepositoryUrl(
      state.repositoryUrl,
      localPath
    );
    assertAuthorizedRepositoryUrl(
      access,
      state.repositoryUrl,
      effectiveRepositoryUrl
    );
    const repository = await validateRepositoryAccess(
      access,
      effectiveRepositoryUrl
    );
    if (repository.repositoryId !== state.projectPath) {
      throw new Error(
        `${providerLabel(access)} ${
          access.provider === 'gitlab' ? 'project' : 'repository'
        } identity changed from "${state.projectPath}" to "${
          repository.repositoryId
        }".`
      );
    }
    await withGitCredentials(access, localPath, (env) =>
      pushBranch(effectiveRepositoryUrl, state.branch, localPath, env)
    );
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'pushed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        notes: `Pushed branch "${state.branch}".`,
      })
    );

    const mergeRequest = await createChangeRequest(
      access,
      state.projectPath,
      state.branch,
      state.targetBranch,
      mergeRequestTitle ?? resolvedCommitMessage,
      mergeRequestDescription ??
        `Automated change for Omniboard agentic run ${runKey}.`
    );
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'mr_created',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        commitSha,
        mergeRequestUrl: mergeRequest.url,
        mergeRequestState: mergeRequest.state,
        notes: `Created merge request: ${mergeRequest.title}`,
        metadata: {
          mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
          mergeRequestIid: mergeRequest.iid ?? null,
          targetBranch: state.targetBranch,
        },
      })
    );

    return {
      workspace: state,
      commitSha,
      mergeRequest,
      progressReports,
    };
  } catch (error) {
    progressReports.push(
      await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'failed',
        repositoryUrl: state.repositoryUrl,
        localPath,
        branch: state.branch,
        error: error instanceof Error ? error.message : String(error),
        notes: 'Dedicated runner finalization failed.',
        metadata: {
          mcpTool: 'omniboard_runner_finalize_agentic_run_workspace',
        },
      })
    );
    throw error;
  }
}

function assertFinalizationProjectStateMatchesWorkspace(
  state: RunnerWorkspaceState,
  projectState: AgenticRunProjectState
) {
  if (
    projectState.run.runKey !== state.runKey ||
    projectState.project.name !== state.projectName
  ) {
    throw new Error(
      'Refreshed run and project identity does not match the runner workspace.'
    );
  }
  if (
    projectState.progress.branch &&
    projectState.progress.branch !== state.branch
  ) {
    throw new Error(
      'Refreshed provider branch "' +
        projectState.progress.branch +
        '" does not match runner workspace branch "' +
        state.branch +
        '".'
    );
  }

  const repositoryUrls = [
    projectState.project.repositoryUrl,
    ...(projectState.project.repositoryUrls ?? []),
  ].filter((value): value is string => Boolean(value));
  if (
    repositoryUrls.length > 0 &&
    !repositoryUrls.some(
      (repositoryUrl) =>
        repositoryIdentity(repositoryUrl) ===
        repositoryIdentity(state.repositoryUrl)
    )
  ) {
    throw new Error(
      'Refreshed project repository does not match the runner workspace repository.'
    );
  }
}

function createNonContinuablePreparation(
  projectState: AgenticRunProjectState,
  continuation: AgenticRunContinuationDecision
): RunnerWorkspacePrepareResult {
  return {
    run: projectState.run,
    project: {
      id: projectState.project.id,
      name: projectState.project.name,
      repositoryUrl: projectState.project.repositoryUrl,
      repositoryUrls: projectState.project.repositoryUrls,
    },
    projectState,
    continuation,
    prompt: projectState.run.prompt ?? null,
    instructions: continuation.instructions,
  };
}

function createWorkspaceInstructions(
  runKey: string,
  projectName: string,
  state: RunnerWorkspaceState,
  continuation: AgenticRunContinuationDecision
) {
  return [
    'Work only inside ' + state.localPath + '.',
    'Use the returned prompt and check result as the source of truth.',
    ...continuation.instructions,
    'Inspect the existing branch and implement the smallest coherent change that resolves the check or provider failure.',
    'Run relevant tests, lint, or build commands before finalizing.',
    'When ready, call omniboard_runner_finalize_agentic_run_workspace with runKey "' +
      runKey +
      '", projectName "' +
      projectName +
      '", and localPath "' +
      state.localPath +
      '". The prepared commit message is "' +
      (state.commitMessage ?? defaultCommitMessage(runKey)) +
      '".',
  ];
}

async function findRunnerWorkspace(runKey: string, projectName: string) {
  const root = path.resolve(process.cwd(), RUNNER_ROOT);
  const workspaces = path.join(root, RUNNER_WORKSPACES_DIRECTORY);
  const stateDirectory = path.join(root, RUNNER_STATE_DIRECTORY);
  let entries;
  try {
    entries = await fs.readdir(stateDirectory, { withFileTypes: true });
    await Promise.all([
      assertRealDirectory(root),
      assertRealDirectory(workspaces),
      assertRealDirectory(stateDirectory),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const candidates: Array<{
    state: RunnerWorkspaceState;
    localPath: string;
    modifiedAt: number;
  }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const stateFile = path.join(stateDirectory, entry.name);
    try {
      const [serialized, stats] = await Promise.all([
        fs.readFile(stateFile, 'utf8'),
        fs.stat(stateFile),
      ]);
      const envelope = JSON.parse(serialized) as unknown;
      assertRunnerStateEnvelope(envelope);
      if (
        envelope.state.runKey !== runKey ||
        envelope.state.projectName !== projectName
      ) {
        continue;
      }
      const localPath = await assertRunnerWorkspacePath(
        workspaces,
        envelope.state.localPath
      );
      candidates.push({
        state: envelope.state,
        localPath,
        modifiedAt: stats.mtimeMs,
      });
    } catch {
      // Invalid, deleted, or unauthenticated state is never reused.
    }
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0] ?? null;
}

async function reconcileRunnerWorkspace(
  state: RunnerWorkspaceState,
  localPath: string,
  repositoryUrl: string,
  access: McpRepositoryAccess,
  projectState: AgenticRunProjectState
) {
  await assertGitWorkspaceIdentity(localPath);
  await assertCurrentRunnerBranch(state, localPath);
  if (
    projectState.progress.branch &&
    projectState.progress.branch !== state.branch
  ) {
    throw new Error(
      'Provider branch "' +
        projectState.progress.branch +
        '" does not match retained workspace branch "' +
        state.branch +
        '".'
    );
  }

  const workingTreeStatus = await getWorkingTreeStatus(localPath);
  let head = await getHeadCommit(localPath);
  try {
    await withGitCredentials(access, localPath, (env) =>
      fetchBranch(repositoryUrl, state.branch, localPath, env)
    );
  } catch (error) {
    if (projectState.progress.mergeRequestUrl) {
      throw new Error(
        'Unable to refresh the existing provider branch: ' +
          toErrorMessage(error)
      );
    }
  }

  const remoteCommit = await getRemoteBranchCommit(state.branch, localPath);
  const hasVerifiedLocalHead =
    head.sha === state.preparedHeadSha || head.sha === state.commitSha;
  if (!remoteCommit && !hasVerifiedLocalHead) {
    throw new Error(
      'The retained workspace contains an unverified local commit.'
    );
  }
  if (remoteCommit && remoteCommit !== head.sha) {
    if (await isAncestor(head.sha, remoteCommit, localPath)) {
      if (workingTreeStatus) {
        throw new Error(
          'The remote branch advanced while the retained workspace has local changes.'
        );
      }
      await fastForwardBranch(state.branch, localPath);
      head = await getHeadCommit(localPath);
    } else if (await isAncestor(remoteCommit, head.sha, localPath)) {
      if (!hasVerifiedLocalHead) {
        throw new Error(
          'The retained workspace contains an unverified local commit.'
        );
      }
    } else {
      throw new Error(
        'The retained workspace and remote provider branch have diverged.'
      );
    }
  }

  state.preparedHeadSha = head.sha;
  state.commitSha = undefined;
  await writeRunnerState(state);
}

async function createRunnerCommit(
  state: RunnerWorkspaceState,
  localPath: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string
) {
  const head = await getHeadCommit(localPath);
  if (head.sha !== state.preparedHeadSha) {
    throw new Error(
      'Runner workspace HEAD changed before finalization; commit manually or prepare a new workspace.'
    );
  }

  const commitSha = await commitAll(
    commitMessage,
    localPath,
    authorName,
    authorEmail
  );
  state.commitSha = commitSha;
  await writeRunnerState(state);
  return commitSha;
}

async function resolveExistingRunnerCommit(
  state: RunnerWorkspaceState,
  localPath: string,
  commitMessage: string
) {
  const head = await getHeadCommit(localPath);
  if (
    head.sha === state.preparedHeadSha ||
    head.parentShas.length !== 1 ||
    head.parentShas[0] !== state.preparedHeadSha ||
    head.message !== commitMessage ||
    (state.commitSha && state.commitSha !== head.sha)
  ) {
    throw new Error(
      'Runner workspace has no verified runner commit to resume.'
    );
  }

  if (!state.commitSha) {
    state.commitSha = head.sha;
    await writeRunnerState(state);
  }
  return head.sha;
}

async function assertCurrentRunnerBranch(
  state: RunnerWorkspaceState,
  localPath: string
) {
  const currentBranch = await getCurrentBranch(localPath);
  if (currentBranch !== state.branch) {
    throw new Error(
      `Runner workspace is on branch "${currentBranch}", expected "${state.branch}".`
    );
  }
}

async function withGitCredentials<T>(
  access: McpRepositoryAccess,
  targetDir: string,
  action: (env: NodeJS.ProcessEnv) => Promise<T>
) {
  const askPassDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'omniboard-git-')
  );
  const askPassPath = path.join(
    askPassDirectory,
    process.platform === 'win32'
      ? 'omniboard-askpass.cmd'
      : 'omniboard-askpass.sh'
  );
  const username = resolveGitUsername(access);
  const script =
    process.platform === 'win32'
      ? [
          '@echo off',
          'echo %~1 | findstr /I "Username" >nul',
          'if %errorlevel%==0 (echo %OMNIBOARD_GIT_USERNAME%) else (echo %OMNIBOARD_GIT_TOKEN%)',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          'case "$1" in',
          '  *Username*) printf "%s\\n" "$OMNIBOARD_GIT_USERNAME" ;;',
          '  *) printf "%s\\n" "$OMNIBOARD_GIT_TOKEN" ;;',
          'esac',
          '',
        ].join('\n');

  await fs.writeFile(askPassPath, script, { mode: 0o700 });
  try {
    return await action({
      ...getGitNetworkEnvironment(),
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0',
      OMNIBOARD_GIT_TOKEN: access.token,
      OMNIBOARD_GIT_USERNAME: username,
    });
  } finally {
    await fs.rm(askPassDirectory, { recursive: true, force: true });
  }
}

async function ensureRunnerLayout() {
  const omniboardRoot = await ensureCanonicalDirectory(
    path.resolve(process.cwd(), path.dirname(RUNNER_ROOT))
  );
  const root = await ensureCanonicalDirectory(
    path.join(omniboardRoot, path.basename(RUNNER_ROOT))
  );
  const workspaces = await ensureCanonicalDirectory(
    path.join(root, RUNNER_WORKSPACES_DIRECTORY)
  );
  const state = await ensureCanonicalDirectory(
    path.join(root, RUNNER_STATE_DIRECTORY)
  );
  await ensureRunnerGitignore(path.join(root, '.gitignore'));
  return { root, workspaces, state };
}

async function ensureCanonicalDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  await assertRealDirectory(directory);
  const canonicalDirectory = await fs.realpath(directory);
  if (canonicalDirectory !== path.resolve(directory)) {
    throw new Error(
      `Runner directory "${directory}" must not resolve through a symlink.`
    );
  }
  return canonicalDirectory;
}

async function writeRunnerState(state: RunnerWorkspaceState) {
  const layout = await ensureRunnerLayout();
  const envelope: RunnerWorkspaceStateEnvelope = {
    version: RUNNER_STATE_VERSION,
    state,
    signature: signRunnerState(state),
  };
  await writeFileAtomically(
    statePath(layout.state, state.localPath),
    JSON.stringify(envelope, null, 2)
  );
}

async function readRunnerState(localPath: string) {
  const layout = await ensureRunnerLayout();
  const canonicalLocalPath = await assertRunnerWorkspacePath(
    layout.workspaces,
    localPath
  );
  let content: string;
  try {
    content = await fs.readFile(
      statePath(layout.state, canonicalLocalPath),
      'utf8'
    );
  } catch {
    throw new Error(
      `Runner workspace metadata was not found for "${localPath}".`
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    throw new Error('Runner workspace metadata has an invalid format.');
  }
  assertRunnerStateEnvelope(envelope);
  return { state: envelope.state, localPath: canonicalLocalPath };
}

function assertRunnerStateEnvelope(
  value: unknown
): asserts value is RunnerWorkspaceStateEnvelope {
  const envelope = value as Partial<RunnerWorkspaceStateEnvelope> | null;
  if (
    !envelope ||
    envelope.version !== RUNNER_STATE_VERSION ||
    !envelope.state ||
    typeof envelope.state !== 'object' ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('Runner workspace metadata has an invalid format.');
  }

  const expectedSignature = Buffer.from(signRunnerState(envelope.state), 'hex');
  const actualSignature = Buffer.from(envelope.signature, 'hex');
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error('Runner workspace metadata integrity validation failed.');
  }
}

function signRunnerState(state: RunnerWorkspaceState) {
  const key = process.env.OMNIBOARD_API_KEY_MCP;
  if (!key) {
    throw new Error(
      'OMNIBOARD_API_KEY_MCP is required to authenticate runner workspace metadata.'
    );
  }
  return createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
}

function statePath(stateDirectory: string, localPath: string) {
  return path.join(stateDirectory, `${path.basename(localPath)}.json`);
}

async function writeFileAtomically(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function assertRunnerWorkspacePath(
  workspaces: string,
  localPath: string
) {
  if (path.dirname(path.resolve(localPath)) !== path.resolve(workspaces)) {
    throw new Error(
      `Runner workspace "${localPath}" is outside "${workspaces}".`
    );
  }

  const stats = await fs.lstat(localPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Runner workspace "${localPath}" must not be a symlink.`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Runner workspace "${localPath}" is not a directory.`);
  }

  const canonicalLocalPath = await fs.realpath(localPath);
  if (path.dirname(canonicalLocalPath) !== (await fs.realpath(workspaces))) {
    throw new Error(
      `Runner workspace "${localPath}" resolves outside "${workspaces}".`
    );
  }
  return canonicalLocalPath;
}

function assertWorkspaceIdentity(
  state: RunnerWorkspaceState,
  runKey: string,
  projectName: string,
  localPath: string
) {
  if (
    state.runKey !== runKey ||
    state.projectName !== projectName ||
    path.resolve(state.localPath) !== path.resolve(localPath)
  ) {
    throw new Error('Runner workspace identity does not match the request.');
  }
}

async function assertGitWorkspaceIdentity(localPath: string) {
  const canonicalWorkspace = await fs.realpath(localPath);
  const repositoryPaths = await getRepositoryPaths(canonicalWorkspace);
  const topLevel = await fs.realpath(repositoryPaths.topLevel);
  if (topLevel !== canonicalWorkspace) {
    throw new Error(
      `Git worktree "${topLevel}" is outside runner workspace "${canonicalWorkspace}".`
    );
  }

  for (const [label, repositoryPath] of [
    ['Git directory', repositoryPaths.gitDirectory],
    ['Git common directory', repositoryPaths.commonDirectory],
  ] as const) {
    const canonicalRepositoryPath = await fs.realpath(repositoryPath);
    if (!isPathInside(canonicalWorkspace, canonicalRepositoryPath)) {
      throw new Error(
        `${label} "${canonicalRepositoryPath}" is outside runner workspace "${canonicalWorkspace}".`
      );
    }
  }
}

function isPathInside(parent: string, candidate: string) {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}

function resolveProjectRepositoryUrl(
  project: {
    repositoryUrl?: string | null;
    repositoryUrls?: string[];
  },
  requestedRepositoryUrl?: string
) {
  const availableRepositoryUrls = [
    project.repositoryUrl,
    ...(project.repositoryUrls ?? []),
  ].filter((value): value is string => Boolean(value));

  if (!availableRepositoryUrls.length) {
    throw new Error('The matched project does not expose a repository URL.');
  }
  if (!requestedRepositoryUrl) {
    const preferredRepositoryUrl = findPreferredRepositoryUrl(
      availableRepositoryUrls
    );
    if (!preferredRepositoryUrl) {
      throw new Error(
        'The matched project does not expose a secure HTTPS repository URL compatible with token authentication.'
      );
    }
    return preferredRepositoryUrl;
  }

  const requestedIdentity = repositoryIdentity(requestedRepositoryUrl);
  const matchingRepositoryUrls = availableRepositoryUrls.filter(
    (value) => repositoryIdentity(value) === requestedIdentity
  );
  const matchedRepositoryUrl =
    matchingRepositoryUrls.find(
      (value) =>
        value === requestedRepositoryUrl && isSecureRepositoryUrl(value)
    ) ?? findPreferredRepositoryUrl(matchingRepositoryUrls);
  if (!matchedRepositoryUrl) {
    throw new Error(
      matchingRepositoryUrls.length
        ? 'The requested repository does not expose a secure URL compatible with token authentication.'
        : 'The requested repository URL is not registered on the matched Omniboard project.'
    );
  }
  return matchedRepositoryUrl;
}

function findPreferredRepositoryUrl(repositoryUrls: string[]) {
  const httpsRepositoryUrl = repositoryUrls.find(
    (value) => repositoryProtocol(value) === 'https:'
  );
  if (httpsRepositoryUrl || !isLocalTransportAllowed()) {
    return httpsRepositoryUrl;
  }
  return (
    repositoryUrls.find(
      (value) =>
        repositoryProtocol(value) === 'http:' &&
        isLoopbackHostname(parseRepositoryUrl(value).hostname)
    ) ?? repositoryUrls.find((value) => repositoryProtocol(value) === 'file:')
  );
}

function isSecureRepositoryUrl(repositoryUrl: string) {
  const protocol = repositoryProtocol(repositoryUrl);
  return (
    protocol === 'https:' ||
    (isLocalTransportAllowed() &&
      (protocol === 'file:' ||
        (protocol === 'http:' &&
          isLoopbackHostname(parseRepositoryUrl(repositoryUrl).hostname))))
  );
}

function assertAuthorizedRepositoryUrl(
  access: McpRepositoryAccess,
  repositoryUrl: string,
  effectiveRepositoryUrl: string
) {
  if (
    repositoryIdentity(repositoryUrl) !==
    repositoryIdentity(effectiveRepositoryUrl)
  ) {
    throw new Error(
      'Git configuration rewrites the repository URL to a different repository.'
    );
  }

  const url = parseRepositoryUrl(effectiveRepositoryUrl);
  if (url.protocol === 'file:' && isLocalTransportAllowed()) {
    return;
  }
  if (
    url.protocol !== 'https:' &&
    !(
      isLocalTransportAllowed() &&
      url.protocol === 'http:' &&
      isLoopbackHostname(url.hostname)
    )
  ) {
    throw new Error(
      'Credentialed repository URLs must use HTTPS. Local file and loopback HTTP transports require OMNIBOARD_MCP_ALLOW_LOCAL_TRANSPORTS=true.'
    );
  }
  if (url.username || url.password) {
    throw new Error('Repository URLs must not contain embedded credentials.');
  }

  const accessHost = normalizeAccessHost(access.host);
  if (url.host.toLowerCase() !== accessHost) {
    throw new Error(
      `Repository host "${url.host}" does not match credential host "${access.host}".`
    );
  }
}

function repositoryProtocol(repositoryUrl: string) {
  try {
    return parseRepositoryUrl(repositoryUrl).protocol;
  } catch {
    return undefined;
  }
}

function parseRepositoryUrl(repositoryUrl: string) {
  if (!repositoryUrl.includes('://')) {
    throw new Error(
      `Repository URL "${repositoryUrl}" must use HTTP(S) for token authentication.`
    );
  }
  try {
    return new URL(repositoryUrl);
  } catch {
    throw new Error(`Invalid repository URL "${repositoryUrl}".`);
  }
}

function normalizeAccessHost(host: string) {
  try {
    return new URL(
      host.includes('://') ? host : `https://${host}`
    ).host.toLowerCase();
  } catch {
    throw new Error(`Invalid repository credential host "${host}".`);
  }
}

async function assertRealDirectory(directory: string) {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Runner directory "${directory}" must be a real directory.`
    );
  }
}

async function ensureRunnerGitignore(gitignorePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    try {
      await fs.writeFile(
        gitignorePath,
        `${RUNNER_GITIGNORE_ENTRIES.join('\n')}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      return;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw writeError;
      }
      return ensureRunnerGitignore(gitignorePath);
    }
  }

  const existingEntries = new Set(
    content.split(/\r?\n/).map((entry) => entry.trim())
  );
  const missingEntries = RUNNER_GITIGNORE_ENTRIES.filter(
    (entry) => !existingEntries.has(entry)
  );
  if (!missingEntries.length) {
    return;
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = !content || content.endsWith('\n') ? '' : newline;
  await fs.writeFile(
    gitignorePath,
    `${content}${separator}${missingEntries.join(newline)}${newline}`,
    'utf8'
  );
}

function repositoryIdentity(repositoryUrl: string) {
  if (repositoryUrl.includes('://')) {
    const url = new URL(repositoryUrl);
    return `${url.host.toLowerCase()}/${normalizeRepositoryPath(url.pathname)}`;
  }

  const match = /^(?:[^@]+@)?(?<host>[^:]+):(?<path>.+)$/.exec(
    repositoryUrl
  )?.groups;
  if (!match) {
    throw new Error(`Invalid repository URL "${repositoryUrl}".`);
  }
  return `${match.host.toLowerCase()}/${normalizeRepositoryPath(match.path)}`;
}

function normalizeRepositoryPath(value: string) {
  return value
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function resolveRunnerGitValues(
  run: AgenticRunSummary,
  options: { branch?: string } = {}
) {
  return {
    branchName:
      normalizeNonEmptyString(options.branch) ??
      normalizeNonEmptyString(run.branchName) ??
      extractPromptGitValue(run.prompt, 'branchName') ??
      `agentic/${slug(run.runKey)}-${Date.now().toString(36)}`,
    commitMessage:
      normalizeNonEmptyString(run.commitMessage) ??
      extractPromptGitValue(run.prompt, 'commitMessage') ??
      defaultCommitMessage(run.runKey),
  };
}

function extractPromptGitValue(
  prompt: string | null | undefined,
  type: 'branchName' | 'commitMessage'
) {
  const pattern =
    type === 'branchName'
      ? /^(?:branch(?:\s+name)?|git\s+branch)\s*:\s*(.+)$/i
      : /^(?:commit(?:\s+message)?|git\s+commit\s+message)\s*:\s*(.+)$/i;

  for (const line of prompt?.split(/\r?\n/) ?? []) {
    const normalizedLine = line
      .trim()
      .replace(/^(?:[-+*]\s+|#{1,6}\s*)/, '')
      .replace(/\*\*/g, '')
      .trim();
    const value = pattern.exec(normalizedLine)?.[1];
    const normalizedValue = normalizeNonEmptyString(value);
    if (normalizedValue) {
      const unwrappedValue = normalizeNonEmptyString(
        unwrapMarkdownValue(normalizedValue)
      );
      if (unwrappedValue) {
        return unwrappedValue;
      }
    }
  }

  return undefined;
}

function unwrapMarkdownValue(value: string) {
  for (const delimiter of ['`', '"', "'"]) {
    if (value.startsWith(delimiter) && value.endsWith(delimiter)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function normalizeNonEmptyString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function defaultCommitMessage(runKey: string) {
  return `chore: complete agentic run ${runKey}`;
}

function slug(value: string) {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return result || 'run';
}
