import * as api from './api.service.js';
import { reportRunnerAgenticRunProgressSafely } from './agentic-runs.service.js';
import { mergeBitbucketPullRequest } from './bitbucket-data-center.service.js';
import { mergeGitlabMergeRequest } from './gitlab.service.js';
import { resolveProjectRepositoryUrl } from './runner-workspace-repository.service.js';
import {
  getChangeRequestDetails,
  validateRepositoryAccess,
} from './source-control.service.js';

export async function mergeRunnerChange(runKey: string, projectName: string) {
  const projectState = await api.refreshAgenticRunProjectState(
    runKey,
    projectName
  );
  const url = projectState.progress.mergeRequestUrl;
  if (!url) throw new Error('Publish the migration before merging it.');
  const repositoryUrl = resolveProjectRepositoryUrl(
    projectState.project,
    projectState.progress.repositoryUrl ?? undefined
  );
  const access = await api.getRepositoryAccess(repositoryUrl);
  const repository = await validateRepositoryAccess(access, repositoryUrl);
  const change = await getChangeRequestDetails(
    access,
    repository.repositoryId,
    url
  );
  if (
    projectState.progress.branch &&
    change.sourceBranch !== projectState.progress.branch
  ) {
    throw new Error(
      'The MR source branch differs from this migration: ' + change.sourceBranch
    );
  }
  let result: { merged: boolean; reason?: string };
  if (change.state.toLowerCase() === 'merged') result = { merged: true };
  else if (access.provider === 'gitlab') {
    if (!change.sourceHeadSha)
      throw new Error(
        'GitLab did not return the current source commit. Refresh the MR and retry.'
      );
    result = await mergeGitlabMergeRequest(
      access,
      repository.repositoryId,
      url,
      change.sourceHeadSha
    );
  } else {
    if (change.id == null || change.version == null)
      throw new Error(
        'Bitbucket did not return the current pull request identity/version.'
      );
    result = await mergeBitbucketPullRequest(
      access,
      repository.repositoryId,
      change.id,
      change.version
    );
  }
  const progressReport = result.merged
    ? await reportRunnerAgenticRunProgressSafely(runKey, projectName, {
        status: 'done',
        resolution: 'merged',
        repositoryUrl,
        branch: change.sourceBranch,
        commitSha: change.sourceHeadSha,
        mergeRequestUrl: url,
        mergeRequestState: 'merged',
        notes: 'Migration merged by the Git provider.',
      })
    : undefined;
  return {
    ...result,
    mergeRequestUrl: url,
    projectState,
    progressReport,
    instructions: result.merged
      ? ['Migration merged.']
      : [
          'Inspect the provider reason and CI diagnostics, repair the same workspace if needed, then retry merging.',
        ],
  };
}
