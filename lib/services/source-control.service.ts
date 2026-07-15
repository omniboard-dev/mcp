import { McpRepositoryAccess } from '../interface.js';
import {
  createBitbucketPullRequest,
  validateBitbucketRepositoryAccess,
} from './bitbucket-data-center.service.js';
import {
  createGitlabMergeRequest,
  validateGitlabProjectAccess,
} from './gitlab.service.js';

export interface SourceControlChangeRequest {
  id?: number;
  iid?: number;
  url: string;
  state: string;
  title: string;
}

export async function validateRepositoryAccess(
  access: McpRepositoryAccess,
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
  access: McpRepositoryAccess,
  repositoryId: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description?: string
): Promise<SourceControlChangeRequest> {
  switch (access.provider) {
    case 'bitbucket_data_center':
      return createBitbucketPullRequest(
        access,
        repositoryId,
        sourceBranch,
        targetBranch,
        title,
        description
      );
    case 'gitlab':
      return createGitlabMergeRequest(
        access,
        repositoryId,
        sourceBranch,
        targetBranch,
        title,
        description
      );
  }
}

export function resolveGitUsername(access: McpRepositoryAccess) {
  return access.provider === 'bitbucket_data_center'
    ? access.username
    : 'oauth2';
}

export function providerLabel(access: McpRepositoryAccess) {
  return access.provider === 'bitbucket_data_center'
    ? 'Bitbucket Data Center'
    : 'GitLab';
}
