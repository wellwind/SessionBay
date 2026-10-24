import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchesPanel } from './BranchesPanel';
import { StashPanel } from './StashPanel';
import { TagsPanel } from './TagsPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { ResetDialog } from './HistoryActions';
import { gitApi } from './git-api';
import type { Branch, Refs, RepoInfo, RepoStatus } from './types';

vi.mock('./git-api', () => ({ gitApi: {
  switchBranch: vi.fn(), createBranch: vi.fn(), deleteBranch: vi.fn(), stashes: vi.fn(), stashPush: vi.fn(), stashApply: vi.fn(),
  stashDrop: vi.fn(), stashClear: vi.fn(), pushTag: vi.fn(), remoteTags: vi.fn(), deleteTag: vi.fn(), deleteRemoteTag: vi.fn(), createTag: vi.fn(),
  reset: vi.fn(), recoveryPoints: vi.fn(), restoreRecovery: vi.fn(), removeRecovery: vi.fn(),
} }));

const repo: RepoInfo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false };
const status = (extra: Partial<RepoStatus> = {}): RepoStatus => ({ repoId: 'r1', revision: 'x', operation: null, stashCount: 0, truncated: false, entries: [],
  branch: { oid: 'a'.repeat(40), head: 'main', upstream: null, ahead: 0, behind: 0, unborn: false }, ...extra });
const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({ name, fullName: `refs/heads/${name}`, remote: false, oid: `${name}`.padEnd(40, '1'),
  upstream: null, ahead: null, behind: null, upstreamGone: false, current: false, worktree: null, subject: '', committedAt: 0, ...extra });
const refs = (extra: Partial<Refs> = {}): Refs => ({ branches: [branch('main', { current: true }), branch('topic'), branch('busy', { worktree: '/synthetic/other' })],
  tags: [{ name: 'v1', oid: 'f'.repeat(40), target: 'a'.repeat(40), annotated: true, message: 'Release', tagger: '', createdAt: 0 }],
  remotes: [{ name: 'origin', url: 'https://git.example.invalid/x.git', pushUrl: 'https://git.example.invalid/x.git' }], worktrees: [], truncated: false, ...extra });
const ok = { message: 'done', recovery: null, conflicts: false };

beforeEach(() => { vi.clearAllMocks(); });

describe('destructive confirmations', () => {
  it('requires acknowledgement and sends the confirmed branch object', async () => {
    vi.mocked(gitApi.deleteBranch).mockResolvedValue(ok);
    const onOutcome = vi.fn();
    render(<BranchesPanel projectId="p" repo={repo} status={status()} refs={refs()} onOutcome={onOutcome} onCompare={vi.fn()} />);
    expect(screen.getByRole('button', { name: /切換到 busy/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '刪除 branch busy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刪除 branch topic' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '刪除 branch' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/自動建立復原點/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('即使尚未合併也刪除（-D）'));
    fireEvent.click(within(dialog).getByLabelText(/我了解 app 的 branch topic/));
    fireEvent.click(within(dialog).getByRole('button', { name: '強制刪除 branch' }));
    await waitFor(() => expect(gitApi.deleteBranch).toHaveBeenCalledWith('p', { repoId: 'r1', name: 'topic', expected: branch('topic').oid, force: true }));
    expect(onOutcome).toHaveBeenCalledWith(ok);
  });

  it('cancelling a confirmation sends nothing', () => {
    render(<BranchesPanel projectId="p" repo={repo} status={status()} refs={refs()} onOutcome={vi.fn()} onCompare={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '刪除 branch topic' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gitApi.deleteBranch).not.toHaveBeenCalled();
  });

  it('blocks switching branches with uncommitted tracked changes', () => {
    render(<BranchesPanel projectId="p" repo={repo} status={status({ entries: [{ path: { path: 'x' }, staged: null, unstaged: 'modified', untracked: false, conflict: null, submodule: false, modes: ['100644', '100644', '100644'] }] })}
      refs={refs()} onOutcome={vi.fn()} onCompare={vi.fn()} />);
    expect(screen.getByText(/工作目錄有未提交的變更/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /切換到 topic/ })).toBeDisabled();
  });

  it('distinguishes reset modes and sends the confirmed HEAD', async () => {
    vi.mocked(gitApi.reset).mockResolvedValue(ok);
    const commit = { oid: 'b'.repeat(40), parents: [], author: '', email: '', authoredAt: 0, committer: '', committerEmail: '', committedAt: 0, message: 'Older', refs: [] };
    render(<ResetDialog projectId="p" repo={repo} status={status({ entries: [{ path: { path: 'x' }, staged: null, unstaged: 'modified', untracked: false, conflict: null, submodule: false, modes: ['100644', '100644', '100644'] }] })}
      commit={commit} onOutcome={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Hard'));
    expect(screen.getByText(/1 個 tracked 檔案的未提交變更會被覆蓋/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/我了解 main 會移到/));
    fireEvent.click(screen.getByRole('button', { name: 'Reset --hard' }));
    await waitFor(() => expect(gitApi.reset).toHaveBeenCalledWith('p', { repoId: 'r1', target: commit.oid, mode: 'hard', expectedHead: 'a'.repeat(40) }));
  });
});

describe('stash and tags', () => {
  it('drops the confirmed stash entry only', async () => {
    vi.mocked(gitApi.stashes).mockResolvedValue([{ index: 0, oid: 'c'.repeat(40), message: 'WIP on main', createdAt: 0 }]);
    vi.mocked(gitApi.stashDrop).mockResolvedValue(ok);
    render(<StashPanel projectId="p" repo={repo} status={status({ stashCount: 1 })} onOutcome={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '刪除 stash@{0}' }));
    fireEvent.click(screen.getByLabelText(/我了解此 stash/));
    fireEvent.click(screen.getByRole('button', { name: '刪除 stash' }));
    await waitFor(() => expect(gitApi.stashDrop).toHaveBeenCalledWith('p', { repoId: 'r1', index: 0, expected: 'c'.repeat(40) }));
  });

  it('pushes one tag and asks before moving a published tag', async () => {
    vi.mocked(gitApi.remoteTags).mockResolvedValue([{ name: 'v1', oid: 'e'.repeat(40) }]);
    vi.mocked(gitApi.pushTag).mockResolvedValue(ok);
    render(<TagsPanel projectId="p" repo={repo} refs={refs()} onOutcome={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '檢查遠端 tag' }));
    expect(await screen.findByText(/遠端指向不同/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '推送 tag v1 到 origin' }));
    expect(screen.getByRole('dialog', { name: '移動已發布的 tag v1？' })).toBeInTheDocument();
    expect(gitApi.pushTag).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/遠端 tag 會改指向/));
    fireEvent.click(screen.getByRole('button', { name: '強制推送 tag' }));
    await waitFor(() => expect(gitApi.pushTag).toHaveBeenCalledWith('p', { repoId: 'r1', remote: 'origin', name: 'v1', force: true }));
  });
});

describe('recovery points', () => {
  it('lists coverage and asks again before moving HEAD', async () => {
    vi.mocked(gitApi.recoveryPoints).mockResolvedValue([{ id: '1-a', repoId: 'r1', repoRoot: '/synthetic/app', createdAt: 0, operation: 'reset --hard 到 bbbbbbb',
      branch: 'main', head: 'a'.repeat(40), snapshot: 'd'.repeat(40), untracked: [], headAfter: 'b'.repeat(40), notes: ['Ignored 檔案不在範圍內'],
      coverage: { head: true, index: true, trackedFiles: true, untrackedFiles: 0, refs: [] } }]);
    vi.mocked(gitApi.restoreRecovery).mockRejectedValueOnce(new Error('操作後已有新的 commit 或 HEAD 已移動；確認後才會移回')).mockResolvedValueOnce(['HEAD 已回到 aaaaaaa']);
    const onRestored = vi.fn();
    render(<RecoveryPanel projectId="p" repo={repo} revision="x" onRestored={onRestored} />);
    fireEvent.click(await screen.findByRole('button', { name: /檢視復原點/ }));
    expect(screen.getByText('index（已暫存內容）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '還原' }));
    fireEvent.click(await screen.findByRole('button', { name: '仍要移回 HEAD 並還原' }));
    await waitFor(() => expect(gitApi.restoreRecovery).toHaveBeenLastCalledWith('p', 'r1', '1-a', true));
    expect(onRestored).toHaveBeenCalledWith({ tone: 'success', text: 'HEAD 已回到 aaaaaaa' });
  });
});
