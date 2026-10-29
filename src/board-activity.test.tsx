import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ActivityShell } from './components/ActivityShell';
import { createBoardActivity } from './components/BoardActivity';
import { ProjectBoard } from './components/ProjectBoard';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import { useKanbanBoards } from './components/useKanbanBoards';
import { setLocale } from './i18n';
import type { RuntimeActivityStore } from './runtime-activity';
import type { KanbanBoard, Project, Session, Workspace } from './types';
import { emptyWorkspace } from './workspace';
import { createFixtureCard, kanbanFixture, moveFixtureCard } from '../tests/fixtures/kanban';

vi.mock('./api', () => ({ api: {
  kanbanBoard: vi.fn(), setKanbanBoardEnabled: vi.fn(), moveKanbanCard: vi.fn(), createKanbanCard: vi.fn(),
  editKanbanCard: vi.fn(), archiveKanbanCard: vi.fn(),
}, errorMessage: (error: unknown) => String(error) }));
const project: Project = { id: 'p', name: 'Synthetic project', path: '/synthetic', curated: true, exists: true,
  launchPath: null, pinned: false, agents: ['codex'], sessionCount: 7, updatedAt: null };
const sessions: Session[] = Array.from({ length: 7 }, (_, i) => ({ id: `s-${i}`, sourceId: 'synthetic', kind: 'codex',
  externalId: `external-${i}`, title: `Task ${i}`, projectId: 'p', cwd: '/synthetic', updatedAt: '2026-10-28T10:00:00Z',
  timeSource: 'event', archived: false, parentId: null, partial: false, snippet: null }));
let board: KanbanBoard;
let runtime: RuntimeActivityStore;
function Harness({ workspace = emptyWorkspace(), owner = project, full = false, onOpenBoard = vi.fn(), onStart = vi.fn() }: {
  workspace?: Workspace; owner?: Project; full?: boolean; onOpenBoard?: () => void; onStart?: () => void;
}) {
  const data = useKanbanBoards(workspace, owner.id, !!owner.curated && !owner.workspaceOnly);
  runtime = useRuntimeActivity()!;
  const [active, setActive] = useState<string | null>('board');
  return <>{full && <ProjectBoard project={owner} workspace={workspace} model={data} />}
    <ActivityShell contributions={[createBoardActivity({ project: owner, data, onOpenBoard, onStart })]}
      activeId={active} onActiveChange={setActive} /></>;
}
const show = async (props: Parameters<typeof Harness>[0] = {}) => {
  const result = render(<RuntimeActivityProvider><Harness {...props} /></RuntimeActivityProvider>);
  await screen.findByRole('button', { name: 'Open full board' });
  await waitFor(() => expect(api.kanbanBoard).toHaveBeenCalled());
  return result;
};
const panel = () => document.getElementById('activity-board-panel')!;
const card = (id = 'card-0') => panel().querySelector<HTMLElement>(`[data-kanban-card="${id}"]`)!;
const group = (id: number) => panel().querySelector<HTMLElement>(`[data-kanban-column="column-${id}"]`)!;
beforeEach(() => {
  vi.clearAllMocks(); setLocale('en');
  board = kanbanFixture('p', sessions);
  vi.mocked(api.kanbanBoard).mockImplementation(async () => structuredClone(board));
  vi.mocked(api.setKanbanBoardEnabled).mockImplementation(async (_, enabled) => { board.enabled = enabled; return structuredClone(board); });
  vi.mocked(api.moveKanbanCard).mockImplementation(async (id, column, position) => structuredClone(moveFixtureCard(board, id, column, position)));
  vi.mocked(api.createKanbanCard).mockImplementation(async (column, title, notes) => createFixtureCard(board, column, title, notes));
  vi.mocked(api.editKanbanCard).mockImplementation(async (id, title, notes) => {
    const card = board.cards.find(card => card.id === id)!; Object.assign(card, { title, notes }); return structuredClone(card);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setLocale('zh-TW'); });

describe('board activity contribution', () => {
  it('renders ordered collapsible groups, hides archived tasks, and opens the full board or shared drawer', async () => {
    board.cards[2].archived = true;
    const onOpenBoard = vi.fn(); await show({ onOpenBoard });
    expect(within(panel()).getByText('Synthetic project')).toBeVisible();
    expect([...panel().querySelectorAll('[data-kanban-column]')].map(el => el.getAttribute('data-kanban-column')))
      .toEqual(board.columns.map(column => column.id));
    expect(within(panel()).queryByText('Task 2')).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Task 4' })).not.toBeInTheDocument();
    fireEvent.click(within(group(4)).getByRole('button', { expanded: false }));
    expect(within(group(4)).getByRole('button', { name: 'Task 4' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open full board' })); expect(onOpenBoard).toHaveBeenCalledOnce();
    const opener = within(card()).getByRole('button', { name: 'Task 0' }); opener.focus(); fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Task details' })).toHaveClass('dialog-drawer');
    expect(card()).toHaveClass('kanban-selected');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it.each([{ ...project, curated: false }, { ...project, workspaceOnly: true }])('does not read or activate unavailable project boards', async owner => {
    render(<RuntimeActivityProvider><Harness owner={owner} /></RuntimeActivityProvider>);
    expect(screen.getByRole('button', { name: 'Board' })).toBeDisabled();
    expect(api.kanbanBoard).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Enable board' })).not.toBeInTheDocument();
  });
  it('waits for loading and enables through the shared mutation lock', async () => {
    board.enabled = false;
    let resolve!: (value: KanbanBoard) => void;
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<RuntimeActivityProvider><Harness /></RuntimeActivityProvider>);
    expect(screen.queryByRole('button', { name: 'Enable board' })).not.toBeInTheDocument();
    await act(async () => resolve(structuredClone(board)));
    const enable = screen.getByRole('button', { name: 'Enable board' }); fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByRole('button', { name: 'Task 0' });
    expect(api.setKanbanBoardEnabled).toHaveBeenCalledExactlyOnceWith('p', true);
  });
  it('badges distinct active tasks from live input/error states and omits zero', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Agent', kind: 'codex', state: 'running', cwd: '/synthetic', sessionId: 's-0', runtimeId: 'r' };
    workspace.panes.b = { ...workspace.panes.a, id: 'b', sessionId: 's-2', state: 'failed' };
    board.cards[2].archived = true;
    await show({ workspace });
    const button = within(screen.getByRole('navigation')).getByRole('button', { name: 'Board' });
    expect(button.querySelector('.activity-badge')).toBeNull();
    act(() => { runtime.begin('a', 'lease', 'r', false, false); runtime.observe('a', 'lease', {
      type: 'agentActivity', runtimeId: 'r', generation: 'test', revision: 1, observation: 'awaitingInput', validForMs: 30000,
    }); });
    await waitFor(() => expect(within(button).getByLabelText('Board: 1')).toHaveTextContent('1'));
    expect(card()).toHaveClass('kanban-needs-attention');
    expect(within(card()).getByLabelText('Needs attention')).toBeInTheDocument();
  });
  it('moves and reorders by Alt arrows using full catalog positions and announces the result', async () => {
    board.cards.push({ ...board.cards[0], id: 'hidden', archived: true, position: 1 });
    board.cards[5].position = 2;
    await show();
    const opener = within(card()).getByRole('button'); opener.focus();
    fireEvent.keyDown(opener, { key: 'ArrowDown', altKey: true, isComposing: true });
    expect(api.moveKanbanCard).not.toHaveBeenCalled();
    fireEvent.keyDown(opener, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'column-0', 2));
    await waitFor(() => expect(opener).toHaveFocus());
    fireEvent.keyDown(opener, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenLastCalledWith('card-0', 'column-1', 3));
    expect(within(panel()).getAllByRole('status').some(el => el.textContent?.includes('Moved "Task 0" to Todo, position 4.'))).toBe(true);
  });
  it('drags the whole card into a collapsed group header and suppresses the following click', async () => {
    await show();
    const source = card(), target = within(group(4)).getByRole('button', { expanded: false });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId: 1, isPrimary: true }); fireEvent(source, event);
    };
    try {
      pointer('pointerdown', 5); pointer('pointermove', 7);
      expect(group(4)).not.toHaveClass('kanban-drop-column');
      pointer('pointermove', 150); expect(group(4)).toHaveClass('kanban-drop-column');
      pointer('pointerup', 150); fireEvent.click(source);
      await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-0', 'column-4', 1));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
  it('quick-add creates on Enter, cancels on Escape, and respects composition', async () => {
    await show(); const user = userEvent.setup();
    fireEvent.click(within(group(1)).getByRole('button', { name: 'New task' }));
    const input = within(group(1)).getByRole('textbox', { name: 'Task title' });
    fireEvent.change(input, { target: { value: 'Plan a small change' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(api.createKanbanCard).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledExactlyOnceWith('column-1', 'Plan a small change', ''));
    expect(within(group(1)).getByRole('button', { name: 'Plan a small change' })).toBeVisible();
    fireEvent.click(within(group(1)).getByRole('button', { name: 'New task' }));
    fireEvent.keyDown(within(group(1)).getByRole('textbox'), { key: 'Escape' });
    expect(within(group(1)).queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.createKanbanCard).toHaveBeenCalledOnce();
  });
  it('shares snapshots, mutations and polling with the full board', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<RuntimeActivityProvider><Harness full /></RuntimeActivityProvider>); });
    expect(api.kanbanBoard).toHaveBeenCalledOnce();
    const main = document.querySelector<HTMLElement>('.project-board')!;
    await act(async () => { fireEvent.keyDown(within(card()).getByRole('button'), { key: 'ArrowRight', altKey: true }); });
    expect(api.kanbanBoard).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(main.querySelector('[data-kanban-card="card-0"]')?.closest('[data-kanban-column]')).toHaveAttribute('data-kanban-column', 'column-1');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.kanbanBoard).toHaveBeenCalledTimes(3);
    await act(async () => fireEvent.focus(window));
    expect(api.kanbanBoard).toHaveBeenCalledTimes(4);
  });
  it('isolates a late mutation from the next project and permits a new mutation there', async () => {
    const nextProject = { ...project, id: 'next', name: 'Next project' };
    const nextBoard = kanbanFixture('next', sessions.map(session => ({ ...session, projectId: 'next', title: 'Next ' + session.title })));
    vi.mocked(api.kanbanBoard).mockImplementation(async id => structuredClone(id === 'next' ? nextBoard : board));
    let finish!: () => void;
    vi.mocked(api.moveKanbanCard).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(structuredClone(board.cards[0])); }));
    const view = await show();
    fireEvent.keyDown(within(card()).getByRole('button'), { key: 'ArrowRight', altKey: true });
    view.rerender(<RuntimeActivityProvider><Harness owner={nextProject} /></RuntimeActivityProvider>);
    await screen.findByRole('button', { name: 'Next Task 0' });
    await act(async () => finish());
    expect(screen.queryByRole('button', { name: 'Task 0' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next Task 0' })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next Task 0' }), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(api.moveKanbanCard).toHaveBeenCalledTimes(2));
  });
  it('saves before starting and keeps the draft when saving fails', async () => {
    const onStart = vi.fn(); await show({ onStart });
    fireEvent.click(within(card()).getByRole('button'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Updated plan' } });
    vi.mocked(api.editKanbanCard).mockRejectedValueOnce('Synthetic save failure');
    fireEvent.click(screen.getByRole('button', { name: 'Save and start' }));
    await screen.findAllByRole('alert'); expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Task title' })).toHaveValue('Updated plan');
    fireEvent.click(screen.getByRole('button', { name: 'Save and start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Updated plan' }), project));
  });
});
