/** Mirrors `src-tauri/src/git`; paths keep raw bytes when not UTF-8. */
export interface RepoPath { path: string; raw?: string }

export interface RepoInfo {
  id: string; name: string; root: string; relativePath: string;
  gitDir: string; commonDir: string; linkedWorktree: boolean; enclosesProject: boolean;
}
export type IssueKind = 'bare' | 'broken' | 'dubiousOwnership' | 'submodule';
export interface RepoIssue { kind: IssueKind; relativePath: string; message: string }
export interface Discovery {
  gitVersion: string; repos: RepoInfo[]; issues: RepoIssue[]; truncated: boolean; cancelled: boolean;
  limitReason?: 'time' | 'directories' | 'repositories' | null; scannedDepth?: number;
}
export type ProjectGit = { state: 'unavailable'; message: string } | ({ state: 'ready' } & Discovery);

export type Change = 'modified' | 'typeChanged' | 'added' | 'deleted' | 'renamed' | 'copied';
export type ConflictKind = 'bothDeleted' | 'addedByUs' | 'deletedByThem' | 'addedByThem' | 'deletedByUs' | 'bothAdded' | 'bothModified';
export type Operation = 'merge' | 'rebase' | 'am' | 'cherryPick' | 'revert' | 'bisect';
export interface StatusEntry {
  path: RepoPath; origPath?: RepoPath; staged: Change | null; unstaged: Change | null;
  untracked: boolean; conflict: ConflictKind | null; submodule: boolean; modes: [string, string, string];
}
export interface BranchState {
  oid: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; unborn: boolean;
}
export interface RepoStatus {
  repoId: string; revision: string; branch: BranchState; operation: Operation | null;
  stashCount: number; entries: StatusEntry[]; truncated: boolean;
}

export const pathKey = (path: RepoPath) => path.raw ? `raw:${path.raw}` : path.path;
export const operationLabel: Record<Operation, string> = {
  merge: '合併進行中', rebase: 'Rebase 進行中', am: '套用 patch 進行中', cherryPick: 'Cherry-pick 進行中',
  revert: 'Revert 進行中', bisect: 'Bisect 進行中',
};
export const changeLabel: Record<Change, { letter: string; text: string }> = {
  modified: { letter: 'M', text: '已修改' }, typeChanged: { letter: 'T', text: '類型變更' },
  added: { letter: 'A', text: '新增' }, deleted: { letter: 'D', text: '刪除' },
  renamed: { letter: 'R', text: '重新命名' }, copied: { letter: 'C', text: '複製' },
};
export const conflictLabel: Record<ConflictKind, string> = {
  bothDeleted: '雙方刪除', addedByUs: '我方新增', deletedByThem: '對方刪除', addedByThem: '對方新增',
  deletedByUs: '我方刪除', bothAdded: '雙方新增', bothModified: '雙方修改',
};
export const branchLabel = (branch: BranchState) =>
  branch.head ?? (branch.oid ? `detached @ ${branch.oid.slice(0, 7)}` : 'detached HEAD');

export type DiffSource =
  | { kind: 'unstaged' } | { kind: 'staged' } | { kind: 'workingTree' }
  | { kind: 'commit'; commit: string; parent: number | null }
  | { kind: 'compare'; base: string; head: string; mergeBase: boolean };
export type LineKind = 'context' | 'add' | 'delete';
export interface DiffLine {
  kind: LineKind; text: string; oldLine: number | null; newLine: number | null;
  noNewline: boolean; crlf: boolean; clipped: boolean;
}
export interface DiffHunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }
export interface FileDiff {
  repoId: string; path: RepoPath; oldPath: RepoPath | null; source: DiffSource; ignoreWhitespace: boolean;
  binary: boolean; newFile: boolean; deletedFile: boolean; renamed: boolean; submodule: boolean;
  oldMode: string | null; newMode: string | null; hunks: DiffHunk[];
  tooLarge: boolean; truncated: boolean; unsupportedEncoding: boolean; snapshot: string; partialBlocked: string | null;
}
export interface LineRef { hunk: number; line: number }
export type Selection = { kind: 'hunks'; hunks: number[] } | { kind: 'lines'; lines: LineRef[] };
export interface ChangedFile { status: string; path: RepoPath; oldPath: RepoPath | null }

export const sourceLabel = (source: DiffSource) => {
  switch (source.kind) {
    case 'unstaged': return '工作目錄 ↔ index（未暫存）';
    case 'staged': return 'index ↔ HEAD（已暫存）';
    case 'workingTree': return '工作目錄 ↔ HEAD（全部未提交）';
    case 'commit': return `${source.commit.slice(0, 7)} ↔ ${source.parent ? `parent ${source.parent}` : 'parent'}`;
    case 'compare': return `${source.base} ${source.mergeBase ? '...' : '..'} ${source.head}${source.mergeBase ? '（自 merge-base）' : '（直接比較）'}`;
  }
};
export const sourceKey = (source: DiffSource) => JSON.stringify(source);

export interface Branch {
  name: string; fullName: string; remote: boolean; oid: string; upstream: string | null;
  ahead: number | null; behind: number | null; upstreamGone: boolean; current: boolean;
  worktree: string | null; subject: string; committedAt: number;
}
export interface Tag { name: string; oid: string; target: string; annotated: boolean; message: string; tagger: string; createdAt: number }
export interface Remote { name: string; url: string; pushUrl: string }
export interface Worktree { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean; locked: boolean; prunable: boolean; current: boolean }
export interface Refs { branches: Branch[]; tags: Tag[]; remotes: Remote[]; worktrees: Worktree[]; truncated: boolean }

export interface CommitPreview {
  repoId: string; branch: string | null; head: string | null; files: ChangedFile[]; truncated: boolean;
  token: string; hooks: string[]; signing: string | null; author: string | null; operation: Operation | null;
}
export interface CommitResult { oid: string; summary: string; output: string }
export type PullStrategy = 'merge' | 'rebase' | 'fastForwardOnly';
export interface PushPlan {
  branch: string | null; head: string | null; upstreamRemote: string | null; upstreamBranch: string | null;
  pushRemote: string | null; remotes: string[]; ahead: number; behind: number; hooks: string[];
  followTagsConfigured: boolean; pullRebaseConfigured: string | null;
}
export interface PushResult { output: string; confirmed: boolean; pushed: string }
export const pullStrategyLabel: Record<PullStrategy, string> = {
  merge: 'Merge（建立合併 commit）', rebase: 'Rebase（把本機 commit 接到遠端之後）', fastForwardOnly: '只允許 fast-forward',
};

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'other';
export interface RefLabel { name: string; kind: RefKind; current: boolean }
export interface LogCommit {
  oid: string; parents: string[]; author: string; email: string; authoredAt: number; committedAt: number; subject: string; refs: RefLabel[];
}
export interface LogFilter { text?: string; author?: string; path?: RepoPath | null; rev?: string | null }
export interface LogPage { commits: LogCommit[]; hasMore: boolean; filtered: boolean }
export interface CommitDetail {
  oid: string; parents: string[]; author: string; email: string; authoredAt: number;
  committer: string; committerEmail: string; committedAt: number; message: string; refs: RefLabel[];
}
export interface FileRevision { commit: LogCommit; path: RepoPath; status: string }
export interface BlameCommit { author: string; authoredAt: number; summary: string; previous: [string, RepoPath] | null; path: RepoPath; uncommitted: boolean }
export interface BlameLine { oid: string; originalLine: number; line: number; text: string }
export interface Blame { path: RepoPath; rev: string | null; lines: BlameLine[]; commits: Record<string, BlameCommit>; truncated: boolean }
export const formatTime = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleString() : '';

export interface StashEntry { index: number; oid: string; message: string; createdAt: number }
export interface Coverage { head: boolean; index: boolean; trackedFiles: boolean; untrackedFiles: number; refs: string[] }
export interface RecoveryPoint {
  id: string; repoId: string; repoRoot: string; createdAt: number; operation: string; branch: string | null; head: string | null;
  snapshot: string | null; untracked: RepoPath[]; coverage: Coverage; headAfter: string | null; notes: string[];
}
export interface Outcome { message: string; recovery: RecoveryPoint | null; conflicts: boolean }
export interface RemoteTag { name: string; oid: string }
export type ResetMode = 'soft' | 'mixed' | 'hard';
export const resetModeLabel: Record<ResetMode, { title: string; detail: string }> = {
  soft: { title: 'Soft', detail: '只移動 branch；index 與工作目錄保持不變，被移除的 commit 內容會留在已暫存區。' },
  mixed: { title: 'Mixed', detail: '移動 branch 並重設 index；工作目錄檔案保持不變，變更變成未暫存。' },
  hard: { title: 'Hard', detail: '移動 branch，並讓 index 與 tracked 工作檔完全回到目標；未提交的 tracked 變更會被覆蓋（untracked 檔案不受影響）。' },
};
export function coverageText(coverage: Coverage): string[] {
  const items: string[] = [];
  if (coverage.head) items.push('HEAD 與目前 branch 位置');
  if (coverage.index) items.push('index（已暫存內容）');
  if (coverage.trackedFiles) items.push('tracked 工作檔的未提交變更');
  if (coverage.untrackedFiles) items.push(`${coverage.untrackedFiles} 個 untracked 檔案的位元組備份`);
  for (const ref of coverage.refs) items.push(`ref ${ref}`);
  return items;
}

export interface ConflictSide { label: string; detail: string; present: boolean; oid: string | null; mode: string | null; size: number; text: string | null }
export interface ConflictFile {
  path: RepoPath; operation: Operation | null; base: ConflictSide; ours: ConflictSide; theirs: ConflictSide; result: ConflictSide;
  textual: boolean; token: string; unmerged: boolean;
}
export type ResolveChoice = 'ours' | 'theirs' | 'base' | 'delete' | 'keepWorkTree';

export type PullState = 'open' | 'closed' | 'merged';
export type CiState = 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'unknown';
export interface PullSummary {
  number: number; title: string; state: PullState; draft: boolean; author: string; sourceBranch: string; targetBranch: string;
  headSha: string; updatedAt: string; webUrl: string;
}
export interface CiStatus { state: CiState; checks: { name: string; state: CiState; url: string | null }[]; fetchedAt: number; webUrl: string | null; sha: string }
export interface PullDetail {
  summary: PullSummary; body: string; baseSha: string; startSha: string; mergeable: boolean | null; mergeStatus: string;
  approvedBy: string[]; viewerApproved: boolean; ci: CiStatus;
  capabilities: { canComment: boolean; canApprove: boolean; canRequestChanges: boolean; canMerge: boolean; mergeMethods: string[]; notes: string[] };
  connection: { id: string; account: string; host: string; provider: 'github' | 'gitlab' };
}
export interface PullFile { path: string; oldPath: string | null; status: string; additions: number; deletions: number; patch: string | null }
export interface PullComment { id: string; author: string; body: string; createdAt: string; path: string | null; line: number | null; side: string | null; outdated: boolean }
export interface LinePosition { path: string; oldPath: string | null; side: 'new' | 'old'; line: number }
export type ReviewEvent = 'approve' | 'requestChanges' | 'comment' | 'unapprove';
export const ciLabel: Record<CiState, string> = {
  pending: '等待中', running: '執行中', success: '通過', failure: '失敗', cancelled: '已取消', unknown: '狀態未知',
};
