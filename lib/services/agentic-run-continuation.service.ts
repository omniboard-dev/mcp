import {
  AgenticRunContinuationDecision,
  AgenticRunProjectState,
  AgenticRunWorkflowDecision,
} from '../interface.js';

export const AGENTIC_RUN_LOCAL_VERIFICATION_INSTRUCTIONS = [
  'Inspect the project scripts and documented validation commands. Run all applicable local build, lint, unit-test and end-to-end checks using the existing project commands, and record the commands and results. Run analyzer validation separately when available.',
  'When a local check fails, inspect its output, identify the cause, repair migration-related code or tests, and rerun that check. Repeat repair and rerun until the check passes, then rerun all applicable checks before finalizing.',
  'Once all applicable local checks have passed, finalize the workspace, push the branch and create or update the MR. While checks are failing, continue the repair loop in the same workspace. When a sandbox or permission restriction prevents a check from running, use the coding client approval flow to rerun the same check with the required access. If access remains unavailable, report the concrete blocker and leave publication pending.',
  'Keep repairs within the requested migration. Preserve test coverage and keep applicable checks enabled with their assertions intact. Report unrelated failures separately for a scope decision.',
  'Keep reporting implementation progress while diagnosing and repairing local check failures. Use failed, blocked or needs_input when progress requires external action or a decision outside the authorized scope; include the commands and failure evidence, repairs attempted, and the exact action needed to resume.',
];

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
