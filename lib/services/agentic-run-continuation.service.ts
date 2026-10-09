import {
  AgenticRunContinuationDecision,
  AgenticRunProjectState,
  AgenticRunWorkflowDecision,
} from '../interface.js';

export function getAgenticRunContinuationDecision(
  projectState: AgenticRunProjectState
): AgenticRunContinuationDecision {
  const workflow = projectState.progress.workflow;
  if (!workflow)
    throw new Error(
      'The API workflow contract is missing. Deploy the matching API before this MCP version.'
    );
  return workflowContinuation(workflow, projectState);
}

export function workflowContinuation(
  workflow: AgenticRunWorkflowDecision,
  projectState: AgenticRunProjectState
): AgenticRunContinuationDecision {
  const retry = projectState.progress.retryInstructions?.find(
    (instruction) => instruction.disposition === 'accepted'
  );
  return {
    outcome: workflow.outcome,
    action:
      workflow.nextAction === 'prepare' ? 'continue' : workflow.nextAction,
    reason: workflow.reason,
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
