import { call } from '../api';
import type { ChangedFile, CommitPreview, CommitResult, DiffSource, FileDiff, ProjectGit, PullStrategy, PushPlan, PushResult, Refs, RepoPath, RepoStatus, Selection } from './types';

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
  | { op: 'unstageSelection'; repoId: string; path: RepoPath; snapshot: string; selection: Selection }
  | { op: 'commitPreview'; repoId: string }
  | { op: 'commit'; repoId: string; message: string; token: string }
  | { op: 'pushPlan'; repoId: string }
  | { op: 'fetch'; repoId: string; remote: string | null; prune: boolean }
  | { op: 'pull'; repoId: string; strategy: PullStrategy }
  | { op: 'push'; repoId: string; remote: string; localBranch: string; remoteBranch: string; setUpstream: boolean; forceWithLease?: string | null }
  | { op: 'cancelOperation'; repoId: string };

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
  commitPreview: (projectId: string, repoId: string) => gitRequest<CommitPreview>(projectId, { op: 'commitPreview', repoId }),
  commit: (projectId: string, repoId: string, message: string, token: string) => gitRequest<CommitResult>(projectId, { op: 'commit', repoId, message, token }),
  pushPlan: (projectId: string, repoId: string) => gitRequest<PushPlan>(projectId, { op: 'pushPlan', repoId }),
  fetch: (projectId: string, repoId: string, remote: string | null, prune: boolean) =>
    gitRequest<{ output: string }>(projectId, { op: 'fetch', repoId, remote, prune }),
  pull: (projectId: string, repoId: string, strategy: PullStrategy) => gitRequest<{ output: string }>(projectId, { op: 'pull', repoId, strategy }),
  push: (projectId: string, request: Omit<Extract<GitRequest, { op: 'push' }>, 'op'>) => gitRequest<PushResult>(projectId, { op: 'push', ...request }),
  cancelOperation: (projectId: string, repoId: string) => gitRequest<null>(projectId, { op: 'cancelOperation', repoId }),
  unstageSelection: (projectId: string, request: Omit<Extract<GitRequest, { op: 'unstageSelection' }>, 'op'>) =>
    gitRequest<null>(projectId, { op: 'unstageSelection', ...request }),
};
