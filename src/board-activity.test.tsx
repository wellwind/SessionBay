import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// Fixture: Task 0 and Task 5 are Unsorted; Task 1, Task 6 and an empty task are Todo; Task 2 In progress; Task 3 Review; Task 4 Done.
let board: KanbanBoard;
let runtime: RuntimeActivityStore;
function Harness({ workspace = emptyWorkspace(), owner = project, full = false, onOpenBoard = vi.fn(), onStart = vi.fn(), onResume, onFocusPane }: {
  workspace?: Workspace; owner?: Project; full?: boolean; onOpenBoard?: () => void; onStart?: () => void;
  onResume?: (session: Session) => void; onFocusPane?: (id: string) => void;
}) {
  const data = useKanbanBoards(workspace, owner.id, !!owner.curated && !owner.workspaceOnly);
  runtime = useRuntimeActivity()!;
  const [active, setActive] = useState<string | null>('board');
  return <>{full && <ProjectBoard project={owner} workspace={workspace} model={data} />}
    <ActivityShell contributions={[createBoardActivity({ project: owner, data, onOpenBoard, onStart, onResume, onFocusPane })]}
      activeId={active} onActiveChange={setActive} /></>;
}
const show = async (props: Parameters<typeof Harness>[0] = {}) => {
  const result = render(<RuntimeActivityProvider><Harness {...props} /></RuntimeActivityProvider>);
  await screen.findByRole('button', { name: 'Open board' });
  await waitFor(() => expect(api.kanbanBoard).toHaveBeenCalled());
  await screen.findByRole('region', { name: 'Up next' });
  return result;
};
const panel = () => document.getElementById('activity-board-panel')!;
const section = (name: string) => within(panel()).getByRole('region', { name });
const names = (name: string) => within(section(name)).queryAllByRole('listitem').map(item => item.querySelector('.kanban-card-open')!.textContent);
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

describe('focus panel', () => {
  it('lists work in progress and the top of Todo, links to the board and opens the shared drawer', async () => {
    for (let i = 0; i < 2; i++) board.cards.push({ ...board.cards[1], id: `todo-${i}`, title: `Later ${i}`, position: 20 + i, sessions: [] });
    const onOpenBoard = vi.fn(); await show({ onOpenBoard });
    expect(within(panel()).getByText('Synthetic project')).toBeVisible();
    expect(within(panel()).queryByRole('region', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(names('In progress')).toEqual(['Task 2']);
    expect(names('Up next')).toEqual(['Task 1', 'Task 6', 'Untitled task']);
    expect(within(panel()).queryByText('Task 4')).not.toBeInTheDocument();
    expect(within(panel()).queryByText('Task 3')).not.toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole('button', { name: '2 more in Todo' }));
    fireEvent.click(within(panel()).getByRole('button', { name: '2 sessions are not in a task yet →' }));
    fireEvent.click(screen.getByRole('button', { name: /^Open board/ }));
    expect(onOpenBoard).toHaveBeenCalledTimes(3);
    const opener = within(section('In progress')).getByRole('button', { name: 'Task 2' }); opener.focus(); fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Task' })).toHaveClass('dialog-drawer');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it.each([{ ...project, curated: false }, { ...project, workspaceOnly: true }])('does not read or activate unavailable project boards', async owner => {
    render(<RuntimeActivityProvider><Harness owner={owner} /></RuntimeActivityProvider>);
    expect(screen.getByRole('button', { name: 'Focus' })).toBeDisabled();
    expect(api.kanbanBoard).not.toHaveBeenCalled();
  });
  it('waits for loading and enables through the shared mutation lock', async () => {
    board.enabled = false;
    let resolve!: (value: KanbanBoard) => void;
    vi.mocked(api.kanbanBoard).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<RuntimeActivityProvider><Harness /></RuntimeActivityProvider>);
    expect(screen.queryByRole('button', { name: 'Enable board' })).not.toBeInTheDocument();
    await act(async () => resolve(structuredClone(board)));
    const enable = screen.getByRole('button', { name: 'Enable board' }); fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByRole('button', { name: 'Task 2' });
    expect(api.setKanbanBoardEnabled).toHaveBeenCalledExactlyOnceWith('p', true);
  });
  it('raises waiting sessions into Needs you, badges them and goes to their open terminal', async () => {
    const workspace = emptyWorkspace();
    workspace.panes.a = { id: 'a', projectId: 'p', title: 'Agent', kind: 'codex', state: 'running', cwd: '/synthetic', sessionId: 's-1', runtimeId: 'r' };
    const onFocusPane = vi.fn();
    await show({ workspace, onFocusPane });
    const button = within(screen.getByRole('navigation')).getByRole('button', { name: 'Focus' });
    expect(button.querySelector('.activity-badge')).toBeNull();
    act(() => { runtime.begin('a', 'lease', 'r', false, false); runtime.observe('a', 'lease', {
      type: 'agentActivity', runtimeId: 'r', generation: 'test', revision: 1, observation: 'awaitingInput', validForMs: 30000,
    }); });
    await waitFor(() => expect(within(button).getByLabelText('Focus: 1')).toHaveTextContent('1'));
    expect(names('Needs you')).toEqual(['Task 1']);
    expect(names('Up next')).not.toContain('Task 1');
    fireEvent.click(within(section('Needs you')).getByRole('button', { name: /Go to terminal/ }));
    expect(onFocusPane).toHaveBeenCalledExactlyOnceWith('a');
  });
  it('starts the next task: moves it to In progress, then opens the launcher', async () => {
    const onStart = vi.fn(); await show({ onStart });
    fireEvent.click(within(section('Up next')).getAllByRole('button', { name: 'Start' })[0]);
    await waitFor(() => expect(onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'card-1' }), project));
    expect(api.moveKanbanCard).toHaveBeenCalledExactlyOnceWith('card-1', 'column-2', 1);
    await waitFor(() => expect(names('In progress')).toEqual(['Task 2', 'Task 1']));
    expect(await within(panel()).findByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
  it('resumes in-progress work that has no open terminal', async () => {
    const onResume = vi.fn(); await show({ onResume });
    fireEvent.click(within(section('In progress')).getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 's-2' }));
  });
  it('quick-add creates a Todo task on Enter and cancels on Escape', async () => {
    await show();
    fireEvent.click(within(panel()).getByRole('button', { name: 'New task' }));
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'Task title' }), { target: { value: 'Plan a small change' } });
    fireEvent.keyDown(within(panel()).getByRole('textbox'), { key: 'Enter', isComposing: true });
    fireEvent.submit(panel().querySelector('.kanban-quick-add form')!);
    await waitFor(() => expect(api.createKanbanCard).toHaveBeenCalledExactlyOnceWith('column-1', 'Plan a small change', ''));
    fireEvent.click(within(panel()).getByRole('button', { name: 'New task' }));
    fireEvent.keyDown(within(panel()).getByRole('textbox'), { key: 'Escape' });
    expect(within(panel()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.createKanbanCard).toHaveBeenCalledOnce();
  });
  it('shares snapshots, mutations and polling with the full board', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<RuntimeActivityProvider><Harness full /></RuntimeActivityProvider>); });
    expect(api.kanbanBoard).toHaveBeenCalledOnce();
    const main = document.querySelector<HTMLElement>('.project-board')!;
    await act(async () => { fireEvent.keyDown(within(main).getByRole('button', { name: 'Task 1' }), { key: 'ArrowRight', altKey: true }); });
    expect(api.kanbanBoard).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(names('In progress')).toEqual(['Task 2', 'Task 1']);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.kanbanBoard).toHaveBeenCalledTimes(3);
    await act(async () => fireEvent.focus(window));
    expect(api.kanbanBoard).toHaveBeenCalledTimes(4);
  });
  it('drops a start that finishes after switching projects and permits a new mutation there', async () => {
    const nextProject = { ...project, id: 'next', name: 'Next project' };
    const nextBoard = kanbanFixture('next', sessions.map(session => ({ ...session, projectId: 'next', title: 'Next ' + session.title })));
    vi.mocked(api.kanbanBoard).mockImplementation(async id => structuredClone(id === 'next' ? nextBoard : board));
    let finish!: () => void;
    vi.mocked(api.moveKanbanCard).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(structuredClone(board.cards[1])); }));
    const onStart = vi.fn();
    const view = await show({ onStart });
    fireEvent.click(within(section('Up next')).getAllByRole('button', { name: 'Start' })[0]);
    view.rerender(<RuntimeActivityProvider><Harness owner={nextProject} onStart={onStart} /></RuntimeActivityProvider>);
    await screen.findByRole('button', { name: 'Next Task 2' });
    await act(async () => finish());
    expect(onStart).not.toHaveBeenCalled();
    const start = within(section('Up next')).getAllByRole('button', { name: 'Start' })[0];
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: 'next' }), nextProject));
  });
  it('saves a drawer edit before starting and keeps the drawer when saving fails', async () => {
    const onStart = vi.fn(); await show({ onStart });
    fireEvent.click(within(section('Up next')).getByRole('button', { name: 'Task 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Updated plan' } });
    vi.mocked(api.editKanbanCard).mockRejectedValueOnce('Synthetic save failure');
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    await screen.findByRole('button', { name: 'Not saved. Try again' }); expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Updated plan');
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Updated plan' }), project));
  });
});
