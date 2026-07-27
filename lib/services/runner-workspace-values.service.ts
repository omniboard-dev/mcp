import { AgenticRunSummary } from '../interface.js';

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
      defaultRunnerCommitMessage(run.runKey),
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

export function normalizeNonEmptyString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function defaultRunnerCommitMessage(runKey: string) {
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
