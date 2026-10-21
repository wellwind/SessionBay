import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitPanel } from './components/GitPanel';
import { branchLabel, hasOperableRepository, pickRepository, repositoryLocation, useGitWorkbench } from './git';
import type { GitDiscovery, GitRepository, GitStatusSummary } from './types';

const repo = (id: string, extra: Partial<GitRepository> = {}): GitRepository => ({
  id, name: 'app', worktreeRoot: `/synthetic/${id}/app`, gitDir: `/synthetic/${id}/app/.git`, commonDir: `/synthetic/${id}/app/.git`,
  kind: 'primary', superproject: null, relativePath: `${id}/app`, containsProject: false, parentId: null, ...extra,
});
const discovery = (repositories: GitRepository[], extra: Partial<GitDiscovery> = {}): GitDiscovery => ({
  projectRoot: '/synthetic', gitAvailable: true, gitVersion: 'git version 2.47.0',
  root: { path: '/synthetic', state: 'notRepository', repository: null, gitDir: null, message: null },
  repositories, issues: [], scannedDirectories: 3, truncated: false, cancelled: false, ...extra,
});
const status = (repoId: string, extra: Partial<GitStatusSummary> = {}): GitStatusSummary => ({
  repoId, worktreeRoot: '', branch: 'main', oid: 'abcdef1234', detached: false, unborn: false, upstream: 'origin/main',
  ahead: 1, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, limited: false, ...extra,
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('git helpers', () => {
  it('offers Git only for validated work trees', () => {
    expect(hasOperableRepository(null)).toBe(false);
    expect(hasOperableRepository(discovery([]))).toBe(false);
    expect(hasOperableRepository(discovery([repo('a')], { gitAvailable: false }))).toBe(false);
    expect(hasOperableRepository(discovery([repo('a')]))).toBe(true);
  });
  it('keeps selection by identity and defaults to the containing repo', () => {
    const repos = [repo('a'), repo('b', { containsProject: true })];
    expect(pickRepository(repos, null)).toBe('b');
    expect(pickRepository(repos, 'a')).toBe('a');
    expect(pickRepository(repos, 'gone')).toBe('b');
    expect(pickRepository([], 'a')).toBeNull();
  });
  it('formats locations and branch states', () => {
    expect(repositoryLocation(repo('a', { relativePath: '' }))).toBe('專案根目錄');
    expect(repositoryLocation(repo('a', { relativePath: null }))).toBe('/synthetic/a/app');
    expect(branchLabel(status('a', { detached: true, branch: null }))).toBe('detached abcdef1');
    expect(branchLabel(status('a', { unborn: true }))).toContain('尚無 commit');
  });
});

describe('GitPanel', () => {
  it('lists same-named repositories separately with their own summaries and issues', () => {
    const select = vi.fn();
    render(<GitPanel git={{
      discovery: discovery([repo('a'), repo('b', { kind: 'submodule' })], {
        issues: [{ path: '/synthetic/server.git', state: 'bare', repository: null, gitDir: null, message: null }] }),
      scanning: false, error: null, selectedId: 'a', select, refresh: vi.fn(), cancel: vi.fn(),
      statuses: { a: status('a', { unstaged: 2, untracked: 1 }), b: { error: 'Git status 逾時' } },
    }} />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveTextContent('未暫存 2、未追蹤 1');
    expect(options[0]).toHaveTextContent('↑1 ↓0');
    expect(options[1]).toHaveTextContent('submodule（未支援操作）');
    expect(options[1]).toHaveTextContent('Git status 逾時');
    expect(screen.getByText(/裸 repository/)).toBeInTheDocument();
    fireEvent.keyDown(options[1], { key: 'Enter' });
    expect(select).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('button', { name: /commit|暫存/ })).not.toBeInTheDocument();
  });
  it('shows a cancel control while scanning and a truncation note', () => {
    const cancel = vi.fn();
    render(<GitPanel git={{ discovery: discovery([], { truncated: true }), scanning: true, error: null, statuses: {},
      selectedId: null, select: vi.fn(), refresh: vi.fn(), cancel }} />);
    fireEvent.click(screen.getByRole('button', { name: '停止探測' }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByText(/已達探測上限/)).toBeInTheDocument();
  });
});

describe('useGitWorkbench', () => {
  it('discovers, loads per-repo status and refreshes on focus without touching runtimes', async () => {
    const discover = vi.spyOn(api, 'discoverGit').mockResolvedValue(discovery([repo('a'), repo('b')]));
    const gitStatus = vi.spyOn(api, 'gitStatus').mockImplementation(async (_p, root) => status(root.includes('/a/') ? 'a' : 'b'));
    vi.spyOn(api, 'cancelGitDiscovery').mockResolvedValue(false);
    const stop = vi.spyOn(api, 'stop');
    const { result } = renderHook(() => useGitWorkbench('p1', true));
    await waitFor(() => expect(Object.keys(result.current.statuses)).toHaveLength(2));
    expect(discover).toHaveBeenCalledTimes(1);
    act(() => result.current.select('b'));
    expect(result.current.selectedId).toBe('b');
    vi.useFakeTimers();
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    vi.useRealTimers();
    await waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(4));
    expect(discover).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });
  it('treats a malformed discovery response as an error instead of crashing', async () => {
    vi.spyOn(api, 'discoverGit').mockResolvedValue(1 as unknown as GitDiscovery);
    vi.spyOn(api, 'cancelGitDiscovery').mockResolvedValue(false);
    const { result } = renderHook(() => useGitWorkbench('p1', false));
    await waitFor(() => expect(result.current.error).toContain('格式無效'));
    expect(result.current.discovery).toBeNull();
    expect(result.current.selectedId).toBeNull();
  });
  it('drops stale results after switching project and cancels the old scan', async () => {
    let resolveFirst: (value: GitDiscovery) => void = () => {};
    vi.spyOn(api, 'discoverGit').mockImplementation(project => project === 'p1'
      ? new Promise(resolve => { resolveFirst = resolve; })
      : Promise.resolve(discovery([])));
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status('a'));
    const cancel = vi.spyOn(api, 'cancelGitDiscovery').mockResolvedValue(true);
    const { result, rerender } = renderHook(({ id }) => useGitWorkbench(id, false), { initialProps: { id: 'p1' } });
    rerender({ id: 'p2' });
    expect(cancel).toHaveBeenCalledWith('p1');
    await act(async () => { resolveFirst(discovery([repo('a')])); });
    await waitFor(() => expect(result.current.scanning).toBe(false));
    expect(result.current.discovery?.repositories).toEqual([]);
  });
});
