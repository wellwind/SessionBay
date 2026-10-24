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
