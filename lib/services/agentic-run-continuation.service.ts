import {
  AgenticRunContinuationDecision,
  AgenticRunProjectState,
} from '../interface.js';

const ACTIONABLE_REVIEW_STATUSES = new Set([
  'discussions_not_resolved',
  'requested_changes',
]);
const ACTIONABLE_MERGE_STATUSES = new Set([
  'cannot_be_merged',
  'conflict',
  'need_rebase',
]);
const INFRASTRUCTURE_FAILURE_REASONS = new Set([
  'api_failure',
  'data_integrity_failure',
  'runner_system_failure',
  'scheduler_failure',
  'stuck_or_timeout_failure',
]);

export function getAgenticRunContinuationDecision(
  projectState: AgenticRunProjectState
): AgenticRunContinuationDecision {
  const diagnostics = formatPipelineDiagnostics(projectState);

  if (!projectState.project.currentlyMatchesCheck) {
    return decision(
      'stop',
      'project_no_longer_matches',
      ['The project no longer matches this agentic check. Do not modify it.'],
      diagnostics
    );
  }

  if (!projectState.providerSync.success) {
    return decision(
      'wait',
      'provider_sync_failed',
      [
        'Provider state could not be refreshed. Do not create a duplicate branch or change request.',
        projectState.providerSync.error ?? 'Provider synchronization failed.',
      ],
      diagnostics
    );
  }

  switch (projectState.progress.status) {
    case 'pending':
    case 'in_progress':
    case 'implemented':
    case 'verified':
    case 'committed':
    case 'pushed':
      return decision(
        'continue',
        'active_work',
        ['Continue work for this agentic run.'],
        diagnostics
      );
    case 'failed':
      if (
        projectState.progress.pipelineStatus === 'failed' &&
        hasOnlyInfrastructureFailures(projectState)
      ) {
        return decision(
          'wait',
          'infrastructure_pipeline_failure',
          [
            'The pipeline failure is classified as infrastructure-related. Do not modify project code automatically.',
            ...diagnostics,
          ],
          diagnostics
        );
      }
      if (projectState.progress.pipelineStatus === 'failed') {
        return decision(
          'continue',
          'application_pipeline_failure',
          [
            'Continue work to resolve the application pipeline failure.',
            ...diagnostics,
          ],
          diagnostics
        );
      }
      return decision(
        'continue',
        'retry_failed_work',
        ['Retry the failed agentic run work.'],
        diagnostics
      );
    case 'needs_input':
      if (
        ACTIONABLE_REVIEW_STATUSES.has(
          normalizeProviderStatus(
            projectState.progress.mergeRequestDetailedStatus
          )
        )
      ) {
        return decision(
          'continue',
          'actionable_review_feedback',
          ['Continue work to resolve the provider review feedback.'],
          diagnostics
        );
      }
      return decision(
        'wait',
        'waiting_for_provider_activity',
        [
          'The run needs input, but provider state does not identify actionable review feedback. Wait for updated provider activity.',
          ...diagnostics,
        ],
        diagnostics
      );
    case 'blocked':
      if (
        ACTIONABLE_MERGE_STATUSES.has(
          normalizeProviderStatus(
            projectState.progress.mergeRequestDetailedStatus
          )
        )
      ) {
        return decision(
          'continue',
          'actionable_merge_block',
          ['Continue work to resolve the provider mergeability issue.'],
          diagnostics
        );
      }
      return decision(
        'wait',
        'waiting_for_provider_activity',
        [
          'The run is blocked without an actionable mergeability status. Wait for updated provider activity.',
          ...diagnostics,
        ],
        diagnostics
      );
    case 'mr_created':
      return decision(
        'wait',
        'waiting_for_provider_activity',
        [
          'The change request remains open without an actionable failure. Wait for provider activity.',
        ],
        diagnostics
      );
    case 'merged':
      return decision(
        'stop',
        'change_merged',
        [
          'The change request is merged. No further workspace work is required.',
        ],
        diagnostics
      );
    default:
      return decision(
        'wait',
        'unsupported_progress_status',
        [
          'The canonical progress status "' +
            String(projectState.progress.status) +
            '" is not supported. Wait for an MCP update.',
        ],
        diagnostics
      );
  }
}

export function hasOnlyInfrastructureFailures(
  projectState: AgenticRunProjectState
) {
  const diagnostics = projectState.providerSync.diagnostics;
  return (
    diagnostics.length > 0 &&
    diagnostics.every((diagnostic) =>
      INFRASTRUCTURE_FAILURE_REASONS.has(
        normalizeProviderStatus(diagnostic.failureReason)
      )
    )
  );
}

export function formatPipelineDiagnostics(
  projectState: AgenticRunProjectState
) {
  const summary = projectState.progress.pipelineFailureSummary;
  const diagnostics = projectState.providerSync.diagnostics.flatMap(
    (diagnostic) => {
      const heading = [
        diagnostic.stage,
        diagnostic.name,
        diagnostic.failureReason,
        diagnostic.url,
      ]
        .filter(Boolean)
        .join(' | ');
      return [heading, diagnostic.traceExcerpt]
        .filter((value): value is string => !!value)
        .map((value) => 'Pipeline diagnostic: ' + value);
    }
  );

  return [
    summary ? 'Pipeline failure: ' + summary : null,
    ...diagnostics,
  ].filter((value): value is string => !!value);
}

function decision(
  action: AgenticRunContinuationDecision['action'],
  reason: AgenticRunContinuationDecision['reason'],
  instructions: string[],
  diagnostics: string[]
): AgenticRunContinuationDecision {
  return {
    action,
    reason,
    instructions,
    diagnostics,
  };
}

function normalizeProviderStatus(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}
