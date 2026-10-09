import {
  AgenticRunContinuationDecision,
  AgenticRunProjectState,
  AgenticRunWorkflowDecision,
} from '../interface.js';

export function getAgenticRunContinuationDecision(
  projectState: AgenticRunProjectState
): AgenticRunContinuationDecision {
  const workflow = projectState.progress.workflow;
  if (!workflow) {
    return workflowContinuation(
      {
        outcome: 'waiting',
        reason: 'workflow_unavailable',
        instruction:
          'The API did not return a workflow decision. Update the API before using this MCP version.',
      },
      projectState
    );
  }
  if (
    !projectState.providerSync.success &&
    !['complete', 'dismissed'].includes(workflow.outcome)
  ) {
    return workflowContinuation(
      {
        outcome: 'waiting',
        reason: 'provider_sync_failed',
        instruction:
          projectState.providerSync.error ||
          'Provider state could not be refreshed. Do not start or republish migration work.',
      },
      projectState
    );
  }
  return workflowContinuation(workflow, projectState);
}

export function workflowContinuation(
  workflow: AgenticRunWorkflowDecision,
  projectState: AgenticRunProjectState
): AgenticRunContinuationDecision {
  const retry = projectState.progress.retryInstructions?.[0];
  return {
    outcome: workflow.outcome,
    action:
      workflow.outcome === 'actionable'
        ? 'continue'
        : workflow.outcome === 'waiting'
        ? 'wait'
        : 'stop',
    reason: workflow.reason as AgenticRunContinuationDecision['reason'],
    instructions: [
      workflow.instruction,
      ...(retry && workflow.outcome === 'actionable'
        ? ['Operator guidance: ' + retry.instruction]
        : []),
    ],
    diagnostics: formatPipelineDiagnostics(projectState),
  };
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
