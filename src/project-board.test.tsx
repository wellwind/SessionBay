import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { gitApi } from './git/git-api';
import { ProjectBoard } from './components/ProjectBoard';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import type { RuntimeActivityStore } from './runtime-activity';
import type { KanbanBoard, Project, Session } from './types';
import { emptyWorkspace } from './workspace';
import { setLocale } from './i18n';
import { kanbanFixture, moveFixtureCard, createFixtureCard, mergeFixtureCards, splitFixtureSession, deleteFixtureCard } from '../tests/fixtures/kanban';

vi.mock('./git/git-api', () => ({ gitApi: { discover: vi.fn(), worktreeAdd: vi.fn() } }));
vi.mock('./api', () => ({ api: {
  sessions: vi.fn(), attachKanbanSession: vi.fn(), bindKanbanWorktree: vi.fn(),
  editKanbanCard: vi.fn(), archiveKanbanCard: vi.fn(), deleteKanbanCard: vi.fn(), mergeKanbanCards: vi.fn(),
  splitKanbanSession: vi.fn(), createKanbanCard: vi.fn(), trashSession: vi.fn(), setKanbanAutoArchive: vi.fn(),
  listKanbanBoards: vi.fn(), kanbanBoard: vi.fn(), setKanbanBoardEnabled: vi.fn(), moveKanbanCard: vi.fn(), reorderKanbanColumns: vi.fn(),
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
  vi.mocked(api.editKanbanCard).mockImplementation(async (id, title, notes) => { const card = board.cards.find(card => card.id === id)!; Object.assign(card, { title, notes }); return structuredClone(card); });
  vi.mocked(api.archiveKanbanCard).mockImplementation(async (id, archived) => { const card = board.cards.find(card => card.id === id)!; card.archived = archived; return structuredClone(card); });
  vi.mocked(api.deleteKanbanCard).mockImplementation(async (id, disposition) => deleteFixtureCard(board, id, disposition));
  vi.mocked(api.createKanbanCard).mockImplementation(async (column, title, notes) => createFixtureCard(board, column, title, notes));
  vi.mocked(api.mergeKanbanCards).mockImplementation(async (source, target) => mergeFixtureCards(board, source, target));
  vi.mocked(api.splitKanbanSession).mockImplementation(async (card, session) => splitFixtureSession(board, card, session));
  vi.mocked(api.trashSession).mockImplementation(async id => { board.cards.forEach(card => { card.sessions = card.sessions.filter(link => link.session.id !== id); }); return 'synthetic-trash'; });
  vi.mocked(api.setKanbanAutoArchive).mockImplementation(async (_, days) => { board.autoArchiveDays = days; });
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

describe('task details and actions', () => {
  const open = async (index = 0) => { await show(); fireEvent.click(screen.getByRole('button', { name: 'Session ' + index })); return screen.getByRole('dialog'); };
  it('edits title and notes, retains a draft during background refresh, and blocks start until saved', async () => {
    const onStart = vi.fn();
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Session 0' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '工作標題' }), { target: { value: 'New task title' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Draft notes' } });
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.editKanbanCard).toHaveBeenCalledWith('card-0', 'New task title', 'Draft notes'));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '開始工作' }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-0', title: 'New task title', notes: 'Draft notes' }), project);
  });
  it('reports save failures without discarding the draft', async () => {
    vi.mocked(api.editKanbanCard).mockRejectedValueOnce('Synthetic save failed');
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Keep this draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Synthetic save failed'));
    expect(within(dialog).getByRole('textbox', { name: '備註' })).toHaveValue('Keep this draft');
  });
  it('resumes the exact attached session and splits it without deleting the original task', async () => {
    const onResume = vi.fn();
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} onResume={onResume} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Session 0' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '接續' }));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: 's-0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session 0' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '拆分為新工作' }));
    await waitFor(() => expect(api.splitKanbanSession).toHaveBeenCalledExactlyOnceWith('card-0', 's-0'));
    await screen.findByText('尚未附加 Session。開始工作即可附加新的 Session。');
    expect(board.cards.find(card => card.id === 'card-0')).toBeDefined();
  });
  it('creates a planning task with no sessions', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: '新增工作卡片' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '工作標題' }), { target: { value: 'Plan first' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '建立工作卡片' }));
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledWith('column-1', 'Plan first', ''));
    await screen.findByRole('dialog', { name: '工作詳情' });
  });
  it('archives Done tasks and restores from the Archived view without touching sessions', async () => {
    const dialog = await open(4);
    fireEvent.click(within(dialog).getByRole('button', { name: '封存工作' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Session 4' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已封存工作' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session 4' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '還原工作' }));
    await waitFor(() => expect(api.archiveKanbanCard).toHaveBeenLastCalledWith('card-4', false));
    expect(api.trashSession).not.toHaveBeenCalled();
    expect(board.cards[4].sessions).toHaveLength(1);
  });
  it.each(['unsorted', 'detach'] as const)('requires confirmation and an explicit %s disposition before deleting a task', async disposition => {
    const dialog = await open(4);
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除工作' }));
    expect(api.deleteKanbanCard).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: '刪除工作？' });
    fireEvent.change(within(confirm).getByRole('combobox', { name: '附加的 Sessions' }), { target: { value: disposition } });
    fireEvent.click(within(confirm).getByRole('button', { name: '刪除工作' }));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenCalledExactlyOnceWith('card-4', disposition));
    expect(api.trashSession).not.toHaveBeenCalled();
  });
  it('confirms recycling individually, keeps the task, and permits cancelling remaining sessions', async () => {
    board.cards[4].sessions.push(board.cards[3].sessions[0]);
    const dialog = await open(4);
    fireEvent.click(within(dialog).getByRole('button', { name: '將附加的 Sessions 移至資源回收筒…' }));
    expect(api.trashSession).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認移入資源回收筒' }));
    await waitFor(() => expect(api.trashSession).toHaveBeenCalledExactlyOnceWith('s-4', 'synthetic-s-4'));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Session 3'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(board.cards.find(card => card.id === 'card-4')!.sessions).toHaveLength(1);
    expect(api.deleteKanbanCard).not.toHaveBeenCalled();
  });
  it('does not offer Done actions on an unfinished task', async () => {
    const dialog = await open();
    expect(within(dialog).queryByRole('button', { name: '刪除工作' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '封存工作' })).not.toBeInTheDocument();
  });
  it('offers an off-by-default auto-archive policy and saves days', async () => {
    await show(); fireEvent.click(screen.getByRole('button', { name: '自動封存' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '天數' }), { target: { value: '7' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.setKanbanAutoArchive).toHaveBeenCalledWith('p', 7));
  });
  it('merges through the accessible details control only after confirmation', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Session 0' }));
    fireEvent.click(screen.getByText('合併工作', { selector: 'summary' }));
    fireEvent.change(screen.getByRole('combobox', { name: '合併至工作' }), { target: { value: 'card-1' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合併工作' }));
    expect(api.mergeKanbanCards).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合併工作' }));
    await waitFor(() => expect(api.mergeKanbanCards).toHaveBeenCalledExactlyOnceWith('card-0', 'card-1'));
    expect(board.cards.find(card => card.id === 'card-1')!.sessions).toHaveLength(2);
  });
  it('drops on a card center to request merge; Escape cancels it', async () => {
    await show();
    const source = screen.getByRole('button', { name: '移動工作「Session 0」' });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = document.querySelector<HTMLElement>('[data-kanban-card="card-5"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId: 1, isPrimary: true }); fireEvent(source, event);
    };
    try {
      pointer('pointerdown', 5); pointer('pointermove', 150); pointer('pointerup', 150);
      expect(screen.getByRole('dialog', { name: '合併工作？' })).toBeInTheDocument();
      expect(target).not.toHaveClass('kanban-drop-after');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(api.mergeKanbanCards).not.toHaveBeenCalled();
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
});

describe('task worktree and recovery', () => {
  const open = async () => { await show(); fireEvent.click(screen.getByRole('button', { name: 'Session 0' })); };
  it('creates a checkout through the Git API, binds it, and retries binding without creating it twice', async () => {
    vi.mocked(gitApi.discover).mockResolvedValue({ state: 'ready', gitVersion: 'synthetic', issues: [], truncated: false, cancelled: false, repos: [{
      id: 'repo', name: 'Synthetic', root: project.path!, relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false,
    }] });
    vi.mocked(gitApi.worktreeAdd).mockResolvedValue({ path: '/synthetic/worktree', branch: 'task/testing' });
    vi.mocked(api.bindKanbanWorktree).mockRejectedValueOnce('Synthetic binding failed').mockImplementation(async (_, path) => { board.cards[0].worktreePath = path; });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '為工作建立 worktree' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '儲存庫' })).toHaveValue('repo'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch 名稱' }), { target: { value: 'task/testing' } });
    fireEvent.click(screen.getByRole('button', { name: '建立 worktree' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Synthetic binding failed'));
    fireEvent.click(screen.getByRole('button', { name: '建立 worktree' }));
    await waitFor(() => expect(api.bindKanbanWorktree).toHaveBeenCalledTimes(2));
    expect(gitApi.worktreeAdd).toHaveBeenCalledExactlyOnceWith('p', { repoId: 'repo', branch: 'task/testing', create: true, base: null, path: null });
    await screen.findByText('Worktree：/synthetic/worktree');
  });
  it('requires confirmation to discard a draft and returns focus to the task', async () => {
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: '備註' }), { target: { value: 'Unsaved' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '捨棄工作變更？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('textbox', { name: '備註' })).toHaveValue('Unsaved');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Session 0' })).toHaveFocus());
    expect(api.editKanbanCard).not.toHaveBeenCalled();
  });
  it('attaches a user-selected history session without inferring identity from cwd', async () => {
    vi.mocked(api.sessions).mockResolvedValue({ items: [sessions[2]], total: 1, catalogRevision: 'synthetic' });
    vi.mocked(api.attachKanbanSession).mockImplementation(async (_, id) => { board.cards[0].sessions.push({ session: sessions.find(session => session.id === id)!, branch: null }); return structuredClone(board.cards[0]); });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '從歷史附加' }));
    await screen.findByRole('combobox', { name: 'Session' });
    expect(api.attachKanbanSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Session' }), { target: { value: 's-2' } });
    fireEvent.click(screen.getByRole('button', { name: '附加 Session' }));
    await waitFor(() => expect(api.attachKanbanSession).toHaveBeenCalledExactlyOnceWith('card-0', 's-2'));
  });
});

describe('all boards', () => {
  const second: Project = { ...project, id: 'second', name: 'Other Project' };
  let other: KanbanBoard;
  const showAll = async (workspace = emptyWorkspace(), projects = [project, second]) => {
    const view = render(<ProjectBoard projects={projects} workspace={workspace} />);
    await screen.findByRole('heading', { name: '未分類' });
    return view;
  };
  beforeEach(() => {
    other = kanbanFixture('second', sessions.slice(0, 2).map(session => ({ ...session, id: 'other-' + session.id, projectId: 'second', title: 'Other ' + session.title })));
    other.columns.forEach(column => { column.id = 'other-' + column.id; });
    other.cards.forEach(card => { card.id = 'other-' + card.id; card.columnId = 'other-' + card.columnId; });
    vi.mocked(api.listKanbanBoards).mockImplementation(async () => structuredClone([board, other]));
    vi.mocked(api.moveKanbanCard).mockImplementation(async (id, column, position) =>
      structuredClone(moveFixtureCard(id.startsWith('other-') ? other : board, id, column, position)));
  });
  it('groups renamed and custom columns into five stages with project initials, excluding archived, disabled and uncurated boards', async () => {
    board.columns[1].name = 'Literal custom name';
    other.columns.push({ ...other.columns[1], id: 'later-todo', position: 5 });
    other.cards[0].columnId = 'later-todo';
    other.cards[1].archived = true;
    const disabled = { ...structuredClone(board), projectId: 'disabled', enabled: false };
    const uncurated = { ...structuredClone(board), projectId: 'directory' };
    vi.mocked(api.listKanbanBoards).mockResolvedValue(structuredClone([board, other, disabled, uncurated]));
    await showAll(emptyWorkspace(), [project, second, { ...project, id: 'disabled' }, { ...project, id: 'directory', curated: false }]);
    expect(screen.getAllByRole('heading', { level: 3 }).map(el => el.textContent)).toEqual(['未分類', '待辦', '進行中', '待審查', '完成']);
    expect(titles('待辦')).toContain('Other Session 0');
    expect(screen.queryByRole('heading', { name: 'Other Session 1' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-kanban-card]')).toHaveLength(10);
    expect(document.querySelector('.kanban-project .project-initials')).toHaveTextContent('S');
    expect(screen.queryByRole('button', { name: '新增欄位' })).not.toBeInTheDocument();
    expect(api.kanbanBoard).not.toHaveBeenCalled();
  });
  it('combines project, session-title/notes, agent and live attention filters without moving cards', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.failed = { id: 'failed', projectId: second.id, title: 'Other', kind: 'claude', state: 'failed', cwd: '/synthetic/project', sessionId: 'other-s-0' };
    other.cards[0].title = 'Task';
    await showAll(workspace);
    fireEvent.change(screen.getByRole('combobox', { name: '專案' }), { target: { value: 'second' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Session 0' } });
    await waitFor(() => expect(titles('未分類')).toEqual(['Task']));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'TOKEN BUCKET' } });
    await waitFor(() => expect(titles('未分類')).toEqual(['Task']));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '需要處理' }));
    expect(titles('未分類')).toEqual(['Task']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
    expect(screen.getByText('沒有符合篩選條件的工作。')).toBeInTheDocument();
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
  });
  it('moves only to the owning project’s first column in catalog order, including archived destination cards', async () => {
    other.columns[1].position = 8;
    other.columns.push({ ...other.columns[1], id: 'first-todo', position: 0, name: 'First todo' });
    other.cards.push({ ...other.cards[0], id: 'hidden-destination', columnId: 'first-todo', archived: true });
    await showAll();
    const handle = screen.getByRole('button', { name: '移動工作「Other Session 0」' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight', altKey: true, isComposing: true });
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('other-card-0', 'first-todo', 1));
    expect(other.cards[0].projectId).toBe('second');
    await waitFor(() => expect(screen.getByRole('button', { name: '移動工作「Other Session 0」' })).toHaveFocus());
    expect(titles('待辦')).toContain('Other Session 0');
    fireEvent.click(screen.getByRole('button', { name: '移動「Other Session 0」…' }));
    expect(screen.queryByRole('menuitem', { name: '往上移' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '完成' }));
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('other-card-0', 'other-column-4', 0));
  });
  it('disables missing stage destinations and retains cards on a failed move', async () => {
    other.columns = other.columns.filter(column => column.stage !== 'review');
    await showAll();
    fireEvent.click(screen.getByRole('button', { name: '移動「Other Session 0」…' }));
    expect(screen.getByRole('menuitem', { name: '待審查' })).toBeDisabled();
    vi.mocked(api.moveKanbanCard).mockRejectedValueOnce('Synthetic overview move failed');
    fireEvent.click(screen.getByRole('menuitem', { name: '完成' }));
    await screen.findByRole('alert');
    expect(titles('未分類')).toContain('Other Session 0');
    expect(other.cards[0].projectId).toBe('second');
  });
  it('dropping on another project’s card changes stage without merging or changing project; Escape cancels', async () => {
    await showAll();
    const source = screen.getByRole('button', { name: '移動工作「Session 0」' });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = document.querySelector<HTMLElement>('[data-kanban-card="other-card-1"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId: 1, isPrimary: true }); fireEvent(source, event);
    };
    pointer('pointerdown', 5); pointer('pointermove', 150);
    expect(target).not.toHaveClass('kanban-drop-merge', 'kanban-drop-before', 'kanban-drop-after');
    expect(target.closest('[data-kanban-column]')).toHaveClass('kanban-drop-column');
    fireEvent.keyDown(window, { key: 'Escape' }); pointer('pointerup', 150);
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
    pointer('pointerdown', 5); pointer('pointermove', 150); pointer('pointerup', 150);
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'column-1', 3));
    expect(api.mergeKanbanCards).not.toHaveBeenCalled();
    expect(board.cards[0].projectId).toBe('p');
  });
  it('opens shared details with only same-project merge targets and starts in the owning project', async () => {
    const onStart = vi.fn();
    render(<ProjectBoard projects={[project, second]} workspace={emptyWorkspace()} onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Other Session 0' }));
    fireEvent.click(document.querySelector('.kanban-merge-form summary')!);
    expect(screen.getByRole('combobox', { name: '合併至工作' }).querySelectorAll('option')).toHaveLength(3);
    expect(screen.queryByRole('option', { name: 'Session 0' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '開始工作' }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'other-card-0', projectId: 'second', columnId: 'other-column-0' }), second);
  });
  it('offers an empty overview and retries a failed read', async () => {
    vi.mocked(api.listKanbanBoards).mockRejectedValueOnce('Synthetic read failed').mockResolvedValue([]);
    render(<ProjectBoard projects={[project]} workspace={emptyWorkspace()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重新嘗試' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: '尚未啟用任何看板' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '啟用看板' })).not.toBeInTheDocument();
  });
  it('translates overview stage names at render time', async () => {
    setLocale('en');
    render(<ProjectBoard projects={[project, second]} workspace={emptyWorkspace()} />);
    await screen.findByRole('heading', { name: 'Unsorted' });
    expect(screen.getByRole('heading', { name: 'In progress' })).toBeInTheDocument();
  });
});
