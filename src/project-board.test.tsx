import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ProjectBoard } from './components/ProjectBoard';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import type { RuntimeActivityStore } from './runtime-activity';
import type { KanbanBoard, Project, Session } from './types';
import { emptyWorkspace } from './workspace';
import { setLocale } from './i18n';
import { kanbanFixture, moveFixtureCard } from '../tests/fixtures/kanban';

vi.mock('./api', () => ({ api: {
  kanbanBoard: vi.fn(), setKanbanBoardEnabled: vi.fn(), moveKanbanCard: vi.fn(), reorderKanbanColumns: vi.fn(),
  createKanbanColumn: vi.fn(), renameKanbanColumn: vi.fn(), setKanbanColumnStage: vi.fn(), deleteKanbanColumn: vi.fn(),
}, errorMessage: (error: unknown) => String(error) }));
const project: Project = { id: 'p', name: 'Synthetic', path: '/synthetic/project', launchPath: null,
  curated: true, exists: true, pinned: false, agents: ['claude', 'codex'], sessionCount: 7, updatedAt: null };
const sessions: Session[] = Array.from({ length: 7 }, (_, i) => ({ id: `s-${i}`, sourceId: i % 2 ? 'source-codex' : 'source-claude',
  kind: i % 2 ? 'codex' : 'claude', externalId: `external-${i}`, title: `Session ${i}`, projectId: 'p', cwd: '/synthetic/project',
  updatedAt: '2026-10-28T10:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: null }));
let board: KanbanBoard;
beforeEach(() => {
  vi.clearAllMocks();
  setLocale('zh-TW');
  board = kanbanFixture('p', sessions);
  vi.mocked(api.kanbanBoard).mockImplementation(async () => structuredClone(board));
  vi.mocked(api.setKanbanBoardEnabled).mockImplementation(async (_, enabled) => { board.enabled = enabled; return structuredClone(board); });
  vi.mocked(api.moveKanbanCard).mockImplementation(async (id, columnId, position) => structuredClone(moveFixtureCard(board, id, columnId, position)));
  vi.mocked(api.reorderKanbanColumns).mockImplementation(async (_, ids) => { ids.forEach((id, position) => { board.columns.find(column => column.id === id)!.position = position; }); });
  vi.mocked(api.renameKanbanColumn).mockImplementation(async (id, name) => { const column = board.columns.find(column => column.id === id)!; column.name = name; return structuredClone(column); });
  vi.mocked(api.setKanbanColumnStage).mockImplementation(async (id, stage) => { const column = board.columns.find(column => column.id === id)!; column.stage = stage; return structuredClone(column); });
  vi.mocked(api.createKanbanColumn).mockImplementation(async (_, name, stage) => {
    const column = { ...board.columns[2], id: 'new-column', position: board.columns.length, defaultName: null, name, stage: stage ?? 'doing' };
    board.columns.push(column); return structuredClone(column);
  });
  vi.mocked(api.deleteKanbanColumn).mockImplementation(async id => { board.columns = board.columns.filter(column => column.id !== id); });
});
afterEach(() => { vi.restoreAllMocks(); setLocale('zh-TW'); });
const show = async (workspace = emptyWorkspace()) => {
  const view = render(<ProjectBoard project={project} workspace={workspace} />);
  await screen.findByRole('heading', { name: '未分類' });
  return view;
};
const list = (name: string) => screen.getByRole('list', { name });
const titles = (name: string) => within(list(name)).queryAllByRole('heading', { level: 4 }).map(el => el.textContent);

describe('project board', () => {
  it('loads before offering enable, then enables once through the explicit command', async () => {
    let resolve!: (value: KanbanBoard | null) => void;
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在載入看板');
    expect(screen.queryByRole('button', { name: '啟用看板' })).not.toBeInTheDocument();
    await act(async () => resolve(null));
    const enable = screen.getByRole('button', { name: '啟用看板' });
    fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByRole('heading', { name: '未分類' });
    expect(api.setKanbanBoardEnabled).toHaveBeenCalledExactlyOnceWith('p', true);
  });
  it('does not read or enable a board for an uncurated directory', () => {
    render(<ProjectBoard project={{ ...project, curated: false }} workspace={emptyWorkspace()} />);
    expect(screen.getByText('將此目錄加入專案即可啟用看板。')).toBeInTheDocument();
    expect(api.kanbanBoard).not.toHaveBeenCalled();
  });
  it('renders translated defaults, literal renamed columns, empty tasks, branches and updated times; hides archived tasks', async () => {
    board.columns[3].name = 'Custom review';
    board.cards[4].archived = true;
    await show();
    expect(screen.getByRole('heading', { name: '待辦' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Custom review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '未命名工作' })).toBeInTheDocument();
    expect(screen.getByTitle('feature/rate-limit-with-a-long-branch-name')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-28T10:00:00Z');
    expect(screen.queryByRole('heading', { name: 'Session 4' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/未執行/)).toHaveLength(6);
  });
  it('default names follow the UI language until renamed', async () => {
    board.columns[1].name = 'My todo';
    setLocale('en');
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} />);
    await screen.findByRole('heading', { name: 'Unsorted' });
    expect(screen.getByRole('heading', { name: 'My todo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
  });
  it('filters title, notes and session titles together with agent and attention', async () => {
    board.cards[0].title = 'Task title';
    await show();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜尋看板' }), { target: { value: 'TOKEN BUCKET' } });
    expect(titles('未分類')).toEqual(['Task title']);
    expect(titles('待辦')).toEqual([]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Session 0' } });
    expect(titles('未分類')).toEqual(['Task title']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
    expect(screen.getByText('沒有符合篩選條件的工作。')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(titles('未分類')).toEqual(['Session 5']);
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(titles('未分類')).toEqual([]);
  });
  it('subscribes to RuntimeActivity by session identity, including child sessions, without moving cards', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Open', kind: 'claude', state: 'running', cwd: '/synthetic/project', sessionId: 's-0', runtimeId: 'r' };
    board.cards[0].sessions.push({ session: { ...sessions[2], parentId: 's-0' }, branch: null });
    workspace.panes.child = { ...workspace.panes.a, id: 'child', sessionId: 's-2', runtimeId: 'child-runtime' };
    let store!: RuntimeActivityStore;
    function Capture() { store = useRuntimeActivity()!; return null; }
    render(<RuntimeActivityProvider><Capture /><ProjectBoard project={project} workspace={workspace} /></RuntimeActivityProvider>);
    await screen.findByRole('heading', { name: '未分類' });
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(titles('未分類')).toEqual([]);
    act(() => {
      store.begin('child', 'lease', 'child-runtime', false, false);
      store.observe('child', 'lease', { type: 'agentActivity', runtimeId: 'child-runtime', generation: 'test', revision: 1,
        observation: 'awaitingPermission', validForMs: 30_000 });
    });
    await waitFor(() => expect(titles('未分類')).toEqual(['Session 0']));
    expect(within(list('未分類')).getByText('Claude Code · 等待權限確認')).toBeInTheDocument();
    act(() => store.observe('child', 'lease', { type: 'agentActivity', runtimeId: 'child-runtime', generation: 'test', revision: 2,
      observation: 'busy', validForMs: 30_000 }));
    await waitFor(() => expect(titles('未分類')).toEqual([]));
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(within(list('未分類')).getByText('Claude Code · 工作中')).toBeInTheDocument();
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
  });
  it('supports the Move to menu with arrows, Escape, focus return and explicit destinations', async () => {
    await show(); const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: '移動「Session 0」…' });
    await user.click(opener);
    expect(screen.getByRole('menuitem', { name: '往下移' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}{End}{Enter}');
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'column-4', 1));
    await waitFor(() => expect(titles('完成')).toContain('Session 0'));
    await waitFor(() => expect(screen.getByRole('button', { name: '移動工作「Session 0」' })).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('已將「Session 0」移至完成，第 2 個位置。');
  });
  it('reorders using Alt arrows with the full catalog order even under filters and with archived tasks', async () => {
    board.cards.push({ ...board.cards[0], id: 'archived', title: 'Archived', archived: true, position: 1 });
    board.cards.find(card => card.id === 'card-5')!.position = 2;
    await show();
    const handle = screen.getByRole('button', { name: '移動工作「Session 0」' });
    fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true, isComposing: true });
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledWith('card-0', 'column-0', 2));
    await waitFor(() => expect(titles('未分類')).toEqual(['Session 5', 'Session 0']));
    fireEvent.keyDown(screen.getByRole('button', { name: '移動工作「Session 0」' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('card-0', 'column-1', 3));
  });
  it('retains the board and reports errors when a move fails; allows retry', async () => {
    vi.mocked(api.moveKanbanCard).mockRejectedValueOnce('Synthetic move failed');
    await show();
    fireEvent.keyDown(screen.getByRole('button', { name: '移動工作「Session 0」' }), { key: 'ArrowRight', altKey: true });
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic move failed');
    expect(titles('未分類')).toContain('Session 0');
    expect(screen.getByRole('button', { name: '移動工作「Session 0」' })).toBeEnabled();
  });
  it('does not confuse another indexed session with the same provider resume id', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Other session', kind: 'claude', state: 'failed',
      cwd: sessions[0].cwd!, sessionId: 'different-session', resumeId: sessions[0].externalId, runtimeId: 'r' };
    await show(workspace);
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(titles('未分類')).toEqual([]);
  });
  it('finds failed attached sessions through the attention filter without moving their tasks', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Failed session', kind: 'claude', state: 'failed',
      cwd: sessions[0].cwd!, sessionId: sessions[0].id, runtimeId: 'r' };
    await show(workspace);
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(titles('未分類')).toEqual(['Session 0']);
    expect(within(list('未分類')).getByText('Claude Code · 啟動／執行失敗')).toBeInTheDocument();
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
  });
  it('reorders columns using keyboard and announces the persisted position', async () => {
    await show();
    fireEvent.keyDown(screen.getByRole('button', { name: '排序 待辦' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.reorderKanbanColumns).toHaveBeenCalledExactlyOnceWith('p', ['column-0', 'column-2', 'column-1', 'column-3', 'column-4']));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已將「待辦」欄位移至第 3 個位置。'));
  });
  it('adds a column with doing as its default stage', async () => {
    await show(); fireEvent.click(screen.getByRole('button', { name: '新增欄位' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: '階段' })).toHaveValue('doing');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '欄位名稱' }), { target: { value: 'Quality' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '新增欄位' }));
    await screen.findByRole('heading', { name: 'Quality' });
    expect(api.createKanbanColumn).toHaveBeenCalledExactlyOnceWith('p', 'Quality', 'doing');
  });
  it('renames columns, sets stages and requires a deletion target', async () => {
    await show(); fireEvent.click(screen.getByRole('button', { name: '欄位設定：待辦' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '欄位名稱' }), { target: { value: 'Custom queue' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重新命名欄位' }));
    await waitFor(() => expect(api.renameKanbanColumn).toHaveBeenCalledWith('column-1', 'Custom queue'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '階段' })).toBeEnabled());
    fireEvent.change(within(dialog).getByRole('combobox', { name: '階段' }), { target: { value: 'review' } });
    await waitFor(() => expect(api.setKanbanColumnStage).toHaveBeenCalledWith('column-1', 'review'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: '將工作移至' })).toBeEnabled());
    expect(within(dialog).getByRole('button', { name: '刪除欄位' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: '將工作移至' }), { target: { value: 'column-0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除欄位' }));
    await waitFor(() => expect(api.deleteKanbanColumn).toHaveBeenCalledExactlyOnceWith('column-1', 'column-0'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it.each(['未分類', '完成'])('protects system column %s while allowing renaming and ordering', async name => {
    await show(); fireEvent.click(screen.getByRole('button', { name: `欄位設定：${name}` }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: '階段' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '刪除欄位' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: '欄位名稱' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: name === '未分類' ? '往右移' : '往左移' })).toBeEnabled();
  });
  it('refreshes intake without remounting', async () => {
    const view = await show();
    board.cards[0].title = 'Updated task';
    view.rerender(<ProjectBoard project={project} workspace={emptyWorkspace()} refreshToken={1} />);
    await screen.findByRole('heading', { name: 'Updated task' });
    view.unmount();
  });
  it('ignores a late background snapshot after an explicit move', async () => {
    const view = await show();
    const stale = structuredClone(board);
    let resolve!: (value: KanbanBoard) => void;
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    view.rerender(<ProjectBoard project={project} workspace={emptyWorkspace()} refreshToken={1} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '移動工作「Session 0」' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(titles('待辦')).toContain('Session 0'));
    await act(async () => resolve(stale));
    expect(titles('待辦')).toContain('Session 0');
    expect(titles('未分類')).not.toContain('Session 0');
  });
  it('supports pointer reordering within columns; Escape cancellation never saves', async () => {
    await show();
    const source = screen.getByRole('button', { name: '移動工作「Session 0」' });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = document.querySelector<HTMLElement>('[data-kanban-card="card-5"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId: 1, isPrimary: true }); fireEvent(source, event);
    };
    try {
      pointer('pointerdown', 5); pointer('pointermove', 180);
      expect(target).toHaveClass('kanban-drop-after');
      fireEvent.keyDown(window, { key: 'Escape' }); pointer('pointerup', 180);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledWith('card-0', 'column-0', 1));
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
  it.each(['card', 'empty'])('drops across columns onto a %s target and rejects outside or covered targets', async kind => {
    if (kind === 'empty') board.cards = board.cards.filter(card => card.columnId !== 'column-3');
    await show();
    const source = screen.getByRole('button', { name: '移動工作「Session 0」' });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = kind === 'card' ? document.querySelector<HTMLElement>('[data-kanban-card="card-3"]')!
      : list('待審查');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    let hit: Element | null = document.body;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    const pointer = (type: string, y: number, pointerId = 1) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId, isPrimary: true }); fireEvent(source, event);
    };
    try {
      for (const outside of [null, document.body, document.querySelector('.kanban-column-header')]) {
        hit = outside;
        pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180);
        expect(api.moveKanbanCard).not.toHaveBeenCalled();
      }
      hit = target;
      pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180, 2);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      pointer('pointerup', 180);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'column-3', kind === 'card' ? 1 : 0));
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
});
