import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export const SESSION_BATCH = 40;
interface Page<T> { items: T[]; total: number; catalogRevision: string }
interface Feed<T> extends Page<T> { offset: number; done: boolean; error: string; loading: boolean }
const empty = <T,>(): Feed<T> => ({ catalogRevision: '', items: [], total: 0, offset: 0, done: false, error: '', loading: true });

// One request per generation; offsets count server rows, not deduplicated rows.
export function useSessionFeed<T extends { id: string }>(key: string, revision: string,
  fetchPage: (offset: number, limit: number) => Promise<Page<T>>, disabled = false, delay = 0) {
  const cache = useRef(new Map<string, { revision: string; feed: Feed<T> }>());
  const generation = useRef(0);
  const current = useRef(empty<T>());
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const identity = `${key}\0${revision}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const [state, setState] = useState({ identity, feed: current.current });
  const request = useRef<(retry?: boolean) => void>(() => {});
  useEffect(() => {
    const token = ++generation.current;
    const entries = cache.current;
    let locked = false;
    const cached = entries.get(key);
    const refreshing = !!cached && cached.revision !== revision;
    let target = refreshing ? cached.feed.offset : 0;
    let staged = refreshing ? empty<T>() : null;
    current.current = cached ? { ...cached.feed, loading: refreshing && !disabled, error: '' } : { ...empty<T>(), loading: !disabled };
    const publish = (feed: Feed<T>) => {
      current.current = feed;
      entries.set(key, { revision: staged ? (cached?.revision ?? revision) : revision, feed });
      // Retain a bounded number of navigation contexts, never persist session data.
      if (entries.size > 8) entries.delete(entries.keys().next().value!);
      setState({ identity, feed });
    };
    const load = (retry = false) => {
      let previous = staged ?? current.current;
      if (disabled || locked || previous.done || (current.current.error && !retry)) return;
      locked = true;
      publish({ ...current.current, loading: true, error: '' });
      void (async () => {
        let resets = 0;
        while (true) {
          const result = await fetchRef.current(previous.offset, SESSION_BATCH);
          if (generation.current !== token || activeIdentity.current !== identity) return;
          if (!result.catalogRevision) throw new Error('無法確認索引版本，請重試載入。');
          if (previous.offset && previous.catalogRevision !== result.catalogRevision) {
            // Never apply a different snapshot's rows, count or terminal state.
            // Keep the visible geometry until the replacement range is complete.
            target = Math.max(target, current.current.offset + SESSION_BATCH);
            staged = empty<T>();
            previous = staged;
            publish({ ...current.current, done: false, loading: true });
            if (++resets >= 3) throw new Error('索引持續變更，請稍後重試載入。');
            continue;
          }
          const unique = new Map(previous.items.map(item => [item.id, item]));
          result.items.forEach(item => unique.set(item.id, item));
          const offset = previous.offset + result.items.length;
          const next = { items: [...unique.values()], total: result.total, offset,
            catalogRevision: result.catalogRevision,
            done: result.items.length === 0 || offset >= result.total, loading: false, error: '' };
          if (staged && offset < target && !next.done) {
            staged = next;
            previous = next;
          } else {
            staged = null;
            publish(next);
            return;
          }
        }
      })().catch(reason => {
        if (generation.current === token && activeIdentity.current === identity)
          publish({ ...current.current, loading: false, error: errorMessage(reason) });
      }).finally(() => { locked = false; });
    };
    request.current = load;
    publish(current.current);
    const timer = setTimeout(() => { if (refreshing || !current.current.offset) load(); }, delay);
    return () => {
      clearTimeout(timer);
      // Identity and generation checks also protect the interval before cleanup.
      if (generation.current === token) generation.current = token + 1;
    };
  }, [identity, key, revision, disabled, delay]);
  const loadMore = useCallback(() => request.current(), []);
  const retry = useCallback(() => request.current(true), []);
  const feed = state.identity === identity ? state.feed :
    { ...(cache.current.get(key)?.feed ?? empty<T>()), loading: true };
  return { ...feed, loadMore, retry };
}
