import { call } from '../api';
import type { ProjectGit, RepoStatus } from './types';

/** One typed IPC entry point; the backend revalidates project and repo identity. */
export type GitRequest =
  | { op: 'discover' }
  | { op: 'cancelDiscovery' }
  | { op: 'status'; repoId: string };

export const gitRequest = <T>(projectId: string, request: GitRequest) =>
  call<T>('git_request', { projectId, request });

export const gitApi = {
  discover: (projectId: string) => gitRequest<ProjectGit>(projectId, { op: 'discover' }),
  cancelDiscovery: (projectId: string) => gitRequest<null>(projectId, { op: 'cancelDiscovery' }),
  status: (projectId: string, repoId: string) => gitRequest<RepoStatus>(projectId, { op: 'status', repoId }),
};
