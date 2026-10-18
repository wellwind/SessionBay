import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectQuickSwitcher } from './components/ProjectQuickSwitcher';
import { api } from './api';
import type { Session, SessionPage } from './types';
vi.mock('./api', () => ({ api: { sessions: vi.fn(), searchWorkspaceFiles: vi.fn() }, errorMessage: String }));
const session = (id: string, projectId = 'p'): Session => ({ id, projectId, title: `History ${id}`, kind: 'codex', externalId: id,
  sourceId: 'source', cwd: '/synthetic', updatedAt: '2026-10-18T00:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: 'needle' });
const props = () => ({ projectId: 'p', opened: [{ id: 'file:src/needle.ts', label: 'src/needle.ts', search: 'src/needle.ts', run: vi.fn() },
  { id: 'runtime:terminal', label: 'Terminal', search: 'Terminal', run: vi.fn() }], openedSessionIds: ['open'], onOpenFile: vi.fn(), onOpenSession: vi.fn() });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(api.sessions).mockResolvedValue({ items: [session('open'), session('unopened')], total: 2, catalogRevision: 'r' });
  vi.mocked(api.searchWorkspaceFiles).mockResolvedValue({ paths: ['src/needle.ts', 'deep/needle.ts'], truncated: false });
});
afterEach(() => vi.useRealTimers());
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };
it('combines existing tabs, unopened catalog sessions and unloaded files without duplicates or launches', async () => {
  const p = props(); render(<ProjectQuickSwitcher {...p} />); await settle();
  expect(api.sessions).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', limit: 40, offset: 0 }));
  expect(screen.getAllByRole('option')).toHaveLength(4);
  fireEvent.click(screen.getByRole('option', { name: /History unopened/ }));
  expect(p.onOpenSession).toHaveBeenCalledWith(session('unopened'));
  fireEvent.click(screen.getByRole('option', { name: /deep\/needle/ }));
  expect(p.onOpenFile).toHaveBeenCalledWith('deep/needle.ts');
  fireEvent.click(screen.getByRole('option', { name: 'Terminal' }));
  expect(p.opened[1].run).toHaveBeenCalledOnce();
});
it('retains full-text catalog matches and ignores stale project/query results', async () => {
  let resolve!: (value: SessionPage) => void;
  vi.mocked(api.sessions).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const p = props(); const view = render(<ProjectQuickSwitcher {...p} />); await settle();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'needle' } }); await settle();
  expect(screen.getByRole('option', { name: /History unopened/ })).toBeInTheDocument();
  await act(async () => resolve({ items: [session('stale')], total: 1, catalogRevision: 'r' }));
  expect(screen.queryByText('History stale')).not.toBeInTheDocument();
  view.rerender(<ProjectQuickSwitcher {...p} projectId="other" />);
  expect(screen.queryByText('History unopened')).not.toBeInTheDocument();
  await settle(); expect(api.searchWorkspaceFiles).toHaveBeenLastCalledWith('other', 'needle');
});
it('supports arrow selection, IME guards and partial failures with explicit bounds', async () => {
  vi.mocked(api.sessions).mockResolvedValue({ items: [session('unopened')], total: 80, catalogRevision: 'r' });
  vi.mocked(api.searchWorkspaceFiles).mockResolvedValue({ paths: [], truncated: true });
  const p = props(); render(<ProjectQuickSwitcher {...p} />); await settle();
  expect(screen.getByText(/最近 40/)).toBeInTheDocument();
  expect(screen.getByText(/搜尋已達/)).toBeInTheDocument();
  const input = screen.getByRole('combobox');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' });
  expect(p.opened[1].run).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' });
  expect(p.opened[1].run).toHaveBeenCalledOnce();
  vi.mocked(api.searchWorkspaceFiles).mockRejectedValue(new Error('file unavailable'));
  fireEvent.change(input, { target: { value: 'History' } }); await settle();
  expect(screen.getByRole('alert')).toHaveTextContent('file unavailable');
  expect(screen.getByRole('option', { name: /History unopened/ })).toBeInTheDocument();
});
