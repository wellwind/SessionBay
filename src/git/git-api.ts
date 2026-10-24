import { call } from '../api';
import type { LinePosition, PullComment, PullDetail, PullFile, PullSummary, ReviewEvent, ConflictFile, ResolveChoice, Outcome, RecoveryPoint, RemoteTag, ResetMode, StashEntry, Blame, ChangedFile, CommitDetail, FileRevision, LogFilter, LogPage, CommitPreview, CommitResult, DiffSource, FileDiff, ProjectGit, PullStrategy, PushPlan, PushResult, Refs, RepoPath, RepoStatus, Selection } from './types';

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
  | { op: 'cancelOperation'; repoId: string }
  | { op: 'log'; repoId: string; filter: LogFilter; offset: number; limit: number }
  | { op: 'commitDetail'; repoId: string; commit: string }
  | { op: 'fileHistory'; repoId: string; path: RepoPath; offset: number; limit: number }
  | { op: 'blame'; repoId: string; path: RepoPath; rev: string | null }
  | { op: 'createBranch'; repoId: string; name: string; start: string | null; switch: boolean }
  | { op: 'switchBranch'; repoId: string; name: string }
  | { op: 'deleteBranch'; repoId: string; name: string; expected: string; force: boolean }
  | { op: 'stashes'; repoId: string }
  | { op: 'stashPush'; repoId: string; message: string; includeUntracked: boolean; keepIndex: boolean }
  | { op: 'stashApply'; repoId: string; index: number; expected: string; pop: boolean; restoreIndex: boolean }
  | { op: 'stashDrop'; repoId: string; index: number; expected: string }
  | { op: 'stashClear'; repoId: string; expected: string[] }
  | { op: 'reset'; repoId: string; target: string; mode: ResetMode; expectedHead: string }
  | { op: 'revert'; repoId: string; commit: string; parent: number | null; expectedHead: string }
  | { op: 'discard'; repoId: string; paths: RepoPath[]; untracked: RepoPath[] }
  | { op: 'createTag'; repoId: string; name: string; target: string | null; message: string | null; sign: boolean }
  | { op: 'deleteTag'; repoId: string; name: string; expected: string }
  | { op: 'remoteTags'; repoId: string; remote: string }
  | { op: 'pushTag'; repoId: string; remote: string; name: string; force: boolean }
  | { op: 'deleteRemoteTag'; repoId: string; remote: string; name: string; expected: string }
  | { op: 'recoveryPoints'; repoId: string }
  | { op: 'restoreRecovery'; repoId: string; id: string; allowHeadMove: boolean }
  | { op: 'removeRecovery'; repoId: string; id: string }
  | { op: 'merge'; repoId: string; rev: string; noFf: boolean; expectedHead: string }
  | { op: 'conflictFile'; repoId: string; path: RepoPath }
  | { op: 'saveConflict'; repoId: string; path: RepoPath; token: string; content: string }
  | { op: 'markResolved'; repoId: string; path: RepoPath; token: string; allowMarkers: boolean }
  | { op: 'resolveWith'; repoId: string; path: RepoPath; token: string; choice: ResolveChoice; newPath: RepoPath | null }
  | { op: 'continueOperation'; repoId: string }
  | { op: 'abortOperation'; repoId: string }
  | { op: 'remoteMappings'; repoId: string }
  | { op: 'setRemoteMapping'; repoId: string; remote: string; connectionId: string | null; project: string | null }
  | { op: 'pulls'; repoId: string; remote: string; state: string; refresh: boolean }
  | { op: 'pullDetail'; repoId: string; remote: string; number: number }
  | { op: 'pullFiles'; repoId: string; remote: string; number: number }
  | { op: 'pullComments'; repoId: string; remote: string; number: number }
  | { op: 'pullComment'; repoId: string; remote: string; number: number; body: string; position: LinePosition | null; expectedHead: string }
  | { op: 'pullReview'; repoId: string; remote: string; number: number; event: ReviewEvent; body: string; expectedHead: string }
  | { op: 'pullMerge'; repoId: string; remote: string; number: number; method: string; expectedHead: string }
  | { op: 'pullCreate'; repoId: string; remote: string; title: string; body: string; source: string; target: string; draft: boolean };

type Body<K extends GitRequest['op']> = Omit<Extract<GitRequest, { op: K }>, 'op'>;
const outcome = <K extends GitRequest['op']>(op: K) => (projectId: string, body: Body<K>) =>
  gitRequest<Outcome>(projectId, { op, ...body } as GitRequest);

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
  log: (projectId: string, repoId: string, filter: LogFilter, offset: number, limit: number) =>
    gitRequest<LogPage>(projectId, { op: 'log', repoId, filter, offset, limit }),
  commitDetail: (projectId: string, repoId: string, commit: string) => gitRequest<CommitDetail>(projectId, { op: 'commitDetail', repoId, commit }),
  fileHistory: (projectId: string, repoId: string, path: RepoPath, offset: number, limit: number) =>
    gitRequest<{ revisions: FileRevision[]; hasMore: boolean }>(projectId, { op: 'fileHistory', repoId, path, offset, limit }),
  blame: (projectId: string, repoId: string, path: RepoPath, rev: string | null) => gitRequest<Blame>(projectId, { op: 'blame', repoId, path, rev }),
  createBranch: outcome('createBranch'),
  switchBranch: outcome('switchBranch'),
  deleteBranch: outcome('deleteBranch'),
  stashes: (projectId: string, repoId: string) => gitRequest<StashEntry[]>(projectId, { op: 'stashes', repoId }),
  stashPush: outcome('stashPush'),
  stashApply: outcome('stashApply'),
  stashDrop: outcome('stashDrop'),
  stashClear: outcome('stashClear'),
  reset: outcome('reset'),
  revert: outcome('revert'),
  discard: outcome('discard'),
  createTag: outcome('createTag'),
  deleteTag: outcome('deleteTag'),
  remoteTags: (projectId: string, repoId: string, remote: string) => gitRequest<RemoteTag[]>(projectId, { op: 'remoteTags', repoId, remote }),
  pushTag: outcome('pushTag'),
  deleteRemoteTag: outcome('deleteRemoteTag'),
  recoveryPoints: (projectId: string, repoId: string) => gitRequest<RecoveryPoint[]>(projectId, { op: 'recoveryPoints', repoId }),
  restoreRecovery: (projectId: string, repoId: string, id: string, allowHeadMove: boolean) =>
    gitRequest<string[]>(projectId, { op: 'restoreRecovery', repoId, id, allowHeadMove }),
  removeRecovery: (projectId: string, repoId: string, id: string) => gitRequest<null>(projectId, { op: 'removeRecovery', repoId, id }),
  merge: outcome('merge'),
  conflictFile: (projectId: string, repoId: string, path: RepoPath) => gitRequest<ConflictFile>(projectId, { op: 'conflictFile', repoId, path }),
  saveConflict: (projectId: string, body: Body<'saveConflict'>) => gitRequest<{ token: string }>(projectId, { op: 'saveConflict', ...body }),
  markResolved: outcome('markResolved'),
  resolveWith: outcome('resolveWith'),
  continueOperation: outcome('continueOperation'),
  abortOperation: outcome('abortOperation'),
  pulls: (projectId: string, body: Body<'pulls'>) => gitRequest<PullSummary[]>(projectId, { op: 'pulls', ...body }),
  pullDetail: (projectId: string, body: Body<'pullDetail'>) => gitRequest<PullDetail>(projectId, { op: 'pullDetail', ...body }),
  pullFiles: (projectId: string, body: Body<'pullFiles'>) => gitRequest<{ files: PullFile[]; truncated: boolean }>(projectId, { op: 'pullFiles', ...body }),
  pullComments: (projectId: string, body: Body<'pullComments'>) => gitRequest<PullComment[]>(projectId, { op: 'pullComments', ...body }),
  pullComment: (projectId: string, body: Body<'pullComment'>) => gitRequest<null>(projectId, { op: 'pullComment', ...body }),
  pullReview: (projectId: string, body: Body<'pullReview'>) => gitRequest<null>(projectId, { op: 'pullReview', ...body }),
  pullMerge: (projectId: string, body: Body<'pullMerge'>) => gitRequest<null>(projectId, { op: 'pullMerge', ...body }),
  pullCreate: (projectId: string, body: Body<'pullCreate'>) => gitRequest<PullSummary>(projectId, { op: 'pullCreate', ...body }),
  cancelOperation: (projectId: string, repoId: string) => gitRequest<null>(projectId, { op: 'cancelOperation', repoId }),
  unstageSelection: (projectId: string, request: Omit<Extract<GitRequest, { op: 'unstageSelection' }>, 'op'>) =>
    gitRequest<null>(projectId, { op: 'unstageSelection', ...request }),
};
