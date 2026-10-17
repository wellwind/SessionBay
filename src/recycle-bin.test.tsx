import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { HistoryView } from './components/History';
import { Dialog } from './components/Dialog';
import { SessionTrash } from './components/SessionTrash';
import userEvent from '@testing-library/user-event';
import type { Session } from './types';

vi.mock('./api', () => ({
  api: { sessions: vi.fn(), transcript: vi.fn(), trashSession: vi.fn(), restoreSession: vi.fn(), trash: vi.fn(), stop: vi.fn(), launch: vi.fn() },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
const session: Session = { id: 'real-catalog-id', trashIdentity: 'displayed-source-token', sourceId: 'source', kind: 'codex', externalId: 'real-external-id', projectId: 'project', title: 'Synthetic work', cwd: '/synthetic', updatedAt: '2026-10-16T12:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: null };
const entry = { id: 'provenance-trash-id', session, deletedAt: session.updatedAt, sourceRoot: '/synthetic/source', unavailableReason: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [session], total: 1 });
  vi.mocked(api.transcript).mockResolvedValue({ messages: [], hasMore: false, beforeLine: null, stale: false, warning: null });
  vi.mocked(api.trashSession).mockResolvedValue(entry.id);
  vi.mocked(api.restoreSession).mockResolvedValue();
  vi.mocked(api.trash).mockResolvedValue({ catalogRevision: 'fixture', items: [entry], total: 1 });
});
it('defaults recoverable delete to confirm, preserves Escape and prevents pending duplicate Enter', async () => {
  const user = userEvent.setup();
  let resolve!: (id: string) => void;
  vi.mocked(api.trashSession).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  const opener = await screen.findByRole('button', { name: '刪除 Session' });
  opener.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: '確認移入資源回收筒' })).toHaveFocus();
  expect(api.trashSession).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(opener).toHaveFocus();
  await user.keyboard('{Enter}');
  await user.keyboard('{Enter}{Enter}');
  expect(api.trashSession).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '確認移入資源回收筒' })).toBeDisabled();
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  await act(async () => resolve(entry.id));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('confirms recoverable deletion, supports undo and never stops or launches runtime', async () => {
  const changed = vi.fn();
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} onHistoryChanged={changed} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  expect(screen.getByText('原始 Agent 歷史會保留，執行中的工作會繼續。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.trashSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '刪除 Session' }));
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  const undo = await screen.findByRole('button', { name: '復原刪除' });
  const dismiss = screen.getByRole('button', { name: '關閉復原提示' });
  expect(undo.parentElement).toBe(dismiss.parentElement);
  expect(undo.parentElement).toHaveClass('history-undo-actions');
  expect(dismiss).not.toHaveTextContent('×');
  fireEvent.click(undo);
  await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith(entry.id));
  expect(api.trashSession).toHaveBeenCalledWith(session.id, session.trashIdentity);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(api.stop).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
});
it('keeps failed moves reviewable and prevents repeated mutation while pending', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(api.trashSession).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  const confirm = screen.getByRole('button', { name: '確認移入資源回收筒' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(api.trashSession).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Synthetic save failure')));
  expect(screen.getByRole('alert')).toHaveTextContent('Synthetic save failure');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByText('已移入資源回收筒。')).not.toBeInTheDocument();
});
it('shows missing-source tombstones and restores only an available provenance ID', async () => {
  const missing = { ...entry, id: 'missing', session: { ...session, title: 'Missing work' }, unavailableReason: 'Reconnect original source' };
  vi.mocked(api.trash).mockResolvedValue({ catalogRevision: 'fixture', items: [entry, missing], total: 2 });
  const changed = vi.fn();
  render(<SessionTrash onClose={vi.fn()} onChanged={changed} refreshToken={0} />);
  expect(await screen.findByRole('button', { name: '還原 Missing work' })).toBeDisabled();
  expect(screen.getByText('Reconnect original source')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '還原 Synthetic work' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(api.restoreSession).toHaveBeenCalledWith(entry.id);
  expect(screen.queryByRole('button', { name: /永久|清空/ })).not.toBeInTheDocument();
});
it('loads trash in bounded batches and resets after restore', async () => {
  vi.mocked(api.trash).mockResolvedValue({ catalogRevision: 'fixture', items: Array.from({ length: 40 }, (_, i) => ({ ...entry, id: 'trash-' + i,
    session: { ...session, title: 'Work ' + i } })), total: 100 });
  render(<SessionTrash onClose={vi.fn()} onChanged={vi.fn()} refreshToken={0} />);
  await screen.findByRole('button', { name: '還原 Work 0' });
  expect(api.trash).toHaveBeenCalledExactlyOnceWith(0, 40);
  expect(screen.queryByRole('button', { name: '下一頁' })).not.toBeInTheDocument();
  vi.mocked(api.trash).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '還原 Work 0' }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledTimes(2));
  expect(api.trash).toHaveBeenLastCalledWith(0, 40);
  expect(api.restoreSession).toHaveBeenCalledWith('trash-0');
});

it('keeps the displayed provenance through background refresh and rejects stale confirmation safely', async () => {
  const props = { projects: [], refreshToken: 0, onResume: vi.fn(), onNew: vi.fn() };
  const view = render(<HistoryView {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [{ ...session, trashIdentity: 'replacement-source-token', title: 'Replacement session' }], total: 1 });
  view.rerender(<HistoryView {...props} refreshToken={1} />);
  await screen.findAllByRole('heading', { name: 'Replacement session', level: 3 });
  vi.mocked(api.trashSession).mockRejectedValue(new Error('來源已變更'));
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('來源已變更');
  expect(api.trashSession).toHaveBeenCalledWith(session.id, 'displayed-source-token');
  expect(screen.queryByRole('button', { name: '復原刪除' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '刪除 Session' }));
  expect(within(screen.getByRole('dialog')).getByText(/Replacement session/)).toBeInTheDocument();
});
it('deletes directly from a sibling row action without selecting or resuming it', async () => {
  const second = { ...session, id: 'second', title: 'Other work', trashIdentity: 'second-token' };
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [session, second], total: 2 });
  const resume = vi.fn();
  render(<HistoryView projects={[]} refreshToken={0} onResume={resume} onNew={vi.fn()} />);
  const remove = await screen.findByRole('button', { name: '刪除 Session Other work' });
  expect(remove.closest('[role="listitem"]')).toHaveAttribute('role', 'listitem');
  expect(remove.closest('button')?.parentElement?.closest('button')).toBeNull();
  remove.focus();
  fireEvent.click(remove);
  expect(screen.getByRole('dialog')).toHaveTextContent('Other work');
  expect(api.transcript).not.toHaveBeenCalledWith('second');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(remove).toHaveFocus();
  expect(api.trashSession).not.toHaveBeenCalled();
  fireEvent.click(remove);
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [session], total: 1 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '復原刪除' })).toHaveFocus());
  expect(api.trashSession).toHaveBeenCalledWith('second', 'second-token');
  expect(resume).not.toHaveBeenCalled();
  expect(api.stop).not.toHaveBeenCalled();
});
it('disables list deletion without a source identity', async () => {
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [{ ...session, trashIdentity: undefined }], total: 1 });
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  expect(await screen.findByRole('button', { name: '刪除 Session Synthetic work' })).toBeDisabled();
});
it('does not reclaim focus after delayed history refresh when the user moved elsewhere', async () => {
  let finishRefresh!: () => void;
  const changed = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
  render(<><input aria-label="Another control" /><HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} onHistoryChanged={changed} /></>);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session Synthetic work' }));
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const control = screen.getByRole('textbox', { name: 'Another control' });
  control.focus();
  await act(async () => finishRefresh());
  expect(control).toHaveFocus();
  expect(screen.getByRole('button', { name: '復原刪除' })).toBeEnabled();
});
it('offers Undo focus after delayed refresh if no newer interaction owns focus', async () => {
  let finishRefresh!: () => void;
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()}
    onHistoryChanged={() => new Promise<void>(resolve => { finishRefresh = resolve; })} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session Synthetic work' }));
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await act(async () => finishRefresh());
  expect(screen.getByRole('button', { name: '復原刪除' })).toHaveFocus();
});

it.each(['blur', 'pointer', 'dialog'] as const)('relinquishes pending Undo focus after newer %s intent', async intent => {
  let finishRefresh!: () => void;
  const changed = () => new Promise<void>(resolve => { finishRefresh = resolve; });
  const frame = (showDialog = false) => <><input aria-label="Another control" />
    <HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} onHistoryChanged={changed} />
    {showDialog && <Dialog title="New dialog" onClose={() => {}}><button>New dialog action</button></Dialog>}
  </>;
  const view = render(frame());
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session Synthetic work' }));
  vi.mocked(api.sessions).mockResolvedValue({ catalogRevision: 'fixture', items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  if (intent === 'blur') {
    const control = screen.getByRole('textbox', { name: 'Another control' });
    control.focus(); control.blur();
  } else if (intent === 'pointer') fireEvent.pointerDown(document.body);
  else view.rerender(frame(true));
  const owner = document.activeElement;
  await act(async () => finishRefresh());
  expect(document.activeElement).toBe(owner);
  expect(screen.getByRole('button', { name: '復原刪除' })).not.toHaveFocus();
});
