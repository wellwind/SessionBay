import { call } from '../api';
import type { ChangedFile, DiffSource, FileDiff, ProjectGit, Refs, RepoPath, RepoStatus, Selection } from './types';

/** One typed IPC entry point; the backend revalidates project and repo identity. */
export type GitRequest =
  | { op: 'discover' }
  | { op: 'cancelDiscovery' }
  | { op: 'status'; repoId: string }
  | { op: 'diff'; repoId: string; path: RepoPath; oldPath?: RepoPath | null; source: DiffSource; ignoreWhitespace?: boolean; untracked?: boolean }
  | { op: 'changedFiles'; repoId: string; source: DiffSource }
  | { op: 'refs'; repoId: string }
  | { op: 'stagePaths'; repoId: string; paths: RepoPath[] }
  | { op: 'unstagePaths'; repoId: string; paths: RepoPath[] }
  | { op: 'stageSelection'; repoId: string; path: RepoPath; untracked?: boolean; snapshot: string; selection: Selection }
  | { op: 'unstageSelection'; repoId: string; path: RepoPath; snapshot: string; selection: Selection };

export const gitRequest = <T>(projectId: string, request: GitRequest) =>
  call<T>('git_request', { projectId, request });

export const gitApi = {
  discover: (projectId: string) => gitRequest<ProjectGit>(projectId, { op: 'discover' }),
  cancelDiscovery: (projectId: string) => gitRequest<null>(projectId, { op: 'cancelDiscovery' }),
  status: (projectId: string, repoId: string) => gitRequest<RepoStatus>(projectId, { op: 'status', repoId }),
  diff: (projectId: string, request: Omit<Extract<GitRequest, { op: 'diff' }>, 'op'>) =>
    gitRequest<FileDiff>(projectId, { op: 'diff', ...request }),
  changedFiles: (projectId: string, repoId: string, source: DiffSource) =>
    gitRequest<{ files: ChangedFile[]; truncated: boolean }>(projectId, { op: 'changedFiles', repoId, source }),
  refs: (projectId: string, repoId: string) => gitRequest<Refs>(projectId, { op: 'refs', repoId }),
  stagePaths: (projectId: string, repoId: string, paths: RepoPath[]) => gitRequest<null>(projectId, { op: 'stagePaths', repoId, paths }),
  unstagePaths: (projectId: string, repoId: string, paths: RepoPath[]) => gitRequest<null>(projectId, { op: 'unstagePaths', repoId, paths }),
  stageSelection: (projectId: string, request: Omit<Extract<GitRequest, { op: 'stageSelection' }>, 'op'>) =>
    gitRequest<null>(projectId, { op: 'stageSelection', ...request }),
  unstageSelection: (projectId: string, request: Omit<Extract<GitRequest, { op: 'unstageSelection' }>, 'op'>) =>
    gitRequest<null>(projectId, { op: 'unstageSelection', ...request }),
};
