import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreesPanel } from './WorktreesPanel';
import { gitApi } from './git-api';
import type { Branch, Refs, RepoInfo, RepoStatus, WorktreeStatus } from './types';

vi.mock('./git-api', () => ({ gitApi: { worktrees: vi.fn(), worktreeAdd: vi.fn(), worktreeRemove: vi.fn(), worktreePrune: vi.fn() } }));

const repo: RepoInfo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false };
const status: RepoStatus = { repoId: 'r1', revision: 'x', operation: null, stashCount: 0, truncated: false, entries: [],
  branch: { oid: 'a'.repeat(40), head: 'main', upstream: null, ahead: 0, behind: 0, unborn: false } };
const branch = (name: string): Branch => ({ name, fullName: `refs/heads/${name}`, remote: false, oid: name.padEnd(40, '1'), upstream: null,
  ahead: null, behind: null, upstreamGone: false, current: name === 'main', worktree: null, subject: '', committedAt: 0 });
const refs: Refs = { branches: [branch('main'), branch('topic'), branch('used')], tags: [], remotes: [], worktrees: [], truncated: false };
const worktree = (path: string, extra: Partial<WorktreeStatus>): WorktreeStatus => ({ path, head: 'a'.repeat(40), branch: null,
  main: false, current: false, locked: false, prunable: false, dirty: false, ...extra });
const list = [
  worktree('/synthetic/app', { branch: 'main', main: true, current: true }),
  worktree('/synthetic/app.worktrees/used', { branch: 'used', dirty: true }),
  worktree('/synthetic/app.worktrees/gone', { branch: 'gone', prunable: true, dirty: null }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitApi.worktrees).mockResolvedValue(list);
});

describe('worktree management', () => {
  it('lists checkouts with their state and only offers safe actions', async () => {
    const onOpen = vi.fn();
    render(<WorktreesPanel projectId="p" repo={repo} status={status} refs={refs} onOutcome={vi.fn()} onOpen={onOpen} />);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('主要')).toBeInTheDocument();
    expect(within(items[0]).queryByRole('button', { name: /移除/ })).toBeNull();
    expect(within(items[1]).getByText('有變更')).toBeInTheDocument();
    expect(within(items[2]).getByText('已失效')).toBeInTheDocument();
    expect(within(items[2]).queryByRole('button')).toBeNull();
    fireEvent.click(within(items[1]).getByRole('button', { name: '開啟 used 為專案' }));
    expect(onOpen).toHaveBeenCalledWith('/synthetic/app.worktrees/used', false);
    expect(screen.getByRole('button', { name: '清理失效紀錄' })).toBeInTheDocument();
  });

  it('creates a new branch worktree and opens it to start work', async () => {
    const onOpen = vi.fn(); const onOutcome = vi.fn();
    vi.mocked(gitApi.worktreeAdd).mockResolvedValue({ path: '/synthetic/app.worktrees/feature-x', branch: 'feature/x' });
    render(<WorktreesPanel projectId="p" repo={repo} status={status} refs={refs} onOutcome={onOutcome} onOpen={onOpen} />);
    await screen.findAllByRole('listitem');
    fireEvent.change(screen.getByLabelText('Branch 名稱'), { target: { value: 'feature/x' } });
    fireEvent.click(screen.getByRole('button', { name: '建立 worktree' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('/synthetic/app.worktrees/feature-x', true));
    expect(gitApi.worktreeAdd).toHaveBeenCalledWith('p', { repoId: 'r1', branch: 'feature/x', create: true, base: null, path: null });
  });

  it('offers only branches without a checkout when reusing one', async () => {
    render(<WorktreesPanel projectId="p" repo={repo} status={status} refs={refs} onOutcome={vi.fn()} />);
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByLabelText('既有 branch'));
    const options = within(screen.getByLabelText('Branch')).getAllByRole('option').map(option => option.textContent);
    expect(options).toEqual(['topic']);
  });

  it('stashes a dirty checkout only after an explicit acknowledgement', async () => {
    vi.mocked(gitApi.worktreeRemove).mockResolvedValue({ message: '已移除', recovery: null, conflicts: false });
    render(<WorktreesPanel projectId="p" repo={repo} status={status} refs={refs} onOutcome={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除 worktree used' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('存成 stash');
    const confirm = within(dialog).getByRole('button', { name: 'Stash 變更並移除' });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(gitApi.worktreeRemove).toHaveBeenCalledWith('p', { repoId: 'r1', path: '/synthetic/app.worktrees/used', stash: true }));
  });
});
