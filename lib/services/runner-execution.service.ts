import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  RepositoryAccess,
  RunnerExecution,
  RunnerExecutionPhase,
  RunnerWorkspaceState,
} from '../interface.js';
import * as api from './api.service.js';
import { removeRunnerWorkspaceNodeModules } from './runner-workspace-store.service.js';

const LEASE_RENEWAL_INTERVAL_MS = readPositiveDuration(
  process.env.OMNIBOARD_RUNNER_LEASE_RENEWAL_INTERVAL_MS,
  30_000
);
const WORK_HEARTBEAT_TIMEOUT_MS = readPositiveDuration(
  process.env.OMNIBOARD_RUNNER_WORK_HEARTBEAT_TIMEOUT_MS,
  15 * 60 * 1000
);
const EXECUTION_BUDGET_MS = readPositiveDuration(
  process.env.OMNIBOARD_RUNNER_EXECUTION_BUDGET_MS,
  60 * 60 * 1000
);
const RUNNER_EXECUTION_LEASE_CONFLICT_MESSAGE =
  'Runner execution is leased by another MCP CLI process';
const leaseOwner = `${os.hostname().slice(0, 48)}:${
  process.pid
}:${randomUUID()}`;

interface ActiveLease {
  executionKey: string;
  identity: string;
  runKey: string;
  projectName: string;
  token: string;
  expiresAt: number;
  acquiredAt: number;
  lastWorkActivityAt: number;
  renewalInFlight: boolean;
  timer: NodeJS.Timeout;
  localPath?: string;
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
      if (currentLease) {
        forgetLeaseAndCleanWorkspace(currentLease);
      } else if (currentExecutionKey) {
        forgetLease(currentExecutionKey);
      }
      throw new RunnerExecutionLeaseConflictError(error.message);
    });
  registerLease(
    identity,
    input.runKey,
    input.projectName,
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
  const updated = await api.checkpointRunnerExecution(execution.executionKey, {
    leaseToken: requireLease(execution.executionKey).token,
    expectedStateVersion: execution.stateVersion,
    ...patch,
  });
  markWorkActivity(execution.executionKey);
  return updated;
}

export async function reinitializeRunnerExecution(
  execution: RunnerExecution
): Promise<RunnerExecution> {
  const updated = await api.reinitializeRunnerExecution(
    execution.executionKey,
    {
      leaseToken: requireLease(execution.executionKey).token,
      expectedStateVersion: execution.stateVersion,
    }
  );
  markWorkActivity(execution.executionKey);
  return updated;
}

export async function registerRunnerWorkspace(
  executionKey: string,
  localPath: string
): Promise<void> {
  const lease = requireLease(executionKey);
  if (lease.localPath && lease.localPath !== localPath) {
    await removeRunnerWorkspaceNodeModules(lease.localPath);
  }
  lease.localPath = localPath;
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
  markWorkActivity(state.executionKey);
}

export async function completeRunnerExecutionByIdentity(
  runKey: string,
  projectName: string,
  phase: 'completed' | 'abandoned'
) {
  const executionKey = executionKeysByIdentity.get(
    executionIdentity(runKey, projectName)
  );
  const lease = executionKey ? activeLeases.get(executionKey) : undefined;
  const complete = () =>
    api.completeRunnerExecutionByIdentity({
      runKey,
      projectName,
      phase,
    });
  return lease
    ? finishRunnerLease(
        lease,
        complete,
        `Failed to complete runner execution ${runKey}/${projectName}.`
      )
    : complete();
}

export async function completeRunnerState(
  state: RunnerWorkspaceState,
  phase: 'completed' | 'abandoned' = 'completed'
): Promise<void> {
  const lease = requireLease(state.executionKey);
  const execution = await finishRunnerLease(
    lease,
    () =>
      api.completeRunnerExecution(state.executionKey, {
        leaseToken: lease.token,
        expectedStateVersion: state.stateVersion,
        phase,
      }),
    `Failed to complete runner execution "${state.executionKey}".`
  );
  applyExecutionToWorkspace(state, execution);
}

export async function releaseRunnerExecution(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (!lease) return;
  await finishRunnerLease(
    lease,
    () => api.releaseRunnerExecution(executionKey, lease.token),
    `Failed to release runner execution "${executionKey}".`
  );
}

export interface ReleaseRunnerExecutionResult {
  runKey: string;
  projectName: string;
  executionKey: string | null;
  released: boolean;
}

export async function releaseAllRunnerExecutions(): Promise<void> {
  const results = await Promise.allSettled(
    [...activeLeases.keys()].map((executionKey) =>
      releaseRunnerExecution(executionKey)
    )
  );
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Failed to release all runner executions.'
    );
  }
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

export interface RunnerExecutionHeartbeatResult {
  runKey: string;
  projectName: string;
  executionKey: string;
  heartbeatAt: string;
  workStaleAfter: string;
  executionBudgetEndsAt: string;
}

export function heartbeatRunnerExecution(
  runKey: string,
  projectName: string
): RunnerExecutionHeartbeatResult {
  const executionKey = executionKeysByIdentity.get(
    executionIdentity(runKey, projectName)
  );
  const lease = executionKey ? getActiveLease(executionKey) : undefined;
  if (!lease) {
    throw new Error(
      `Runner execution for "${runKey}/${projectName}" is not leased by this MCP CLI process.`
    );
  }
  const now = Date.now();
  lease.lastWorkActivityAt = now;
  return {
    runKey,
    projectName,
    executionKey: lease.executionKey,
    heartbeatAt: new Date(now).toISOString(),
    workStaleAfter: new Date(now + WORK_HEARTBEAT_TIMEOUT_MS).toISOString(),
    executionBudgetEndsAt: new Date(
      lease.acquiredAt + EXECUTION_BUDGET_MS
    ).toISOString(),
  };
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
  runKey: string,
  projectName: string,
  executionKey: string,
  token: string,
  leaseExpiresAt: string | null
) {
  const expiresAt = parseLeaseExpiry(leaseExpiresAt);
  const now = Date.now();
  const existing = activeLeases.get(executionKey);
  if (existing) clearInterval(existing.timer);

  const timer = setInterval(() => {
    void renewLease(executionKey);
  }, LEASE_RENEWAL_INTERVAL_MS);
  timer.unref();

  activeLeases.set(executionKey, {
    executionKey,
    identity,
    runKey,
    projectName,
    token,
    expiresAt,
    acquiredAt: existing?.acquiredAt ?? now,
    lastWorkActivityAt: now,
    renewalInFlight: false,
    timer,
    localPath: existing?.localPath,
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
  if (!lease || lease.renewalInFlight) return;

  const timeoutReason = getLeaseWatchdogTimeoutReason(lease);
  if (timeoutReason) {
    forgetLease(executionKey);
    void expireTimedOutLease(lease, timeoutReason);
    return;
  }

  lease.renewalInFlight = true;
  try {
    const response = await api.renewRunnerExecution(executionKey, lease.token);
    if (activeLeases.get(executionKey) !== lease) return;
    lease.token = response.leaseToken;
    lease.expiresAt = parseLeaseExpiry(response.execution.leaseExpiresAt);
  } catch (error) {
    if (activeLeases.get(executionKey) !== lease) return;
    if (isDefinitiveLeaseRejection(error) || Date.now() >= lease.expiresAt) {
      forgetLeaseAndCleanWorkspace(lease);
    }
  } finally {
    if (activeLeases.get(executionKey) === lease) {
      lease.renewalInFlight = false;
    }
  }
}

function markWorkActivity(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (lease) lease.lastWorkActivityAt = Date.now();
}

function getLeaseWatchdogTimeoutReason(lease: ActiveLease) {
  const now = Date.now();
  if (now - lease.acquiredAt >= EXECUTION_BUDGET_MS) {
    return 'execution_budget_exhausted' as const;
  }
  if (now - lease.lastWorkActivityAt >= WORK_HEARTBEAT_TIMEOUT_MS) {
    return 'work_heartbeat_stale' as const;
  }
  return undefined;
}

function getActiveLease(executionKey: string) {
  const lease = activeLeases.get(executionKey);
  if (lease && Date.now() >= lease.expiresAt) {
    forgetLeaseAndCleanWorkspace(lease);
    return undefined;
  }
  return lease;
}

async function expireTimedOutLease(
  lease: ActiveLease,
  reason: 'execution_budget_exhausted' | 'work_heartbeat_stale'
) {
  const timeoutMs =
    reason === 'execution_budget_exhausted'
      ? EXECUTION_BUDGET_MS
      : WORK_HEARTBEAT_TIMEOUT_MS;
  const message =
    reason === 'execution_budget_exhausted'
      ? `Runner execution exceeded its ${formatDuration(
          timeoutMs
        )} work budget.`
      : `Runner execution received no work heartbeat for ${formatDuration(
          timeoutMs
        )}.`;
  const errors: string[] = [];

  try {
    await api.releaseRunnerExecution(lease.executionKey, lease.token);
  } catch (error) {
    errors.push(
      `lease release: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await cleanRunnerWorkspace(lease);
  } catch (error) {
    errors.push(
      `workspace dependency cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    await api.upsertAgenticRunProgress({
      runKey: lease.runKey,
      projectName: lease.projectName,
      status: 'pending_retry',
      error: message,
      notes:
        'The MCP watchdog stopped renewing the lease, removed workspace dependencies, and retained the checkout for a bounded retry.',
      metadata: {
        executionMode: 'dedicated-runner',
        watchdogReason: reason,
        executionKey: lease.executionKey,
      },
      lastUpdateSource: 'mcp-cli',
    });
  } catch (error) {
    errors.push(
      `progress requeue: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (errors.length) {
    console.error(
      `Runner watchdog cleanup failed for ${lease.runKey}/${
        lease.projectName
      }: ${errors.join('; ')}`
    );
  }
}

async function finishRunnerLease<T>(
  lease: ActiveLease,
  finish: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  const [finishResult, cleanupResult] = await Promise.allSettled([
    finish(),
    cleanRunnerWorkspace(lease),
  ]);
  forgetLease(lease.executionKey);

  const errors = [finishResult, cleanupResult]
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errorMessage);
  return (finishResult as PromiseFulfilledResult<T>).value;
}

async function cleanRunnerWorkspace(lease: ActiveLease) {
  if (!lease.localPath) return;
  await removeRunnerWorkspaceNodeModules(lease.localPath);
}

function forgetLeaseAndCleanWorkspace(lease: ActiveLease) {
  forgetLease(lease.executionKey);
  void cleanRunnerWorkspace(lease).catch((error) => {
    console.error(
      `Runner workspace dependency cleanup failed for ${lease.runKey}/${
        lease.projectName
      }: ${error instanceof Error ? error.message : String(error)}`
    );
  });
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

function readPositiveDuration(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(durationMs: number) {
  if (durationMs % 60_000 === 0) {
    return `${durationMs / 60_000} minutes`;
  }
  return `${durationMs}ms`;
}

function executionIdentity(runKey: string, projectName: string) {
  return JSON.stringify([runKey, projectName]);
}
