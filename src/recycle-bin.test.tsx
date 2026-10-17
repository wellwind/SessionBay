import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { HistoryView } from './components/History';
import { SessionTrash } from './components/SessionTrash';
import type { Session } from './types';

vi.mock('./api', () => ({
  api: { sessions: vi.fn(), transcript: vi.fn(), trashSession: vi.fn(), restoreSession: vi.fn(), trash: vi.fn(), stop: vi.fn(), launch: vi.fn() },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
const session: Session = { id: 'real-catalog-id', trashIdentity: 'displayed-source-token', sourceId: 'source', kind: 'codex', externalId: 'real-external-id', projectId: 'project', title: 'Synthetic work', cwd: '/synthetic', updatedAt: '2026-10-16T12:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: null };
const entry = { id: 'provenance-trash-id', session, deletedAt: session.updatedAt, sourceRoot: '/synthetic/source', unavailableReason: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sessions).mockResolvedValue({ items: [session], total: 1 });
  vi.mocked(api.transcript).mockResolvedValue({ messages: [], hasMore: false, beforeLine: null, stale: false, warning: null });
  vi.mocked(api.trashSession).mockResolvedValue(entry.id);
  vi.mocked(api.restoreSession).mockResolvedValue();
  vi.mocked(api.trash).mockResolvedValue({ items: [entry], total: 1 });
});
it('confirms recoverable deletion, supports undo and never stops or launches runtime', async () => {
  const changed = vi.fn();
  render(<HistoryView projects={[]} refreshToken={0} onResume={vi.fn()} onNew={vi.fn()} onHistoryChanged={changed} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  expect(screen.getByText('原始 Agent 歷史會保留，執行中的工作會繼續。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.trashSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '刪除 Session' }));
  vi.mocked(api.sessions).mockResolvedValue({ items: [], total: 0 });
  fireEvent.click(screen.getByRole('button', { name: '確認移入資源回收筒' }));
  fireEvent.click(await screen.findByRole('button', { name: '復原刪除' }));
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
  vi.mocked(api.trash).mockResolvedValue({ items: [entry, missing], total: 2 });
  const changed = vi.fn();
  render(<SessionTrash onClose={vi.fn()} onChanged={changed} refreshToken={0} />);
  expect(await screen.findByRole('button', { name: '還原 Missing work' })).toBeDisabled();
  expect(screen.getByText('Reconnect original source')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '還原 Synthetic work' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(api.restoreSession).toHaveBeenCalledWith(entry.id);
  expect(screen.queryByRole('button', { name: /永久|清空/ })).not.toBeInTheDocument();
});
it('ignores stale trash loads after page navigation and corrects an emptied last page', async () => {
  vi.mocked(api.trash).mockImplementation(async (offset) => offset === 40 ? { items: [{ ...entry, id: 'last' }], total: 41 } : { items: [entry], total: 41 });
  render(<SessionTrash onClose={vi.fn()} onChanged={vi.fn()} refreshToken={0} />);
  await screen.findByRole('button', { name: '還原 Synthetic work' });
  fireEvent.click(screen.getByRole('button', { name: '下一頁' }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledWith(40, 40));
  await waitFor(() => expect(within(screen.getByLabelText('資源回收筒清單')).getByRole('button')).toBeEnabled());
  vi.mocked(api.trash).mockResolvedValue({ items: [entry], total: 40 });
  fireEvent.click(screen.getByRole('button', { name: '還原 Synthetic work' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled());
  expect(api.restoreSession).toHaveBeenCalledWith('last');
});

it('keeps the displayed provenance through background refresh and rejects stale confirmation safely', async () => {
  const props = { projects: [], refreshToken: 0, onResume: vi.fn(), onNew: vi.fn() };
  const view = render(<HistoryView {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '刪除 Session' }));
  vi.mocked(api.sessions).mockResolvedValue({ items: [{ ...session, trashIdentity: 'replacement-source-token', title: 'Replacement session' }], total: 1 });
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
