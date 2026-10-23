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
