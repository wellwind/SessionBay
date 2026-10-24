import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { projectColorIndex, projectColorSlots, projectInitials } from './project-identity';
import { bufferTail, registerTerminalTail, readTerminalTail, TAIL_LINE_CHARS } from './terminal-tail';
import type { Pane, PaneState, Project, Workspace } from './types';
import { repoForCwd } from './use-pane-branches';
import { filterOverview, overviewItems, paneAttention, sortOverview, defaultOverviewFilter } from './workspace-overview';

vi.mock('./git/git-api', () => ({
  gitApi: {
    discover: vi.fn().mockResolvedValue({ state: 'ready', gitVersion: '2.55.0', repos: [], issues: [], truncated: false, cancelled: false }),
    status: vi.fn(),
  },
}));

const pane = (id: string, projectId: string | null, state: PaneState = 'running', kind: Pane['kind'] = 'shell'): Pane =>
  ({ id, kind, title: `Title ${id}`, projectId, cwd: `/synthetic/${projectId ?? 'home'}`, state, runtimeId: `runtime-${id}` });
const project = (id: string, name: string): Project => ({
  id, name, path: `/synthetic/${id}`, launchPath: null, exists: true, pinned: false, curated: true,
  sessionCount: 0, updatedAt: null, agents: [],
});
function workspace(...panes: Pane[]): Workspace {
  return {
    version: 1,
    tabs: panes.map(item => ({ id: `tab-${item.id}`, projectId: item.projectId, name: item.title,
      layout: { kind: 'pane', paneId: item.id }, focusedPaneId: item.id })),
    panes: Object.fromEntries(panes.map(item => [item.id, item])),
    activeTabByProject: {},
  } as Workspace;
}

describe('overview model', () => {
  it('derives attention only from lifecycle and explicit reports', () => {
    expect(paneAttention(pane('a', 'p'), ['awaitingInput'])).toBe('input');
    expect(paneAttention(pane('a', 'p'), ['terminalQuestion'])).toBe('input');
    expect(paneAttention(pane('a', 'p'), ['busy'])).toBe('working');
    // A live process with no report is plain "running", never "working".
    expect(paneAttention(pane('a', 'p'), [])).toBe('idle');
    expect(paneAttention(pane('a', 'p', 'failed'), [])).toBe('error');
    expect(paneAttention(pane('a', 'p', 'disconnected'), [])).toBe('error');
    expect(paneAttention(pane('a', 'p', 'exited'), [])).toBe('ended');
    expect(paneAttention(pane('a', 'p', 'starting'), [])).toBe('other');
    // A stale input report cannot make an exited pane look like it awaits a reply.
    expect(paneAttention(pane('a', 'p', 'exited'), ['awaitingInput'])).toBe('ended');
  });

  it('builds items across projects and the temporary workspace, then filters and sorts', () => {
    const ws = workspace(pane('a', 'p1'), pane('b', 'p2', 'exited'), pane('c', null), pane('d', 'p2', 'running', 'codex'));
    const items = overviewItems(ws, [project('p1', 'Alpha'), project('p2', 'Beta')],
      item => item.id === 'd' ? 'awaitingPermission' : '');
    expect(items.map(item => [item.paneId, item.projectName, item.attention])).toEqual([
      ['a', 'Alpha', 'idle'], ['b', 'Beta', 'ended'], ['c', '臨時 Terminal', 'idle'], ['d', 'Beta', 'input'],
    ]);
    expect(items.find(item => item.paneId === 'd')).toMatchObject({ kindLabel: expect.any(String), statusText: '等待權限確認' });
    expect(items.find(item => item.paneId === 'b')?.statusText).toBe('已退出 · 未知結束碼');
    expect(sortOverview(items, 'attention').map(item => item.paneId)).toEqual(['d', 'a', 'c', 'b']);
    expect(sortOverview(items, 'project').map(item => item.paneId)).toEqual(['a', 'd', 'b', 'c']);
    expect(filterOverview(items, { ...defaultOverviewFilter, attention: 'attention' }).map(item => item.paneId)).toEqual(['d']);
    expect(filterOverview(items, { ...defaultOverviewFilter, attention: 'ended' }).map(item => item.paneId)).toEqual(['b']);
    expect(filterOverview(items, { ...defaultOverviewFilter, projectId: null }).map(item => item.paneId)).toEqual(['c']);
    expect(filterOverview(items, { ...defaultOverviewFilter, kind: 'codex' }).map(item => item.paneId)).toEqual(['d']);
  });

  it('reads a bounded tail up to the cursor and trims blank rows', () => {
    const rows = ['first', '', 'second', 'x'.repeat(400), 'prompt $', '', ''];
    const buffer = { baseY: 2, cursorY: 4, getLine: (y: number) => ({ translateToString: () => rows[y] ?? '' }) };
    const tail = bufferTail(buffer, 3);
    expect(tail).toEqual(['second', `${'x'.repeat(TAIL_LINE_CHARS - 1)}…`, 'prompt $']);
    expect(bufferTail({ baseY: 0, cursorY: 3, getLine: () => ({ translateToString: () => '' }) }, 6)).toEqual([]);
    const unregister = registerTerminalTail('pane-tail', () => ['live']);
    expect(readTerminalTail('pane-tail')).toEqual(['live']);
    unregister();
    expect(readTerminalTail('pane-tail')).toEqual([]);
  });

  it('gives projects stable initials and colors, and matches the deepest repository', () => {
    expect(projectInitials('session-bay')).toBe('SB');
    expect(projectInitials('api')).toBe('AP');
    expect(projectInitials('工作台介面')).toBe('工');
    expect(projectInitials('  ')).toBe('?');
    expect(projectColorIndex('project-a')).toBe(projectColorIndex('project-a'));
    expect(projectColorIndex(null)).toBe(-1);
    const slots = projectColorSlots(Array.from({ length: 8 }, (_, index) => `synthetic-${index}`));
    expect(new Set(slots.values()).size).toBe(8);
    expect(projectColorSlots(['b', 'a'])).toEqual(projectColorSlots(['a', 'b']));
    expect(projectColorSlots(Array.from({ length: 10 }, (_, index) => `p${index}`)).size).toBe(10);
    const repos = [{ id: 'outer', root: '/synthetic/p' }, { id: 'inner', root: '/synthetic/p/packages/ui' }] as never[];
    expect(repoForCwd(repos, '/synthetic/p/packages/ui/src')).toMatchObject({ id: 'inner' });
    expect(repoForCwd(repos, '/synthetic/p/docs')).toMatchObject({ id: 'outer' });
    expect(repoForCwd(repos, '/synthetic/pother')).toBeUndefined();
    expect(repoForCwd([{ id: 'win', root: 'C:\\synthetic\\p' }] as never[], 'C:\\synthetic\\p\\src')).toMatchObject({ id: 'win' });
  });
});

describe('WorkspaceOverview', () => {
  it('renders identity, status and tails, offers reply for input, filters and moves with arrows', () => {
    const open = vi.fn();
    const ws = workspace(pane('a', 'p1'), pane('b', 'p2', 'failed'));
    const unregister = registerTerminalTail('a', () => ['$ npm test', 'ok 42']);
    render(<WorkspaceOverview workspace={ws} projects={[project('p1', 'Alpha'), project('p2', 'Beta')]} visible onOpen={open} />);
    const list = screen.getByRole('list', { name: '開啟中的工作' });
    const cards = within(list).getAllByRole('button', { name: /^放大 / });
    // Attention first: the failed pane sorts ahead of the running shell.
    expect(cards.map(card => card.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^放大 Beta · Shell Title b，啟動／執行失敗/),
      expect.stringMatching(/^放大 Alpha · Shell Title a，執行中/),
    ]);
    expect(cards[1]).toHaveTextContent('ok 42');
    expect(cards[1].querySelector('.project-initials')).toHaveTextContent('AL');
    expect(screen.getByText('1 個需要處理')).toBeInTheDocument();
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: 'ArrowRight' });
    expect(cards[1]).toHaveFocus();
    fireEvent.click(cards[1]);
    expect(open).toHaveBeenCalledWith('a');
    fireEvent.change(screen.getByLabelText('專案篩選'), { target: { value: 'p2' } });
    expect(within(list).getAllByRole('button', { name: /^放大 / })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('狀態篩選'), { target: { value: 'ended' } });
    expect(screen.getByText('沒有符合篩選條件的工作。')).toBeInTheDocument();
    unregister();
  });

  it('shows an explicit reply action only for panes awaiting input, and an empty state', () => {
    const open = vi.fn();
    const { rerender } = render(<WorkspaceOverview workspace={workspace()} projects={[]} visible onOpen={open} />);
    expect(screen.getByText('目前沒有開啟中的工作')).toBeInTheDocument();
    rerender(<WorkspaceOverview workspace={workspace(pane('a', 'p1'))} projects={[project('p1', 'Alpha')]} visible onOpen={open} />);
    expect(screen.queryByRole('button', { name: /^放大並回覆/ })).toBeNull();
  });
});
