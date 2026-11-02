import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { HistoryView } from './components/History';
import { Dialog } from './components/Dialog';
import { SessionTrash } from './components/SessionTrash';
import userEvent from '@testing-library/user-event';
import type { Session } from './types';

vi.mock('./api', () => ({
  api: { sessions: vi.fn(), transcript: vi.fn(), trashSession: vi.fn(), restoreSession: vi.fn(), prepareSessionOsTrash: vi.fn(), executeSessionOsTrash: vi.fn(), osTrashed: vi.fn(), restoreOsTrashed: vi.fn(), forgetOsTrashed: vi.fn(), scan: vi.fn(), trash: vi.fn(), stop: vi.fn(), launch: vi.fn() },
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
  vi.mocked(api.osTrashed).mockResolvedValue([]);
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
  expect(screen.getByText('原始 Agent 歷史會保留，執行中的工作會繼續。要連 Agent 的檔案一起刪除，選「移到系統垃圾桶…」，確認檔案清單後才會搬移。')).toBeInTheDocument();
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

const plan = (extra: Partial<Awaited<ReturnType<typeof api.prepareSessionOsTrash>>> = {}) => ({ planId: 'plan-1',
  trashId: entry.id, sessionId: session.id, kind: 'codex' as const, sourceRoot: entry.sourceRoot,
  items: [{ relativePath: 'sessions/synthetic.jsonl', directory: false, bytes: 42, entries: 0 }],
  kept: ['history.jsonl（共享輸入歷史）'], blockers: [], ...extra });
it('moves a confirmed plan to the OS trash by plan ID only', async () => {
  vi.mocked(api.prepareSessionOsTrash).mockResolvedValue(plan());
  vi.mocked(api.executeSessionOsTrash).mockResolvedValue({ moved: ['sessions/synthetic.jsonl'], failed: [] });
  const changed = vi.fn();
  render(<SessionTrash onClose={vi.fn()} onChanged={changed} refreshToken={0} />);
  fireEvent.click(await screen.findByRole('button', { name: '移到系統垃圾桶 Synthetic work' }));
  expect(await screen.findByText('sessions/synthetic.jsonl')).toBeInTheDocument();
  expect(api.prepareSessionOsTrash).toHaveBeenCalledExactlyOnceWith(entry.id);
  expect(screen.getByText('history.jsonl（共享輸入歷史）')).toBeInTheDocument();
  const move = screen.getByRole('button', { name: '移到系統垃圾桶' });
  expect(move).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(move);
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(api.executeSessionOsTrash).toHaveBeenCalledExactlyOnceWith('plan-1');
  expect(await screen.findByRole('button', { name: '還原 Synthetic work' })).toBeInTheDocument();
});
it('moves a Session to the OS trash in one step and keeps Undo when backing out', async () => {
  vi.mocked(api.prepareSessionOsTrash).mockResolvedValue({ planId: 'plan-1', trashId: entry.id, sessionId: session.id, kind: 'codex',
    sourceRoot: '/synthetic', items: [{ relativePath: 'sessions/synthetic.jsonl', directory: false, bytes: 42, entries: 0 }], kept: [], blockers: [] });
  vi.mocked(api.executeSessionOsTrash).mockResolvedValue({ moved: ['sessions/synthetic.jsonl'], failed: [] });
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  fireEvent.click(screen.getByRole('button', { name: '移到系統垃圾桶…' }));
  expect(await screen.findByText('sessions/synthetic.jsonl')).toBeInTheDocument();
  expect(api.trashSession).toHaveBeenCalledExactlyOnceWith(session.id, session.trashIdentity);
  expect(api.prepareSessionOsTrash).toHaveBeenCalledWith(entry.id);
  fireEvent.click(screen.getByRole('button', { name: '返回資源回收筒' }));
  expect(await screen.findByRole('button', { name: '復原刪除' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  fireEvent.click(screen.getByRole('button', { name: '移到系統垃圾桶…' }));
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '移到系統垃圾桶' }));
  await waitFor(() => expect(api.executeSessionOsTrash).toHaveBeenCalledExactlyOnceWith('plan-1'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('explains the OpenCode export-then-delete path without a fake file size', async () => {
  vi.mocked(api.prepareSessionOsTrash).mockResolvedValue({ planId: 'plan-oc', trashId: entry.id, sessionId: session.id, kind: 'opencode',
    sourceRoot: '/synthetic/xdg/opencode', items: ['ses_root', 'ses_child', 'ses_grandchild'].map(id => ({ relativePath: `opencode-session-${id}.json（先以官方 CLI 匯出，再刪除資料庫中的 Session）`, directory: false, bytes: 0, entries: 0 })),
    kept: ['opencode.db（共享資料庫）'], blockers: [] });
  render(<SessionTrash onClose={vi.fn()} onChanged={vi.fn()} refreshToken={0} />);
  fireEvent.click(await screen.findByRole('button', { name: '移到系統垃圾桶 Synthetic work' }));
  expect(await screen.findByText(/OpenCode 2.x 也會刪除所有後代 Session/)).toBeInTheDocument();
  expect(screen.getByText(/還原需要相同的 CLI 主版本/)).toBeInTheDocument();
  for (const id of ['ses_root', 'ses_child', 'ses_grandchild']) expect(screen.getByText(new RegExp(`opencode-session-${id}`))).toBeInTheDocument();
  expect(screen.queryByText(/0 B/)).not.toBeInTheDocument();
});
it('lists OS-trashed Sessions by title and restores them before rescanning', async () => {
  const moved = { id: 'moved-1', title: 'Moved synthetic work', kind: 'claude' as const, externalId: 'synthetic-uuid',
    sourceRoot: '/synthetic/root', movedAt: 1_793_000_000,
    items: [{ relativePath: 'projects/p/synthetic-uuid.jsonl', inTrash: true }, { relativePath: 'debug/synthetic-uuid.txt', inTrash: false }] };
  vi.mocked(api.osTrashed).mockResolvedValueOnce([moved]).mockResolvedValue([]);
  vi.mocked(api.restoreOsTrashed).mockResolvedValue({ moved: ['projects/p/synthetic-uuid.jsonl'], failed: [] });
  vi.mocked(api.scan).mockResolvedValue({} as never);
  const changed = vi.fn();
  render(<SessionTrash onClose={vi.fn()} onChanged={changed} refreshToken={0} />);
  expect(await screen.findByText('Moved synthetic work')).toBeInTheDocument();
  expect(screen.getByText(/1／2 項仍在垃圾桶/)).toBeInTheDocument();
  expect(screen.getByText(/debug\/synthetic-uuid.txt（已刪除）/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '從系統垃圾桶還原 Moved synthetic work' }));
  expect(await screen.findByText(/已還原「Moved synthetic work」/)).toBeInTheDocument();
  expect(api.restoreOsTrashed).toHaveBeenCalledExactlyOnceWith('moved-1');
  expect(api.scan).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalled();
});
it('blocks execution while the plan has blockers and refreshes after a failure', async () => {
  vi.mocked(api.prepareSessionOsTrash).mockResolvedValueOnce(plan({ planId: '', blockers: ['Synthetic running blocker'] }));
  render(<SessionTrash onClose={vi.fn()} onChanged={vi.fn()} refreshToken={0} />);
  fireEvent.click(await screen.findByRole('button', { name: '移到系統垃圾桶 Synthetic work' }));
  expect(await screen.findByText('Synthetic running blocker')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '移到系統垃圾桶' })).toBeDisabled();
  vi.mocked(api.prepareSessionOsTrash).mockResolvedValue(plan());
  vi.mocked(api.executeSessionOsTrash).mockRejectedValueOnce(new Error('Files changed'));
  fireEvent.click(screen.getByRole('button', { name: '重新檢查' }));
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '移到系統垃圾桶' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Files changed');
  await waitFor(() => expect(api.prepareSessionOsTrash).toHaveBeenCalledTimes(3));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
it('discards a closed review response', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.prepareSessionOsTrash>>) => void;
  vi.mocked(api.prepareSessionOsTrash).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<SessionTrash onClose={vi.fn()} onChanged={vi.fn()} refreshToken={0} />);
  fireEvent.click(await screen.findByRole('button', { name: '移到系統垃圾桶 Synthetic work' }));
  expect(screen.getByRole('button', { name: '重新檢查' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '返回資源回收筒' }));
  await act(async () => resolve(plan({ blockers: ['Stale result'] })));
  expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
});
it('returns keyboard focus through inspection and restores the original modal launcher', async () => {
  const user = userEvent.setup();
  vi.mocked(api.prepareSessionOsTrash).mockImplementation(() => new Promise(() => {}));
  const launcher = document.createElement('button');
  launcher.textContent = 'Synthetic launcher';
  document.body.append(launcher);
  launcher.focus();
  const close = vi.fn();
  const view = render(<SessionTrash onClose={close} onChanged={vi.fn()} refreshToken={0} />);
  const inspect = await screen.findByRole('button', { name: '移到系統垃圾桶 Synthetic work' });
  await user.click(inspect);
  expect(screen.getByRole('button', { name: '返回資源回收筒' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: '移到系統垃圾桶 Synthetic work' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(launcher).toHaveFocus();
  launcher.remove();
});

it('keeps consecutive deletions queued in a portal toast and restores each original id', async () => {
  vi.mocked(api.trashSession).mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  const { container } = render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  for (let index = 0; index < 2; index++) {
    fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
    fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '復原刪除' })).toBeEnabled());
  }
  expect(screen.getByText('還有 1 筆可依序復原。')).toBeInTheDocument();
  expect(container.querySelector('.history-undo')).toBeNull();
  expect(document.body.querySelector('.toast.history-undo')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '復原刪除' }));
  await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith('first'));
  await waitFor(() => expect(screen.queryByText('還有 1 筆可依序復原。')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: '復原刪除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '復原刪除' }));
  await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith('second'));
});

it('preserves queued Undo and rejects synthetic actions while another delete dialog is open', async () => {
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  const undo = await screen.findByRole('button', { name: '復原刪除' });
  await waitFor(() => expect(undo).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '刪除 Session' }));
  expect(document.querySelector('.history-undo')).toHaveAttribute('inert');
  fireEvent.click(undo);
  fireEvent.click(document.querySelector('.history-undo button[aria-label="關閉復原提示"]')!);
  expect(api.restoreSession).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(document.querySelector('.history-undo')).not.toHaveAttribute('inert');
  fireEvent.click(undo);
  await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith(entry.id));
});
