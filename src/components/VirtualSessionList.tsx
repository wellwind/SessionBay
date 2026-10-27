import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';

// Fixed row geometry keeps both layout work and mounted nodes independent of list size.
export function VirtualSessionList<T extends { id: string }>({ items, total, label, className,
  rowHeight, scrollMemory, loading, done, error, loadMore, retry, renderRow }: {
  items: T[]; total: number; label: string; className: string; rowHeight: number;
  scrollMemory: { top: number }; loading: boolean; done: boolean; error: string;
  loadMore: () => void; retry: () => void; renderRow: (item: T) => ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ top: scrollMemory.top, height: 600 });
  const [focused, setFocused] = useState<string | null>(null);
  const pendingFocus = useRef<{ index: number; last: boolean } | null>(null);
  const first = Math.max(0, Math.floor(geometry.top / rowHeight) - 3);
  const last = Math.min(items.length, Math.ceil((geometry.top + geometry.height) / rowHeight) + 3);
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  const focusedIndex = items.findIndex(item => item.id === focused);
  if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
  indices.sort((a, b) => a - b);
  useLayoutEffect(() => {
    if (focused && focusedIndex < 0 && document.activeElement === document.body) {
      viewport.current?.focus();
      setFocused(null);
    }
  }, [focused, focusedIndex]);
  useLayoutEffect(() => {
    const element = viewport.current!;
    element.scrollTop = scrollMemory.top;
    const measure = () => setGeometry({ top: element.scrollTop, height: element.clientHeight || 600 });
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [scrollMemory]);
  useLayoutEffect(() => {
    if (!loading && !done && !error && geometry.top + geometry.height >= items.length * rowHeight - rowHeight * 3)
      loadMore();
  }, [geometry, items.length, rowHeight, loading, done, error, loadMore]);
  useLayoutEffect(() => {
    if (pendingFocus.current !== null) {
      const row = viewport.current?.querySelector<HTMLElement>(`[data-row-index="${pendingFocus.current.index}"]`);
      const buttons = row?.querySelectorAll<HTMLElement>('button:not(:disabled)');
      const target = buttons?.length ? buttons[pendingFocus.current.last ? buttons.length - 1 : 0] : row;
      if (target) { pendingFocus.current = null; target.focus(); }
    }
  });
  const focusRow = (index: number, last = false) => {
    if (index >= items.length) {
      if (!done) { pendingFocus.current = { index, last }; loadMore(); }
      return;
    }
    const next = Math.max(0, index);
    pendingFocus.current = { index: next, last };
    const element = viewport.current!;
    if (next * rowHeight < element.scrollTop) element.scrollTop = next * rowHeight;
    else if ((next + 1) * rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, (next + 1) * rowHeight - element.clientHeight);
    scrollMemory.top = element.scrollTop;
    setGeometry({ top: element.scrollTop, height: element.clientHeight || 600 });
  };
  return <>
    <div ref={viewport} className={`${className} virtual-session-list`} role="list" aria-label={label}
      aria-busy={loading} tabIndex={0}
      onScroll={event => {
        scrollMemory.top = event.currentTarget.scrollTop;
        setGeometry({ top: scrollMemory.top, height: event.currentTarget.clientHeight || 600 });
      }}
      onFocusCapture={event => setFocused((event.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(null);
          pendingFocus.current = null;
        }
      }}
      onKeyDown={event => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
        const index = row ? Number(row.dataset.rowIndex) : -1;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          focusRow(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Tab' && row && !event.shiftKey && index + 1 < items.length) {
          const buttons = row.querySelectorAll('button:not(:disabled)');
          if (event.target === buttons[buttons.length - 1] || !buttons.length) { event.preventDefault(); focusRow(index + 1); }
        } else if (event.key === 'Tab' && row && event.shiftKey && index > 0 &&
          (event.target === row.querySelector('button:not(:disabled)') || !row.querySelector('button:not(:disabled)'))) {
          event.preventDefault(); focusRow(index - 1, true);
        }
      }}>
      <div className="virtual-session-space" style={{ height: items.length * rowHeight }}>
        {indices.map(index => <div key={items[index].id} role="listitem" aria-setsize={total} aria-posinset={index + 1}
          data-row-index={index} data-session-id={items[index].id} className="virtual-session-row" tabIndex={-1}
          style={{ top: index * rowHeight, height: rowHeight }}>{renderRow(items[index])}</div>)}
      </div>
    </div>
    {(loading || error || !done) && <div className="session-feed-status" role="status">
      {error ? <><span role="alert">{error}</span><button onClick={retry}>{t('Retry loading')}</button></> :
        loading ? t('Loading…') : <button onClick={loadMore}>{t('Load more sessions')}</button>}
    </div>}
  </>;
}
