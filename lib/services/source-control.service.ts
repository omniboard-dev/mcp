import { AgenticRunProviderSnapshot, RepositoryAccess } from '../interface.js';
import {
  createBitbucketPullRequest,
  getBitbucketPullRequestDetails,
  requestBitbucketPullRequestRebase,
  validateBitbucketRepositoryAccess,
} from './bitbucket-data-center.service.js';
import {
  createGitlabMergeRequest,
  getGitlabMergeRequestDetails,
  requestGitlabMergeRequestRebase,
  retryGitlabPipeline,
  validateGitlabProjectAccess,
} from './gitlab.service.js';

export interface SourceControlChangeRequest {
  id?: number;
  iid?: number;
  url: string;
  state: string;
  title: string;
}

export interface SourceControlChangeRequestDetails
  extends SourceControlChangeRequest {
  sourceBranch: string;
  targetBranch: string;
  sourceHeadSha: string | null;
  targetHeadSha?: string | null;
  detailedStatus: string | null;
  rebaseInProgress: boolean;
  rebaseError: string | null;
  version?: number | null;
  providerSnapshot?: AgenticRunProviderSnapshot;
}

export interface SourceControlRebaseRequestResult {
  requested: boolean;
  inProgress?: boolean;
  reason?: string;
}

export async function validateRepositoryAccess(
  access: RepositoryAccess,
  repositoryUrl: string
) {
  switch (access.provider) {
    case 'bitbucket_data_center':
      return validateBitbucketRepositoryAccess(access, repositoryUrl);
    case 'gitlab': {
      const result = await validateGitlabProjectAccess(access, repositoryUrl);
      return { repositoryId: result.projectPath };
    }
  }
}

export async function createChangeRequest(
  access: RepositoryAccess,
  repositoryId: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description?: string
): Promise<SourceControlChangeRequest> {
  const normalizedDescription = normalizeChangeRequestDescription(description);

  switch (access.provider) {
    case 'bitbucket_data_center':
      return createBitbucketPullRequest(
        access,
        repositoryId,
        sourceBranch,
        targetBranch,
        title,
        normalizedDescription
      );
    case 'gitlab':
      return createGitlabMergeRequest(
        access,
        repositoryId,
        sourceBranch,
        targetBranch,
        title,
        normalizedDescription
      );
  }
}

export function getChangeRequestDetails(
  access: RepositoryAccess,
  repositoryId: string,
  mergeRequestUrl: string
): Promise<SourceControlChangeRequestDetails> {
  switch (access.provider) {
    case 'bitbucket_data_center':
      return getBitbucketPullRequestDetails(
        access,
        repositoryId,
        mergeRequestUrl
      );
    case 'gitlab':
      return getGitlabMergeRequestDetails(
        access,
        repositoryId,
        mergeRequestUrl
      );
  }
}

export function requestChangeRequestRebase(
  access: RepositoryAccess,
  repositoryId: string,
  mergeRequestUrl: string
): Promise<SourceControlRebaseRequestResult> {
  switch (access.provider) {
    case 'bitbucket_data_center':
      return requestBitbucketPullRequestRebase(
        access,
        repositoryId,
        mergeRequestUrl
      );
    case 'gitlab':
      return requestGitlabMergeRequestRebase(
        access,
        repositoryId,
        mergeRequestUrl
      );
  }
}

function normalizeChangeRequestDescription(description?: string) {
  if (!description || /[\r\n]/.test(description)) return description;

  const escapedLineBreaks = description.match(/\\r\\n|\\n/g) ?? [];
  if (escapedLineBreaks.length < 2) return description;

  return description.replace(/\\r\\n|\\n/g, '\n');
}

export async function retryFailedPipeline(
  access: RepositoryAccess,
  repositoryUrl: string,
  pipelineUrl: string
) {
  switch (access.provider) {
    case 'bitbucket_data_center':
      return {
        supported: false as const,
        reason:
          'Bitbucket Data Center does not expose a standard repository pipeline retry API.',
      };
    case 'gitlab':
      return {
        supported: true as const,
        ...(await retryGitlabPipeline(access, repositoryUrl, pipelineUrl)),
      };
  }
}

export function resolveGitUsername(access: RepositoryAccess) {
  return access.provider === 'bitbucket_data_center'
    ? access.username
    : 'oauth2';
}

export function providerLabel(access: RepositoryAccess) {
  return access.provider === 'bitbucket_data_center'
    ? 'Bitbucket Data Center'
    : 'GitLab';
}
