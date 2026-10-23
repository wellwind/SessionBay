import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitBox } from './CommitBox';
import { SyncPanel, defaultPullStrategy } from './SyncPanel';
import { gitApi } from './git-api';
import type { PushPlan, RepoInfo, RepoStatus } from './types';

vi.mock('./git-api', () => ({ gitApi: { commitPreview: vi.fn(), commit: vi.fn(), pushPlan: vi.fn(), fetch: vi.fn(), pull: vi.fn(), push: vi.fn(), cancelOperation: vi.fn() } }));

const repo: RepoInfo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '/synthetic/app/.git', commonDir: '/synthetic/app/.git', linkedWorktree: false, enclosesProject: false };
const status = (extra: Partial<RepoStatus> = {}): RepoStatus => ({
  repoId: 'r1', revision: 'x', operation: null, stashCount: 0, truncated: false,
  branch: { oid: 'a'.repeat(40), head: 'main', upstream: null, ahead: 0, behind: 0, unborn: false },
  entries: [
    { path: { path: 'staged.txt' }, staged: 'added', unstaged: null, untracked: false, conflict: null, submodule: false, modes: ['000000', '100644', '100644'] },
    { path: { path: 'loose.txt' }, staged: null, unstaged: 'modified', untracked: false, conflict: null, submodule: false, modes: ['100644', '100644', '100644'] },
  ], ...extra,
});
const plan = (extra: Partial<PushPlan> = {}): PushPlan => ({
  branch: 'main', head: 'b'.repeat(40), upstreamRemote: null, upstreamBranch: null, pushRemote: null, remotes: ['origin', 'fork'],
  ahead: 0, behind: 0, hooks: ['pre-push'], followTagsConfigured: true, pullRebaseConfigured: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitApi.pushPlan).mockResolvedValue(plan());
});

describe('commit preview', () => {
  it('shows exactly the index and commits with the reviewed token', async () => {
    vi.mocked(gitApi.commitPreview).mockResolvedValue({ repoId: 'r1', branch: 'main', head: 'a'.repeat(40), truncated: false, token: 'tok',
      files: [{ status: 'A', path: { path: 'staged.txt' }, oldPath: null }], hooks: ['pre-commit'], signing: 'ssh', author: 'Synthetic <s@example.invalid>', operation: null });
    vi.mocked(gitApi.commit).mockResolvedValue({ oid: 'c'.repeat(40), summary: 'Add file', output: '' });
    const onDone = vi.fn();
    render(<CommitBox projectId="p" repo={repo} status={status()} onDone={onDone} />);
    const button = screen.getByRole('button', { name: '檢視並 Commit' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Commit 訊息'), { target: { value: 'Add file' } });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: '確認建立 commit' });
    expect(within(dialog).getByText('staged.txt')).toBeInTheDocument();
    expect(within(dialog).queryByText('loose.txt')).not.toBeInTheDocument();
    expect(within(dialog).getByText('會執行：pre-commit')).toBeInTheDocument();
    expect(within(dialog).getByText(/依 Git 設定簽章（ssh）/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '建立 commit' }));
    await waitFor(() => expect(gitApi.commit).toHaveBeenCalledWith('p', 'r1', 'Add file', 'tok'));
    expect(onDone).toHaveBeenCalledWith(`已建立 commit ${'c'.repeat(7)}：Add file`);
  });

  it('keeps a hook failure visible in the dialog', async () => {
    vi.mocked(gitApi.commitPreview).mockResolvedValue({ repoId: 'r1', branch: null, head: null, truncated: false, token: 'tok', files: [], hooks: [], signing: null, author: null, operation: null });
    vi.mocked(gitApi.commit).mockRejectedValue(new Error('Git hook 失敗：lint failed'));
    render(<CommitBox projectId="p" repo={repo} status={status()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Commit 訊息'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '檢視並 Commit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/detached HEAD/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '建立 commit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('lint failed');
  });
});

describe('sync panel', () => {
  it('confirms the push destination and never offers implicit tags', async () => {
    vi.mocked(gitApi.push).mockResolvedValue({ output: '', confirmed: true, pushed: 'b'.repeat(40) });
    const onDone = vi.fn();
    render(<SyncPanel projectId="p" repo={repo} status={status()} refs={null} onDone={onDone} />);
    await waitFor(() => expect(gitApi.pushPlan).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Push/ }));
    const dialog = await screen.findByRole('dialog', { name: '推送 branch' });
    expect(within(dialog).getByLabelText(/設為 upstream/)).toBeChecked();
    expect(within(dialog).getByText(/不會推送任何 tag（已覆寫 push.followTags）/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Remote'), { target: { value: 'fork' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '推送' }));
    await waitFor(() => expect(gitApi.push).toHaveBeenCalledWith('p', { repoId: 'r1', remote: 'fork', localBranch: 'main', remoteBranch: 'main', setUpstream: true }));
    expect(onDone).toHaveBeenCalledWith({ tone: 'success', text: expect.stringContaining('fork/main') });
  });

  it('disables push on detached HEAD and pulls with the chosen strategy', async () => {
    vi.mocked(gitApi.pushPlan).mockResolvedValue(plan({ upstreamRemote: 'origin', upstreamBranch: 'main', pullRebaseConfigured: 'true' }));
    vi.mocked(gitApi.pull).mockResolvedValue({ output: '' });
    const view = render(<SyncPanel projectId="p" repo={repo} status={status({ branch: { oid: 'a', head: null, upstream: null, ahead: 0, behind: 0, unborn: false } })} refs={null} onDone={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Push/ })).toBeDisabled();
    view.unmount();
    render(<SyncPanel projectId="p" repo={repo} status={status({ branch: { oid: 'a', head: 'main', upstream: 'origin/main', ahead: 1, behind: 2, unborn: false } })} refs={null} onDone={vi.fn()} />);
    expect(await screen.findByText('已分叉')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pull/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pull 遠端變更' });
    await waitFor(() => expect(within(dialog).getByLabelText(/Rebase/)).toBeChecked());
    fireEvent.click(within(dialog).getByLabelText(/Merge/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(gitApi.pull).toHaveBeenCalledWith('p', 'r1', 'merge'));
  });

  it('maps pull.rebase config to an explicit default', () => {
    expect(defaultPullStrategy(null)).toBe('fastForwardOnly');
    expect(defaultPullStrategy('false')).toBe('merge');
    expect(defaultPullStrategy('merges')).toBe('rebase');
  });
});
