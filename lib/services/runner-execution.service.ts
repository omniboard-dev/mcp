import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  RepositoryAccess,
  RunnerExecution,
  RunnerExecutionPhase,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';

const LEASE_RENEWAL_INTERVAL_MS = 60_000;
const RUNNER_EXECUTION_LEASE_CONFLICT_MESSAGE =
  'Runner execution is leased by another MCP CLI process';
const leaseOwner = `${os.hostname().slice(0, 48)}:${
  process.pid
}:${randomUUID()}`;

interface ActiveLease {
  executionKey: string;
  identity: string;
  token: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const activeLeases = new Map<string, ActiveLease>();
const executionKeysByIdentity = new Map<string, string>();

export interface AcquireRunnerExecutionInput {
  runKey: string;
  projectName: string;
  repositoryUrl: string;
  sourceControlProvider: RepositoryAccess['provider'];
  sourceControlRepositoryId: string;
  branch: string;
  commitMessage?: string | null;
}

export class RunnerExecutionLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerExecutionLeaseConflictError';
  }
}

export async function acquireRunnerExecution(
  input: AcquireRunnerExecutionInput
): Promise<RunnerExecution> {
  const identity = executionIdentity(input.runKey, input.projectName);
  const currentExecutionKey = executionKeysByIdentity.get(identity);
  const currentLease = currentExecutionKey
    ? getActiveLease(currentExecutionKey)
    : undefined;
  const response = await api
    .acquireRunnerExecution({
      ...input,
      leaseOwner,
      ...(currentLease ? { leaseToken: currentLease.token } : {}),
    })
    .catch((error: unknown) => {
      if (!isRunnerExecutionLeaseConflict(error)) throw error;
      if (currentExecutionKey) forgetLease(currentExecutionKey);
      throw new RunnerExecutionLeaseConflictError(error.message);
    });
  registerLease(
    identity,
    response.execution.executionKey,
    response.leaseToken,
    response.execution.leaseExpiresAt
  );
  return response.execution;
}

export async function checkpointRunnerExecution(
  execution: RunnerExecution,
  patch: {
    phase: RunnerExecutionPhase;
    targetBranch?: string | null;
    commitMessage?: string | null;
    preparedHeadSha?: string | null;
    commitSha?: string | null;
    recovery?: RunnerWorkspaceState['recovery'] | null;
  }
): Promise<RunnerExecution> {
  return api.checkpointRunnerExecution(execution.executionKey, {
    leaseToken: requireLease(execution.executionKey).token,
    expectedStateVersion: execution.stateVersion,
    ...patch,
  });
}

export async function reinitializeRunnerExecution(
  execution: RunnerExecution
): Promise<RunnerExecution> {
  return api.reinitializeRunnerExecution(execution.executionKey, {
    leaseToken: requireLease(execution.executionKey).token,
    expectedStateVersion: execution.stateVersion,
  });
}

export async function writeRunnerState(
  state: RunnerWorkspaceState,
  phase = inferWorkspacePhase(state)
): Promise<void> {
  const execution = await api.checkpointRunnerExecution(state.executionKey, {
    leaseToken: requireLease(state.executionKey).token,
    expectedStateVersion: state.stateVersion,
    phase,
    targetBranch: state.targetBranch,
    commitMessage: state.commitMessage ?? null,
    preparedHeadSha: state.preparedHeadSha,
    commitSha: state.commitSha ?? null,
    recovery: state.recovery ?? null,
  });
  applyExecutionToWorkspace(state, execution);
}

export async function completeRunnerExecutionByIdentity(
  runKey: string,
  projectName: string,
  phase: 'completed' | 'abandoned'
) {
  const executionKey = executionKeysByIdentity.get(
    executionIdentity(runKey, projectName)
  );
  try {
    return await api.completeRunnerExecutionByIdentity({
      runKey,
      projectName,
      phase,
    });
  } finally {
    if (executionKey) forgetLease(executionKey);
  }
}

export async function completeRunnerState(
  state: RunnerWorkspaceState,
  phase: 'completed' | 'abandoned' = 'completed'
): Promise<void> {
  const lease = requireLease(state.executionKey);
  const execution = await api.completeRunnerExecution(state.executionKey, {
    leaseToken: lease.token,
    expectedStateVersion: state.stateVersion,
    phase,
  });
  applyExecutionToWorkspace(state, execution);
  forgetLease(state.executionKey);
}

export async function releaseRunnerExecution(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (!lease) return;
  try {
    await api.releaseRunnerExecution(executionKey, lease.token);
  } finally {
    forgetLease(executionKey);
  }
}

export interface ReleaseRunnerExecutionResult {
  runKey: string;
  projectName: string;
  executionKey: string | null;
  released: boolean;
}

export async function releaseRunnerExecutionByIdentity(
  runKey: string,
  projectName: string
): Promise<ReleaseRunnerExecutionResult> {
  const executionKey = executionKeysByIdentity.get(
    executionIdentity(runKey, projectName)
  );
  if (!executionKey || !getActiveLease(executionKey)) {
    return { runKey, projectName, executionKey: null, released: false };
  }

  await releaseRunnerExecution(executionKey);
  return { runKey, projectName, executionKey, released: true };
}

export function hasActiveRunnerExecutionLease(
  runKey: string,
  projectName: string
) {
  const executionKey = executionKeysByIdentity.get(
    executionIdentity(runKey, projectName)
  );
  return executionKey ? Boolean(getActiveLease(executionKey)) : false;
}

export function createRunnerWorkspaceState(
  execution: RunnerExecution,
  localPath: string,
  access: RepositoryAccess
): RunnerWorkspaceState {
  if (!execution.targetBranch || !execution.preparedHeadSha) {
    throw new Error(
      `Runner execution "${execution.executionKey}" has not completed workspace preparation.`
    );
  }
  if (execution.sourceControlProvider !== access.provider) {
    throw new Error(
      'Runner execution provider no longer matches repository access.'
    );
  }

  return {
    executionKey: execution.executionKey,
    generation: execution.generation,
    stateVersion: execution.stateVersion,
    phase: execution.phase,
    runKey: execution.runKey,
    checkName: execution.checkName,
    projectName: execution.projectName,
    repositoryUrl: execution.repositoryUrl,
    localPath,
    branch: execution.branch,
    commitMessage: execution.commitMessage ?? undefined,
    targetBranch: execution.targetBranch,
    projectPath: execution.sourceControlRepositoryId,
    preparedHeadSha: execution.preparedHeadSha,
    commitSha: execution.commitSha ?? undefined,
    provider: execution.sourceControlProvider,
    apiBaseUrl: access.apiBaseUrl,
    recovery: execution.recovery ?? undefined,
  };
}

function inferWorkspacePhase(
  state: RunnerWorkspaceState
): RunnerExecutionPhase {
  if (state.recovery?.phase === 'conflicts') return 'recovery_conflicts';
  if (state.recovery?.phase === 'ready_to_push') {
    return 'recovery_ready_to_push';
  }
  if (state.commitSha) return 'committed';
  return 'prepared';
}

function applyExecutionToWorkspace(
  state: RunnerWorkspaceState,
  execution: RunnerExecution
) {
  state.generation = execution.generation;
  state.stateVersion = execution.stateVersion;
  state.phase = execution.phase;
  state.targetBranch = execution.targetBranch ?? state.targetBranch;
  state.commitMessage = execution.commitMessage ?? undefined;
  state.preparedHeadSha = execution.preparedHeadSha ?? state.preparedHeadSha;
  state.commitSha = execution.commitSha ?? undefined;
  state.recovery = execution.recovery ?? undefined;
}

function registerLease(
  identity: string,
  executionKey: string,
  token: string,
  leaseExpiresAt: string | null
) {
  const expiresAt = parseLeaseExpiry(leaseExpiresAt);
  const existing = activeLeases.get(executionKey);
  if (existing) clearInterval(existing.timer);

  const timer = setInterval(() => {
    void renewLease(executionKey);
  }, LEASE_RENEWAL_INTERVAL_MS);
  timer.unref();

  activeLeases.set(executionKey, {
    executionKey,
    identity,
    token,
    expiresAt,
    timer,
  });
  executionKeysByIdentity.set(identity, executionKey);
}

function requireLease(executionKey: string) {
  const lease = getActiveLease(executionKey);
  if (!lease) {
    throw new Error(
      `Runner execution "${executionKey}" is not leased by this MCP CLI process.`
    );
  }
  return lease;
}

async function renewLease(executionKey: string) {
  const lease = getActiveLease(executionKey);
  if (!lease) return;

  try {
    const response = await api.renewRunnerExecution(executionKey, lease.token);
    if (activeLeases.get(executionKey) !== lease) return;
    lease.token = response.leaseToken;
    lease.expiresAt = parseLeaseExpiry(response.execution.leaseExpiresAt);
  } catch (error) {
    if (activeLeases.get(executionKey) !== lease) return;
    if (isDefinitiveLeaseRejection(error) || Date.now() >= lease.expiresAt) {
      forgetLease(executionKey);
    }
  }
}

function getActiveLease(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (lease && Date.now() >= lease.expiresAt) {
    forgetLease(executionKey);
    return undefined;
  }
  return lease;
}

function parseLeaseExpiry(value: string | null) {
  const expiresAt = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(expiresAt)) {
    throw new Error('Runner execution lease response has no valid expiry.');
  }
  return expiresAt;
}

function isDefinitiveLeaseRejection(error: unknown) {
  return (
    error instanceof api.OmniboardApiError &&
    (error.status === 404 || error.status === 409)
  );
}

function isRunnerExecutionLeaseConflict(
  error: unknown
): error is api.OmniboardApiError {
  return (
    error instanceof api.OmniboardApiError &&
    error.status === 409 &&
    error.message.includes(RUNNER_EXECUTION_LEASE_CONFLICT_MESSAGE)
  );
}

function forgetLease(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (!lease) return;
  clearInterval(lease.timer);
  activeLeases.delete(executionKey);
  if (executionKeysByIdentity.get(lease.identity) === executionKey) {
    executionKeysByIdentity.delete(lease.identity);
  }
}

function executionIdentity(runKey: string, projectName: string) {
  return JSON.stringify([runKey, projectName]);
}
