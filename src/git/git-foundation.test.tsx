import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GitWorkbench from './GitWorkbench';
import { gitApi } from './git-api';
import type { RepoInfo, RepoStatus } from './types';

vi.mock('./git-api', () => {
  // Panels beyond G1 call other operations; leave those pending.
  const known = { discover: vi.fn(), cancelDiscovery: vi.fn(), status: vi.fn() };
  const gitApi = new Proxy(known, { get: (target, key: string) => key in target ? target[key as keyof typeof target] : () => new Promise(() => undefined) });
  return { gitApi, gitRequest: vi.fn() };
});

const repo = (id: string, relativePath: string, extra: Partial<RepoInfo> = {}): RepoInfo => ({
  id, name: 'app', root: `/synthetic/${relativePath}`, relativePath, gitDir: `/synthetic/${relativePath}/.git`,
  commonDir: `/synthetic/${relativePath}/.git`, linkedWorktree: false, enclosesProject: false, ...extra,
});
const status = (repoId: string, extra: Partial<RepoStatus> = {}): RepoStatus => ({
  repoId, revision: `${repoId}:1`, operation: null, stashCount: 0, truncated: false,
  branch: { oid: 'a'.repeat(40), head: 'main', upstream: 'origin/main', ahead: 1, behind: 0, unborn: false },
  entries: [], ...extra,
});

function Host(props: { visible?: boolean }) {
  const host = document.createElement('div');
  document.body.append(host);
  return <GitWorkbench projectId="p" visible={props.visible ?? true} active={false} sidebarVisible sidebarHost={host}
    tabsHost={null} documentHost={null} onActivate={vi.fn()} onEmpty={vi.fn()} onHideSidebar={vi.fn()} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  vi.mocked(gitApi.cancelDiscovery).mockResolvedValue(null);
});

describe('Git foundation panel', () => {
  it('offers no Git actions without a usable executable or repository', async () => {
    vi.mocked(gitApi.discover).mockResolvedValueOnce({ state: 'unavailable', message: '找不到 Git 執行檔' });
    const view = render(<Host />);
    expect(await screen.findByText('找不到 Git 執行檔')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    view.unmount();

    vi.mocked(gitApi.discover).mockResolvedValueOnce({ state: 'ready', gitVersion: '2.55.0', repos: [], truncated: false, cancelled: false,
      issues: [{ kind: 'broken', relativePath: '', message: 'fatal: not a git repository' }] });
    render(<Host />);
    expect(await screen.findByText('此專案沒有可操作的 Git 工作目錄。')).toBeInTheDocument();
    expect(screen.getByText('1 個未提供操作的位置')).toBeInTheDocument();
    expect(gitApi.status).not.toHaveBeenCalled();
  });

  it('keeps same-named repositories separate with their own summaries', async () => {
    vi.mocked(gitApi.discover).mockResolvedValue({ state: 'ready', gitVersion: '2.55.0', truncated: true, cancelled: false, issues: [],
      repos: [repo('r1', 'a/app'), repo('r2', 'b/app', { linkedWorktree: true })] });
    vi.mocked(gitApi.status).mockImplementation(async (_p, id) => id === 'r1'
      ? status('r1', { entries: [{ path: { path: 'src/x.ts' }, staged: null, unstaged: 'modified', untracked: false, conflict: null, submodule: false, modes: ['100644', '100644', '100644'] }] })
      : status('r2', { branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 2, unborn: false }, operation: 'merge' }));
    render(<Host />);
    const group = await screen.findByRole('radiogroup', { name: '選擇 repository' });
    const options = within(group).getAllByRole('radio');
    expect(options).toHaveLength(2);
    await waitFor(() => expect(options[0]).toHaveTextContent('1 項變更'));
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[1]).toHaveTextContent('worktree');
    expect(options[1]).toHaveTextContent('合併進行中');
    expect(options[1]).toHaveTextContent('detached HEAD');
    expect(screen.getByText(/子目錄掃描已在時間上限停止/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '繼續掃描' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/x\.ts，已修改/ })).toBeInTheDocument();

    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('工作目錄沒有變更。')).toBeInTheDocument();
  });

  it('polls the selected repository and ignores stale responses', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(gitApi.discover).mockResolvedValue({ state: 'ready', gitVersion: '2.55.0', truncated: false, cancelled: false, issues: [], repos: [repo('r1', '')] });
      let slow!: (value: RepoStatus) => void;
      // Call 1 is clean, call 2 stalls, every later poll sees the new file.
      let calls = 0;
      vi.mocked(gitApi.status).mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(status('r1'));
        if (calls === 2) return new Promise(resolve => { slow = resolve; });
        return Promise.resolve(status('r1', { revision: 'r1:3', entries: [{ path: { path: 'new.txt' }, staged: null, unstaged: null, untracked: true, conflict: null, submodule: false, modes: ['000000', '000000', '100644'] }] }));
      });
      render(<Host />);
      const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      await flush();
      expect(screen.getByText('工作目錄沒有變更。')).toBeInTheDocument();
      await flush(3100);
      await flush(3100);
      expect(screen.getByRole('button', { name: /new\.txt，未追蹤/ })).toBeInTheDocument();
      await act(async () => { slow(status('r1', { revision: 'r1:2' })); });
      expect(screen.getByRole('button', { name: /new\.txt，未追蹤/ })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

describe('discovery scope', () => {
  it('stays quiet at the depth scope, offers to keep scanning when truncated, and adds repos of open files', async () => {
    const base = { state: 'ready' as const, gitVersion: '2.55.0', issues: [], cancelled: false, scannedDepth: 5 };
    vi.mocked(gitApi.discover).mockResolvedValueOnce({ ...base, truncated: false, limitReason: null, repos: [repo('r1', 'app')] });
    vi.mocked(gitApi.status).mockImplementation(async (_p, id) => status(id));
    const deep = repo('r2', 'a/b/c/d/e/f/deep');
    vi.mocked(gitApi).includePath = vi.fn().mockResolvedValue({ ...base, truncated: false, repos: [repo('r1', 'app'), deep] });
    const host = document.createElement('div');
    document.body.append(host);
    const view = render(<GitWorkbench projectId="p" visible active={false} sidebarVisible sidebarHost={host} tabsHost={null} documentHost={null}
      onActivate={vi.fn()} onEmpty={vi.fn()} onHideSidebar={vi.fn()} openFiles={['app/src/x.ts']} />);
    await screen.findByRole('radiogroup', { name: '選擇 repository' });
    expect(screen.queryByText(/上限停止/)).not.toBeInTheDocument();
    expect(gitApi.includePath).not.toHaveBeenCalled();
    view.rerender(<GitWorkbench projectId="p" visible active={false} sidebarVisible sidebarHost={host} tabsHost={null} documentHost={null}
      onActivate={vi.fn()} onEmpty={vi.fn()} onHideSidebar={vi.fn()} openFiles={['app/src/x.ts', 'a/b/c/d/e/f/deep/main.rs']} />);
    await waitFor(() => expect(gitApi.includePath).toHaveBeenCalledWith('p', 'a/b/c/d/e/f/deep/main.rs'));
    expect(await screen.findAllByRole('radio')).toHaveLength(2);

    vi.mocked(gitApi.discover).mockResolvedValueOnce({ ...base, truncated: true, limitReason: 'time', repos: [repo('r1', 'app')] });
    fireEvent.click(screen.getByRole('button', { name: '重新整理 Git' }));
    expect(await screen.findByText(/子目錄掃描已在時間上限停止/)).toBeInTheDocument();
    vi.mocked(gitApi.discover).mockResolvedValueOnce({ ...base, truncated: false, repos: [repo('r1', 'app')] });
    fireEvent.click(screen.getByRole('button', { name: '繼續掃描' }));
    await waitFor(() => expect(gitApi.discover).toHaveBeenLastCalledWith('p', true));
  });
});
