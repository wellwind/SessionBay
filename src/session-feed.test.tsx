import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionFeed } from './use-session-feed';
import { VirtualSessionList } from './components/VirtualSessionList';

const rows = (offset: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `row-${offset + i}` }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
describe('incremental session requests', () => {
  it('retries a failed refresh batch without collapsing the old range', async () => {
    const fetch = vi.fn(async (offset: number) => ({ catalogRevision: 'fixture', items: rows(offset, 40), total: 10000 }));
    const { result, rerender } = renderHook(({ revision }) => useSessionFeed('all', revision, fetch), { initialProps: { revision: '0' } });
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(80));
    fetch.mockResolvedValueOnce({ catalogRevision: 'fixture', items: rows(0, 40), total: 10000 }).mockRejectedValueOnce(new Error('refresh failed'));
    rerender({ revision: '1' });
    await waitFor(() => expect(result.current.error).toContain('refresh failed'));
    expect(result.current.items).toHaveLength(80);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('');
    expect(result.current.items).toHaveLength(80);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 40, 0, 40, 40]);
  });
  it('discards a staged refresh when navigation changes before its second batch completes', async () => {
    const old = deferred<{ catalogRevision: string; items: { id: string }[]; total: number }>();
    const fetch = vi.fn(async (offset: number) => ({ catalogRevision: 'fixture', items: rows(offset, 40), total: 10000 }));
    const { result, rerender } = renderHook(({ key, revision }) => useSessionFeed(key, revision, fetch), { initialProps: { key: 'a', revision: '0' } });
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(80));
    fetch.mockResolvedValueOnce({ catalogRevision: 'fixture', items: rows(0, 40), total: 10000 }).mockReturnValueOnce(old.promise);
    rerender({ key: 'a', revision: '1' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    fetch.mockResolvedValueOnce({ catalogRevision: 'fixture', items: rows(900, 1), total: 1 });
    rerender({ key: 'b', revision: '1' });
    await waitFor(() => expect(result.current.items[0].id).toBe('row-900'));
    await act(async () => old.resolve({ catalogRevision: 'fixture', items: rows(40, 40), total: 10000 }));
    expect(result.current.items.map(item => item.id)).toEqual(['row-900']);
  });
  it('refreshes only the previously loaded range in batches without collapsing its geometry', async () => {
    const fetch = vi.fn(async (offset: number) => ({ catalogRevision: 'fixture', items: rows(offset, 40), total: 10000 }));
    const { result, rerender } = renderHook(({ revision }) => useSessionFeed('all', revision, fetch), { initialProps: { revision: '0' } });
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(80));
    rerender({ revision: '1' });
    expect(result.current.items).toHaveLength(80);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(80);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 40, 0, 40]);
  });
  it('loads only one bounded batch until requested and deduplicates simultaneous triggers and rows', async () => {
    const next = deferred<{ catalogRevision: string; items: { id: string }[]; total: number }>();
    const fetch = vi.fn().mockResolvedValueOnce({ catalogRevision: 'fixture', items: rows(0, 40), total: 10000 }).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useSessionFeed('all', '0', fetch));
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(0, 40);
    act(() => { result.current.loadMore(); result.current.loadMore(); result.current.loadMore(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve({ catalogRevision: 'fixture', items: rows(39, 40), total: 10000 }));
    expect(result.current.items).toHaveLength(79);
    expect(result.current.offset).toBe(80);
    expect(result.current.done).toBe(false);
  });
  it('ignores obsolete successes and resets offsets on filter/revision changes', async () => {
    const old = deferred<{ catalogRevision: string; items: { id: string }[]; total: number }>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ catalogRevision: 'fixture', items: rows(100, 2), total: 2 });
    const { result, rerender } = renderHook(({ key, revision }) => useSessionFeed(key, revision, fetch), { initialProps: { key: 'old', revision: '0' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender({ key: 'new', revision: '0' });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('row-100'));
    await act(async () => old.resolve({ catalogRevision: 'fixture', items: rows(0, 40), total: 10000 }));
    expect(result.current.items[0].id).toBe('row-100');
    rerender({ key: 'new', revision: '1' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.every(call => call[0] === 0 && call[1] === 40)).toBe(true);
  });
  it('keeps loaded rows on error, retries the same offset, and stops on an empty response', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ catalogRevision: 'fixture', items: rows(0, 40), total: 100 })
      .mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValueOnce({ catalogRevision: 'fixture', items: [], total: 100 });
    const { result } = renderHook(() => useSessionFeed('all', '0', fetch));
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).toContain('synthetic failure'));
    expect(result.current.items).toHaveLength(40);
    act(() => { result.current.loadMore(); result.current.retry(); });
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(fetch.mock.calls).toEqual([[0, 40], [40, 40], [40, 40]]);
    act(() => result.current.loadMore());
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('restores recent navigation data without fetching every preceding batch', async () => {
    const fetch = vi.fn().mockResolvedValue({ catalogRevision: 'fixture', items: rows(0, 40), total: 10000 });
    const { result, rerender } = renderHook(({ key }) => useSessionFeed(key, '0', fetch), { initialProps: { key: 'a' } });
    await waitFor(() => expect(result.current.items).toHaveLength(40));
    rerender({ key: 'b' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    rerender({ key: 'a' });
    expect(result.current.items).toHaveLength(40);
    expect(result.current.loading).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('reverse Tab reaches the last action and disabled-only rows never trap focus', () => {
  render(<VirtualSessionList items={rows(0, 3)} total={3} label="Keyboard sessions" className="test-list"
    rowHeight={190} scrollMemory={{ top: 0 }} loading={false} done error="" loadMore={vi.fn()} retry={vi.fn()}
    renderRow={item => <><button disabled={item.id === 'row-1'}>{item.id} select</button><button disabled={item.id === 'row-1'}>{item.id} delete</button></>} />);
  const last = screen.getByRole('button', { name: 'row-2 select' });
  act(() => last.focus());
  fireEvent.keyDown(last, { key: 'Tab', shiftKey: true });
  const disabledRow = screen.getAllByRole('listitem')[1];
  expect(disabledRow).toHaveFocus();
  fireEvent.keyDown(disabledRow, { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'row-0 delete' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('button', { name: 'row-0 delete' }), { key: 'Tab' });
  expect(disabledRow).toHaveFocus();
  fireEvent.keyDown(disabledRow, { key: 'Tab' });
  expect(last).toHaveFocus();
});

it('bounds 10000-row DOM, restores scroll, and mounts keyboard targets outside the current window', async () => {
  const memory = { top: 0 };
  const props = { catalogRevision: 'fixture', items: rows(0, 10000), total: 10000, label: 'Synthetic sessions', className: 'test-list',
    rowHeight: 190, scrollMemory: memory, loading: false, done: true, error: '', loadMore: vi.fn(), retry: vi.fn(),
    renderRow: (item: { id: string }) => <button>{item.id}</button> };
  const view = render(<VirtualSessionList {...props} />);
  const list = screen.getByRole('list');
  expect(screen.getAllByRole('listitem').length).toBeLessThan(15);
  fireEvent.scroll(list, { target: { scrollTop: 190 * 5000 } });
  expect(screen.getAllByRole('listitem').length).toBeLessThan(15);
  expect(screen.getByText('row-5000')).toBeInTheDocument();
  fireEvent.keyDown(list, { key: 'End' });
  await waitFor(() => expect(screen.getByText('row-9999')).toHaveFocus());
  expect(screen.getAllByRole('listitem').length).toBeLessThan(15);
  view.unmount();
  render(<VirtualSessionList {...props} />);
  expect(screen.getByRole('list').scrollTop).toBe(memory.top);
});
