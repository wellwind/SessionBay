import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionFeed } from './use-session-feed';

const rows = () => Array.from({ length: 85 }, (_, i) => ({ id: `row-${i}` }));
describe('catalog snapshot batches', () => {
  it.each(['delete', 'insert', 'sort'] as const)('refetches the loaded range after a cross-batch %s without waiting for index polling', async change => {
    let data = rows();
    let catalogRevision = '1';
    const fetch = vi.fn(async (offset: number, limit: number) => ({ catalogRevision, items: data.slice(offset, offset + limit), total: data.length }));
    const { result } = renderHook(() => useSessionFeed('all', 'unchanged-ui-revision', fetch));
    await waitFor(() => expect(result.current.offset).toBe(40));
    if (change === 'delete') data.splice(10, 1);
    if (change === 'insert') data.unshift({ id: 'inserted' });
    if (change === 'sort') data = [data[60], ...data.filter((_, i) => i !== 60)];
    catalogRevision = '2';
    act(() => { result.current.loadMore(); result.current.loadMore(); });
    await waitFor(() => expect(result.current.offset).toBe(80));
    expect(result.current.items).toEqual(data.slice(0, 80));
    expect(result.current.catalogRevision).toBe('2');
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 40, 0, 40]);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.items).toEqual(data);
  });

  it('does not consume an empty changed-snapshot tail as done or collapse the old range before reset completes', async () => {
    const data = rows();
    let resolve!: (value: { catalogRevision: string; items: { id: string }[]; total: number }) => void;
    const reset = new Promise<Parameters<typeof resolve>[0]>(done => { resolve = done; });
    const fetch = vi.fn().mockResolvedValueOnce({ catalogRevision: '1', items: data.slice(0, 40), total: 85 })
      .mockResolvedValueOnce({ catalogRevision: '2', items: [], total: 20 }).mockReturnValueOnce(reset);
    const { result } = renderHook(() => useSessionFeed('all', '0', fetch));
    await waitFor(() => expect(result.current.offset).toBe(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(result.current.done).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual(data.slice(0, 40));
    await act(async () => resolve({ catalogRevision: '2', items: data.slice(65), total: 20 }));
    expect(result.current.done).toBe(true);
    expect(result.current.items).toEqual(data.slice(65));
    expect(fetch.mock.calls.map(call => call[0])).toEqual([0, 40, 0]);
  });

  it('bounds restarts during ongoing indexing, preserves coherent rows, and retries once the catalog stabilizes', async () => {
    const data = rows();
    let revision = 0;
    let changing = true;
    const fetch = vi.fn(async (offset: number, limit: number) => ({ catalogRevision: String(changing ? ++revision : revision), items: data.slice(offset, offset + limit), total: data.length }));
    const { result } = renderHook(() => useSessionFeed('all', '0', fetch));
    await waitFor(() => expect(result.current.offset).toBe(40));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.items).toEqual(data.slice(0, 40));
    expect(result.current.catalogRevision).toBe('1');
    expect(result.current.done).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(6);
    act(() => result.current.loadMore());
    expect(fetch).toHaveBeenCalledTimes(6);
    changing = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.offset).toBe(80));
    expect(result.current.catalogRevision).toBe('6');
    expect(result.current.error).toBe('');
  });

  it('fails closed when an IPC response lacks a catalog revision', async () => {
    const fetch = vi.fn().mockResolvedValue({ items: rows().slice(0, 40), total: 85 });
    const { result } = renderHook(() => useSessionFeed('all', '0', fetch));
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(result.current.items).toEqual([]);
    expect(result.current.done).toBe(false);
  });
});
