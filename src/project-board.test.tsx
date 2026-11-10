import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  listKanbanBoards: vi.fn(), kanbanBoard: vi.fn(), setKanbanBoardEnabled: vi.fn(), moveKanbanCard: vi.fn(), renameKanbanColumn: vi.fn(),
}, errorMessage: (error: unknown) => String(error) }));
const project: Project = { id: 'p', name: 'Synthetic', path: '/synthetic/project', launchPath: null,
  curated: true, exists: true, pinned: false, agents: ['claude', 'codex'], sessionCount: 7, updatedAt: null };
const sessions: Session[] = Array.from({ length: 7 }, (_, i) => ({ id: `s-${i}`, sourceId: i % 2 ? 'source-codex' : 'source-claude',
  kind: i % 2 ? 'codex' : 'claude', externalId: `external-${i}`, title: `Session ${i}`, projectId: 'p', cwd: '/synthetic/project',
  updatedAt: '2026-10-28T10:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: null }));
// Fixture: card-0 and card-5 are Unsorted suggestions; card-1, card-6 and the empty task are Todo; card-2 In progress; card-3 Review; card-4 Done.
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
  vi.mocked(api.attachKanbanSession).mockImplementation(async (cardId, sessionId) => {
    const link = board.cards.flatMap(card => card.sessions).find(link => link.session.id === sessionId)
      ?? { session: sessions.find(session => session.id === sessionId)!, branch: null };
    board.cards.forEach(card => { card.sessions = card.sessions.filter(item => item.session.id !== sessionId); });
    const card = board.cards.find(card => card.id === cardId)!; card.sessions.push(link); return structuredClone(card);
  });
  vi.mocked(api.trashSession).mockImplementation(async id => { board.cards.forEach(card => { card.sessions = card.sessions.filter(link => link.session.id !== id); }); return 'synthetic-trash'; });
  vi.mocked(api.setKanbanAutoArchive).mockImplementation(async (_, days) => { board.autoArchiveDays = days; });
  vi.mocked(api.kanbanBoard).mockImplementation(async () => structuredClone(board));
  vi.mocked(api.setKanbanBoardEnabled).mockImplementation(async (_, enabled) => { board.enabled = enabled; return structuredClone(board); });
  vi.mocked(api.moveKanbanCard).mockImplementation(async (id, columnId, position) => structuredClone(moveFixtureCard(board, id, columnId, position)));
  vi.mocked(api.renameKanbanColumn).mockImplementation(async (id, name) => { const column = board.columns.find(column => column.id === id)!; column.name = name; return structuredClone(column); });
});
afterEach(() => { vi.restoreAllMocks(); setLocale('zh-TW'); });
const show = async (workspace = emptyWorkspace(), props: Partial<Parameters<typeof ProjectBoard>[0]> = {}) => {
  const view = render(<ProjectBoard project={project} workspace={workspace} {...props as object} />);
  await screen.findByRole('heading', { name: '待辦' });
  return view;
};
const list = (name: string) => screen.getByRole('list', { name });
const titles = (name: string) => within(list(name)).queryAllByRole('heading', { level: 4 }).map(el => el.textContent);
const suggestionTitles = () => [...document.querySelectorAll('.kanban-suggestion-title')].map(el => el.textContent);
const opener = (title: string) => screen.getByRole('button', { name: title });
const pointerOn = (source: HTMLElement) => (type: string, y: number, pointerId = 1) => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId, isPrimary: true }); fireEvent(source, event);
};

describe('project board', () => {
  it('loads before offering enable, then enables once through the explicit command', async () => {
    let resolve!: (value: KanbanBoard | null) => void;
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在載入看板');
    await act(async () => resolve(null));
    expect(screen.getByRole('heading', { name: '把 agent 工作規劃成任務' })).toBeInTheDocument();
    const enable = screen.getByRole('button', { name: '啟用看板' });
    fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByRole('heading', { name: '待辦' });
    expect(api.setKanbanBoardEnabled).toHaveBeenCalledExactlyOnceWith('p', true);
  });
  it('does not read or enable a board for an uncurated directory', () => {
    render(<ProjectBoard project={{ ...project, curated: false }} workspace={emptyWorkspace()} />);
    expect(screen.getByText('將此目錄加入專案即可啟用看板。')).toBeInTheDocument();
    expect(api.kanbanBoard).not.toHaveBeenCalled();
  });
  it('shows four fixed stages, lists Unsorted sessions as suggestions and keeps idle cards quiet', async () => {
    board.columns[3].name = 'Custom review';
    board.cards[4].archived = true;
    await show();
    expect(screen.getAllByRole('heading', { level: 3 }).map(el => el.textContent)).toEqual(['待辦', '進行中', 'Custom review', '完成']);
    expect(screen.queryByRole('list', { name: '未歸類' })).not.toBeInTheDocument();
    expect(screen.getByText('有 2 個 Session 還沒歸入任務')).toBeInTheDocument();
    expect(suggestionTitles()).toEqual(['Session 0', 'Session 5']);
    expect(titles('待辦')).toEqual(['Session 1', 'Session 6', '未命名任務']);
    expect(titles('完成')).toEqual([]);
    expect(screen.queryByText(/未執行/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Codex' }).length).toBeGreaterThan(0);
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-28T10:00:00Z');
    expect(screen.queryByRole('button', { name: /^需要處理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增欄位' })).not.toBeInTheDocument();
  });
  it('default names follow the UI language until renamed', async () => {
    board.columns[1].name = 'My todo';
    setLocale('en');
    render(<ProjectBoard project={project} workspace={emptyWorkspace()} />);
    await screen.findByRole('heading', { name: 'My todo' });
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByText('2 sessions are not in a task yet')).toBeInTheDocument();
  });
  it('renames a column from its menu; there is no way to add or delete columns', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: '欄位操作：待審查' }));
    expect(screen.getAllByRole('button').map(button => button.textContent)).not.toContain('刪除…');
    fireEvent.click(screen.getByRole('button', { name: '重新命名…' }));
    fireEvent.change(screen.getByRole('textbox', { name: '欄位名稱' }), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: '重新命名欄位' }));
    await waitFor(() => expect(api.renameKanbanColumn).toHaveBeenCalledExactlyOnceWith('column-3', 'QA'));
    await screen.findByRole('heading', { name: 'QA' });
  });
  it('filters tasks and suggestions by title, notes, session titles and agent', async () => {
    board.cards[1].title = 'Task title';
    board.cards[1].notes = 'Token bucket plan';
    await show();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜尋看板' }), { target: { value: 'TOKEN BUCKET' } });
    await waitFor(() => expect(titles('待辦')).toEqual(['Task title']));
    expect(suggestionTitles()).toEqual(['Session 0']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Session 6' } });
    await waitFor(() => expect(titles('待辦')).toEqual(['Session 6']));
    fireEvent.click(screen.getByRole('button', { name: '篩選' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
    expect(screen.getByText('沒有符合篩選條件的任務。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '移除 Agent 篩選' }));
    expect(titles('待辦')).toEqual(['Session 6']);
  });
  it('shows live status and the attention toggle only while a session needs you, without moving cards', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Open', kind: 'claude', state: 'running', cwd: '/synthetic/project', sessionId: 's-2', runtimeId: 'r' };
    let store!: RuntimeActivityStore;
    function Capture() { store = useRuntimeActivity()!; return null; }
    render(<RuntimeActivityProvider><Capture /><ProjectBoard project={project} workspace={workspace} /></RuntimeActivityProvider>);
    await screen.findByRole('heading', { name: '待辦' });
    act(() => {
      store.begin('a', 'lease', 'r', false, false);
      store.observe('a', 'lease', { type: 'agentActivity', runtimeId: 'r', generation: 'test', revision: 1, observation: 'awaitingPermission', validForMs: 30_000 });
    });
    const toggle = await screen.findByRole('button', { name: /^需要處理/ });
    expect(document.querySelector('[data-kanban-card="card-2"]')).toHaveClass('kanban-needs-attention');
    fireEvent.click(toggle);
    expect(titles('進行中')).toEqual(['Session 2']);
    expect(titles('待辦')).toEqual([]);
    act(() => store.observe('a', 'lease', { type: 'agentActivity', runtimeId: 'r', generation: 'test', revision: 2, observation: 'busy', validForMs: 30_000 }));
    await waitFor(() => expect(titles('進行中')).toEqual([]));
    fireEvent.click(screen.getByRole('button', { name: /^需要處理/ }));
    await waitFor(() => expect(within(list('進行中')).getByText('工作中')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^需要處理/ })).not.toBeInTheDocument();
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
  });
  it('moves through the drawer Stage menu, which lists only the four stages', async () => {
    await show();
    fireEvent.click(opener('Session 1'));
    const stage = within(screen.getByRole('dialog')).getByRole('combobox', { name: '階段' });
    expect([...stage.querySelectorAll('option')].map(option => option.textContent)).toEqual(['待辦', '進行中', '待審查', '完成']);
    fireEvent.change(stage, { target: { value: 'column-3' } });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'column-3', 1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('reorders with Alt+Up/Down in catalog order and changes stage with Alt+Left/Right', async () => {
    board.cards.push({ ...board.cards[1], id: 'archived-todo', title: 'Archived', archived: true, position: 1 });
    await show();
    const button = opener('Session 6');
    fireEvent.keyDown(button, { key: 'ArrowUp', altKey: true, isComposing: true });
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-6', 'column-1', 0));
    await waitFor(() => expect(titles('待辦')).toEqual(['Session 6', 'Session 1', '未命名任務']));
    fireEvent.keyDown(opener('Session 6'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('card-6', 'column-2', 1));
    fireEvent.keyDown(opener('Session 2'), { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('card-2', 'column-1', 3));
  });
  it('retains the board and reports errors when a move fails; allows retry', async () => {
    vi.mocked(api.moveKanbanCard).mockRejectedValueOnce('Synthetic move failed');
    await show();
    fireEvent.keyDown(opener('Session 1'), { key: 'ArrowRight', altKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic move failed');
    expect(titles('待辦')).toContain('Session 1');
    fireEvent.click(screen.getByRole('button', { name: '重新嘗試' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('ignores a late background snapshot after an explicit move', async () => {
    await show();
    let late!: (value: KanbanBoard) => void;
    const stale = structuredClone(board);
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { late = done; }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    fireEvent.keyDown(opener('Session 1'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(titles('進行中')).toContain('Session 1'));
    await act(async () => late(stale));
    expect(titles('進行中')).toContain('Session 1');
  });
  it('reorders by pointer within a column; Escape cancellation never saves', async () => {
    await show();
    const source = opener('Session 1');
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = document.querySelector<HTMLElement>('[data-kanban-card="card-6"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    const pointer = pointerOn(source);
    try {
      pointer('pointerdown', 5); pointer('pointermove', 180);
      expect(target).toHaveClass('kanban-drop-after');
      fireEvent.keyDown(window, { key: 'Escape' }); pointer('pointerup', 180);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      pointer('pointerdown', 5); pointer('pointermove', 120); pointer('pointerup', 120);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'column-1', 1));
      expect(api.mergeKanbanCards).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
  it.each(['card', 'empty', 'body'])('drops across columns onto a %s target and rejects outside targets', async kind => {
    if (kind !== 'card') board.cards = board.cards.filter(card => card.columnId !== 'column-3');
    await show();
    const source = opener('Session 1');
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = kind === 'card' ? document.querySelector<HTMLElement>('[data-kanban-card="card-3"]')!
      : kind === 'empty' ? within(list('待審查')).getByText('把任務拖到這裡') : list('待審查').parentElement!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    let hit: Element | null = document.body;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    const pointer = pointerOn(source);
    try {
      pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      hit = target;
      pointer('pointerdown', 5); pointer('pointermove', 180); pointer('pointerup', 180, 2);
      expect(api.moveKanbanCard).not.toHaveBeenCalled();
      pointer('pointerup', 180);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'column-3', kind === 'card' ? 1 : 0));
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
});

describe('suggestions', () => {
  it('turns a suggestion into a Todo task with Undo', async () => {
    await show();
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-kanban-card="card-5"]')!).getByRole('button', { name: '設為任務' }));
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-5', 'column-1', 3));
    await waitFor(() => expect(titles('待辦')).toContain('Session 5'));
    expect(suggestionTitles()).toEqual(['Session 0']);
    expect(await screen.findByRole('button', { name: '復原' })).toBeInTheDocument();
  });
  it('adds a suggestion’s sessions to an existing task without touching its title or notes', async () => {
    board.cards[1].notes = 'Keep me';
    await show();
    fireEvent.click(screen.getByRole('button', { name: '把「Session 0」歸入任務' }));
    fireEvent.click(within(document.querySelector<HTMLElement>('.kanban-menu')!).getByRole('button', { name: 'Session 1' }));
    await waitFor(() => expect(api.attachKanbanSession).toHaveBeenCalledExactlyOnceWith('card-1', 's-0'));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'detach'));
    expect(api.mergeKanbanCards).not.toHaveBeenCalled();
    expect(board.cards.find(card => card.id === 'card-1')).toMatchObject({ title: 'Session 1', notes: 'Keep me' });
    await waitFor(() => expect(suggestionTitles()).toEqual(['Session 5']));
  });
  it('dismisses one suggestion directly and all of them only after confirmation', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: '略過「Session 5」' }));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenCalledExactlyOnceWith('card-5', 'detach'));
    await waitFor(() => expect(suggestionTitles()).toEqual(['Session 0']));
    fireEvent.click(screen.getByRole('button', { name: '全部略過' }));
    const dialog = screen.getByRole('dialog', { name: '略過所有建議？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api.deleteKanbanCard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '全部略過' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '全部略過' }));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenLastCalledWith('card-0', 'detach'));
    await waitFor(() => expect(screen.queryByText(/還沒歸入任務/)).not.toBeInTheDocument());
  });
  it('collapses to one line', async () => {
    await show();
    const toggle = screen.getByRole('button', { name: '有 2 個 Session 還沒歸入任務' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '設為任務' })).not.toBeInTheDocument();
  });
});

describe('task drawer', () => {
  const open = async (title = 'Session 1', props: Partial<Parameters<typeof ProjectBoard>[0]> = {}) => {
    await show(emptyWorkspace(), props); fireEvent.click(opener(title)); return screen.getByRole('dialog');
  };
  it('focuses the title, autosaves edits after a pause and has no Save button or discard prompt', async () => {
    const dialog = await open();
    const title = within(dialog).getByRole('textbox', { name: '標題' });
    expect(title).toHaveFocus();
    expect(within(dialog).queryByRole('button', { name: '儲存' })).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: 'Renamed' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Plan' } });
    expect(title).not.toBeDisabled();
    await waitFor(() => expect(api.editKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'Renamed', 'Plan'), { timeout: 2000 });
    await within(dialog).findByText('已儲存');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.editKanbanCard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opener('Renamed')).toHaveFocus());
  });
  it('saves a pending edit immediately when closing', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Quick note' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(api.editKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'Session 1', 'Quick note'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('keeps the drawer open with a retry when saving fails', async () => {
    vi.mocked(api.editKanbanCard).mockRejectedValueOnce('Synthetic save failed');
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Draft' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await within(dialog).findByRole('button', { name: '尚未儲存，重試' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: '備註' })).toHaveValue('Draft');
    fireEvent.click(within(dialog).getByRole('button', { name: '尚未儲存，重試' }));
    await waitFor(() => expect(api.editKanbanCard).toHaveBeenCalledTimes(2));
    await within(dialog).findByText('已儲存');
  });
  it('continues the latest session as the primary action and offers a new session from its menu', async () => {
    const onResume = vi.fn(), onStart = vi.fn();
    const dialog = await open('Session 1', { onResume, onStart });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '備註' }), { target: { value: 'Before continuing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '繼續 Codex 工作' }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: 's-1' })));
    expect(api.editKanbanCard).toHaveBeenCalledWith('card-1', 'Session 1', 'Before continuing');
  });
  it('moves a Todo task to In progress when starting a new session', async () => {
    const onStart = vi.fn();
    const dialog = await open('Session 1', { onStart, onResume: vi.fn() });
    fireEvent.click(within(dialog).getByRole('button', { name: '其他開始方式' }));
    fireEvent.click(screen.getByRole('button', { name: '開新 Session' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'card-1' }), project));
    expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'column-2', 1);
  });
  it('starts a task without sessions in place when it is already past Todo', async () => {
    board.cards.find(card => card.id === 'empty-task')!.columnId = 'column-3';
    const onStart = vi.fn();
    const dialog = await open('未命名任務', { onStart });
    expect(within(dialog).getByText('還沒有 Session。開始工作後，新的 Session 會附加在這裡。')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '開始工作' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
  });
  it('resumes an exact attached session and splits it from the session menu', async () => {
    const onResume = vi.fn();
    const dialog = await open('Session 1', { onResume });
    fireEvent.click(within(dialog).getByRole('button', { name: '接續' }));
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: 's-1', externalId: 'external-1' })));
    fireEvent.click(opener('Session 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Session 操作：Session 1' }));
    fireEvent.click(screen.getByRole('button', { name: '拆成新任務' }));
    await waitFor(() => expect(api.splitKanbanSession).toHaveBeenCalledExactlyOnceWith('card-1', 's-1'));
    expect(board.cards.some(card => card.id === 'card-1')).toBe(true);
  });
  it('creates a planning task in the chosen stage and opens it', async () => {
    await show();
    fireEvent.click(within(document.querySelector<HTMLElement>('.kanban-toolbar')!).getByRole('button', { name: '新增任務' }));
    const dialog = screen.getByRole('dialog', { name: '新增任務' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '標題' }), { target: { value: 'Plan' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '階段' }), { target: { value: 'review' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '建立任務' }));
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledExactlyOnceWith('column-3', 'Plan', ''));
    expect(await screen.findByRole('dialog', { name: '任務' })).toBeInTheDocument();
  });
  it('archives Done tasks, shows them behind the Done column link and restores them', async () => {
    await show(); fireEvent.click(opener('Session 4'));
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '封存任務' }));
    await waitFor(() => expect(api.archiveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-4', true));
    fireEvent.click(await screen.findByRole('button', { name: '已封存（1） →' }));
    expect(titles('已封存的任務')).toEqual(['Session 4']);
    fireEvent.click(opener('Session 4'));
    fireEvent.click(screen.getByRole('button', { name: '還原任務' }));
    await waitFor(() => expect(api.archiveKanbanCard).toHaveBeenLastCalledWith('card-4', false));
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));
    await waitFor(() => expect(titles('完成')).toEqual(['Session 4']));
    expect(api.trashSession).not.toHaveBeenCalled();
  });
  it('does not offer archive on an unfinished task', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    expect(screen.queryByRole('button', { name: '封存任務' })).not.toBeInTheDocument();
  });
  it('deletes a task and can suggest its sessions again', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '刪除任務…' }));
    const dialog = screen.getByRole('dialog', { name: '刪除任務？' });
    expect(within(dialog).getByRole('combobox', { name: '附加的 Sessions' })).toHaveValue('unsorted');
    fireEvent.click(within(dialog).getByRole('button', { name: '刪除任務' }));
    await waitFor(() => expect(api.deleteKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'unsorted'));
    await waitFor(() => expect(suggestionTitles()).toContain('Session 1'));
  });
  it('confirms recycling individually and keeps the task', async () => {
    board.cards[1].sessions.push({ session: { ...sessions[3], trashIdentity: 'synthetic-s-3' }, branch: null });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '將附加的 Sessions 移至資源回收筒…' }));
    fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
    await waitFor(() => expect(api.trashSession).toHaveBeenCalledExactlyOnceWith('s-1', 'synthetic-s-1'));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(api.trashSession).toHaveBeenCalledOnce();
    expect(board.cards.some(card => card.id === 'card-1')).toBe(true);
  });
  it('merges through the task menu only after confirmation', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '合併到其他任務…' }));
    fireEvent.change(screen.getByRole('combobox', { name: '合併到任務' }), { target: { value: 'card-6' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '合併任務' }));
    expect(api.mergeKanbanCards).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog', { name: '合併任務？' })).getByRole('button', { name: '合併任務' }));
    await waitFor(() => expect(api.mergeKanbanCards).toHaveBeenCalledExactlyOnceWith('card-1', 'card-6'));
  });
  it('offers an off-by-default auto-archive policy and saves days', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: '看板操作' }));
    fireEvent.click(screen.getByRole('button', { name: '自動封存…' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '啟用自動封存' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '天數' }), { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api.setKanbanAutoArchive).toHaveBeenCalledExactlyOnceWith('p', 14));
    expect(await screen.findByText('14 天後自動封存')).toBeInTheDocument();
  });
  it('creates a checkout through the Git API, binds it, and retries binding without creating it twice', async () => {
    vi.mocked(gitApi.discover).mockResolvedValue({ state: 'ready', gitVersion: 'synthetic', issues: [], truncated: false, cancelled: false, repos: [{
      id: 'repo', name: 'Synthetic', root: project.path!, relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false,
    }] });
    vi.mocked(gitApi.worktreeAdd).mockResolvedValue({ path: '/synthetic/worktree', branch: 'task/testing' });
    vi.mocked(api.bindKanbanWorktree).mockRejectedValueOnce('Synthetic binding failed').mockImplementation(async (_, path) => { board.cards[1].worktreePath = path; });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '為任務建立 worktree' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '儲存庫' })).toHaveValue('repo'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch 名稱' }), { target: { value: 'task/testing' } });
    fireEvent.click(screen.getByRole('button', { name: '建立 worktree' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Synthetic binding failed'));
    fireEvent.click(screen.getByRole('button', { name: '建立 worktree' }));
    await waitFor(() => expect(api.bindKanbanWorktree).toHaveBeenCalledTimes(2));
    expect(gitApi.worktreeAdd).toHaveBeenCalledOnce();
    await screen.findByText('Worktree：/synthetic/worktree');
  });
  it('attaches a user-selected history session after filtering', async () => {
    vi.mocked(api.sessions).mockResolvedValue({ items: [sessions[2], sessions[3]], total: 2, catalogRevision: 'synthetic' });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '從歷史附加' }));
    const select = await screen.findByRole('combobox', { name: 'Session' });
    expect(select.querySelectorAll('option')).toHaveLength(3);
    fireEvent.change(screen.getByRole('searchbox', { name: '篩選 Session' }), { target: { value: 'session 3' } });
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    fireEvent.change(select, { target: { value: 's-3' } });
    fireEvent.click(screen.getByRole('button', { name: '附加 Session' }));
    await waitFor(() => expect(api.attachKanbanSession).toHaveBeenCalledExactlyOnceWith('card-1', 's-3'));
  });
});

describe('all boards', () => {
  const second: Project = { ...project, id: 'second', name: 'Other Project' };
  let other: KanbanBoard;
  const showAll = async (workspace = emptyWorkspace(), projects = [project, second], props: Partial<Parameters<typeof ProjectBoard>[0]> = {}) => {
    const view = render(<ProjectBoard projects={projects} workspace={workspace} {...props as object} />);
    await screen.findByRole('heading', { name: '待辦' });
    return view;
  };
  beforeEach(() => {
    other = kanbanFixture('second', sessions.slice(0, 3).map(session => ({ ...session, id: 'other-' + session.id, projectId: 'second', title: 'Other ' + session.title })));
    other.columns.forEach(column => { column.id = 'other-' + column.id; });
    other.cards.forEach(card => { card.id = 'other-' + card.id; card.columnId = 'other-' + card.columnId; });
    vi.mocked(api.listKanbanBoards).mockImplementation(async () => structuredClone([board, other]));
    vi.mocked(api.moveKanbanCard).mockImplementation(async (id, column, position) =>
      structuredClone(moveFixtureCard(id.startsWith('other-') ? other : board, id, column, position)));
  });
  it('shows four stages with project initials, excluding archived, disabled and uncurated boards', async () => {
    other.cards[1].archived = true;
    const disabled = { ...structuredClone(board), projectId: 'disabled', enabled: false };
    const uncurated = { ...structuredClone(board), projectId: 'directory' };
    vi.mocked(api.listKanbanBoards).mockResolvedValue(structuredClone([board, other, disabled, uncurated]));
    await showAll(emptyWorkspace(), [project, second, { ...project, id: 'disabled' }, { ...project, id: 'directory', curated: false }]);
    expect(screen.getAllByRole('heading', { level: 3 }).map(el => el.textContent)).toEqual(['待辦', '進行中', '待審查', '完成']);
    expect(titles('進行中')).toEqual(['Session 2', 'Other Session 2']);
    expect(screen.queryByRole('heading', { name: 'Other Session 1' })).not.toBeInTheDocument();
    expect(suggestionTitles()).toEqual(['Session 0', 'Session 5', 'Other Session 0']);
    expect(document.querySelector('[data-kanban-card="other-card-2"] .project-initials')).toHaveTextContent('OP');
    expect(api.kanbanBoard).not.toHaveBeenCalled();
  });
  it('switches scope through the scope menu', async () => {
    const onScope = vi.fn();
    await showAll(emptyWorkspace(), [project, second], { scopes: [project, second], onScope });
    const scope = screen.getByRole('combobox', { name: '看板範圍' });
    expect(scope).toHaveValue('');
    fireEvent.change(scope, { target: { value: 'second' } });
    expect(onScope).toHaveBeenCalledWith(second);
  });
  it('moves only within the owning project’s stage column, including archived destination cards', async () => {
    other.cards.push({ ...other.cards[1], id: 'hidden-destination', columnId: 'other-column-2', archived: true });
    await showAll();
    fireEvent.keyDown(opener('Other Session 1'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('other-card-1', 'other-column-2', 2));
    expect(other.cards[1].projectId).toBe('second');
    await waitFor(() => expect(opener('Other Session 1')).toHaveFocus());
  });
  it.each(['none', 'project'])('dropping in %s grouping on another project’s card changes only the stage', async grouping => {
    await showAll();
    fireEvent.change(screen.getByRole('combobox', { name: '分組依據' }), { target: { value: grouping } });
    const source = opener('Session 2');
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = document.querySelector<HTMLElement>('[data-kanban-card="other-card-1"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 100 } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    const pointer = pointerOn(source);
    try {
      pointer('pointerdown', 5); pointer('pointermove', 150); pointer('pointerup', 150);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-2', 'column-1', 3));
      expect(board.cards[2].projectId).toBe('p');
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
  it('groups projects into swimlanes with the four stages', async () => {
    await showAll();
    fireEvent.change(screen.getByRole('combobox', { name: '分組依據' }), { target: { value: 'project' } });
    const lanes = document.querySelectorAll<HTMLElement>('.kanban-swimlane');
    expect(lanes).toHaveLength(2);
    expect(within(lanes[0]).getAllByRole('heading', { level: 3 }).map(el => el.textContent)).toEqual(['Synthetic', '待辦', '進行中', '待審查', '完成']);
  });
  it('creates a task from the overview in a chosen project with the N shortcut', async () => {
    await showAll();
    const boardRoot = screen.getByRole('region', { name: '全部看板' }); boardRoot.focus();
    fireEvent.keyDown(boardRoot, { key: 'n' });
    const dialog = screen.getByRole('dialog', { name: '新增任務' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '專案' }), { target: { value: 'second' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '標題' }), { target: { value: 'Plan from overview' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '建立任務' }));
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledExactlyOnceWith('other-column-1', 'Plan from overview', ''));
  });
  it('starts in the owning project and offers only same-project merge targets', async () => {
    const onStart = vi.fn();
    await showAll(emptyWorkspace(), [project, second], { onStart });
    fireEvent.click(opener('Other Session 2'));
    fireEvent.click(screen.getByRole('button', { name: '任務操作' }));
    fireEvent.click(screen.getByRole('button', { name: '合併到其他任務…' }));
    const targets = [...screen.getByRole('combobox', { name: '合併到任務' }).querySelectorAll('option')].map(option => option.textContent);
    expect(targets).toEqual(['選擇任務', 'Other Session 0', 'Other Session 1', '未命名任務']);
    fireEvent.click(screen.getByRole('button', { name: '開始工作' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'other-card-2', projectId: 'second' }), second));
  });
  it('offers an empty overview and retries a failed read', async () => {
    vi.mocked(api.listKanbanBoards).mockRejectedValueOnce('Synthetic read failed').mockResolvedValue([]);
    render(<ProjectBoard projects={[project]} workspace={emptyWorkspace()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重新嘗試' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: '尚未啟用任何看板' })).toBeInTheDocument();
  });
  it('translates overview stage names at render time', async () => {
    setLocale('en');
    render(<ProjectBoard projects={[project, second]} workspace={emptyWorkspace()} />);
    await screen.findByRole('heading', { name: 'In progress' });
  });
});

describe('board refinements', () => {
  it('undoes a move using the original catalog column and position', async () => {
    await show();
    fireEvent.keyDown(opener('Session 1'), { key: 'ArrowRight', altKey: true });
    const undo = await screen.findByRole('button', { name: '復原' });
    expect(undo.closest('[role="status"]')).toHaveTextContent('已移至進行中');
    fireEvent.click(undo);
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('card-1', 'column-1', 0));
    await waitFor(() => expect(titles('待辦')).toContain('Session 1'));
  });
  it('dismisses the Undo action after six seconds', async () => {
    await show(); vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.keyDown(opener('Session 1'), { key: 'ArrowRight', altKey: true }); });
      expect(screen.getByRole('button', { name: '復原' })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.queryByRole('button', { name: '復原' })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it('limits Done tasks to five', async () => {
    for (let i = 0; i < 7; i++) board.cards.push({ ...board.cards[4], id: `done-${i}`, title: `Done ${i}`, position: i + 1 });
    await show(); expect(titles('完成')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '再顯示 3 個' })); expect(titles('完成')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: '顯示較少' })); expect(titles('完成')).toHaveLength(5);
  });
  it('quick-adds in a column', async () => {
    await show();
    const review = document.querySelector<HTMLElement>('[data-kanban-column="review"]')!;
    fireEvent.click(within(review).getByRole('button', { name: '新增任務' }));
    fireEvent.change(within(review).getByRole('textbox'), { target: { value: 'Check the review' } });
    fireEvent.submit(review.querySelector('form')!);
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledExactlyOnceWith('column-3', 'Check the review', ''));
  });
  it('scopes N and / to board focus and preserves text entry and composition', async () => {
    await show();
    const button = opener('Session 1'); button.focus();
    fireEvent.keyDown(button, { key: '/', isComposing: true }); expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: '/' }); expect(screen.getByRole('searchbox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'n' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    button.focus(); fireEvent.keyDown(button, { key: 'n' }); expect(screen.getByRole('dialog', { name: '新增任務' })).toBeInTheDocument();
  });
});
