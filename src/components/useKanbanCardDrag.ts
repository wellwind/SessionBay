import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

export interface CardDrop { columnId: string; targetId?: string; after: boolean; merge?: boolean }

/** Cross-column pointer capture with the same cancellation and keyboard alternatives as tab reordering. */
export function useKanbanCardDrag(root: RefObject<HTMLElement | null>, signature: string,
  onMove: (id: string, drop: CardDrop) => void, allowMerge = true, enabled = true) {
  const drag = useRef<{ id: string; pointerId: number; x: number; y: number; clientX: number; clientY: number; moved: boolean; button: HTMLElement } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollTime = useRef<number | null>(null);
  const rects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]').forEach(element => {
      if (element.closest('[hidden]')) return;
      const id = element.dataset.kanbanCard!;
      const box = element.getBoundingClientRect(), previous = rects.current.get(id);
      if (previous && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        const x = previous.left - box.left, y = previous.top - box.top;
        if (x || y) element.animate?.([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'ease-out' });
      }
      next.set(id, box);
    });
    rects.current = next;
  }, [root, signature]);
  const suppressClick = useRef<string | null>(null);
  const [preview, setPreview] = useState<(CardDrop & { id: string }) | null>(null);
  const cancel = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    scrollTime.current = null;
    if (current?.moved) suppressClick.current = current.id;
    if (current?.button.hasPointerCapture?.(current.pointerId)) current.button.releasePointerCapture(current.pointerId);
    setPreview(null);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); cancel(); };
  }, [cancel]);
  useEffect(cancel, [signature, cancel]);
  const target = (clientX: number, clientY: number): CardDrop | null => {
    const hit = document.elementFromPoint?.(clientX, clientY);
    if (!hit || !root.current?.contains(hit) || hit.closest('[role="dialog"]')) return null;
    const column = hit.closest<HTMLElement>('[data-kanban-column]');
    if (!column) return null;
    const card = hit.closest<HTMLElement>('[data-kanban-card]');
    const box = card?.getBoundingClientRect();
    const fraction = box ? (clientY - box.top) / box.height : 1;
    return { merge: allowMerge && !!card && fraction >= .3 && fraction <= .7, columnId: column.dataset.kanbanColumn!, targetId: card?.dataset.kanbanCard,
      after: box ? clientY >= box.top + box.height / 2 : true };
  };
  const updatePreview = (id: string, drop: CardDrop | null) => setPreview(previous => {
    if (!drop) return previous === null ? previous : null;
    if (previous?.id === id && previous.columnId === drop.columnId && previous.targetId === drop.targetId &&
      previous.after === drop.after && previous.merge === drop.merge) return previous;
    return { ...drop, id };
  });
  const autoScroll = (time: number) => {
    scrollFrame.current = null;
    const current = drag.current, surface = root.current;
    if (!current?.moved || !surface) return;
    const elapsed = Math.min(32, scrollTime.current === null ? 1000 / 60 : time - scrollTime.current);
    scrollTime.current = time;
    const { clientX, clientY } = current;
    const hit = document.elementFromPoint?.(clientX, clientY);
    if (hit && surface.contains(hit) && !hit.closest('[role="dialog"]')) {
      let scrolledX = false, scrolledY = false;
      // Prefer the innermost scrollable surface independently on each axis.
      for (let element = hit instanceof HTMLElement ? hit : hit.parentElement; element && surface.contains(element); element = element.parentElement) {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        let left = Math.max(0, box.left), right = Math.min(window.innerWidth, box.right);
        let top = Math.max(0, box.top), bottom = Math.min(window.innerHeight, box.bottom);
        // Use visible edges when a lane or list is clipped by an outer scroller.
        for (let parent = element.parentElement; parent && surface.contains(parent); parent = parent.parentElement) {
          const clip = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(clip.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (/(auto|scroll|hidden|clip)/.test(clip.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        if (clientX < left || clientX > right || clientY < top || clientY > bottom) continue;
        const speed = (point: number, start: number, end: number) => {
          const edge = Math.min(48, (end - start) / 2);
          if (edge <= 0) return 0;
          return point < start + edge ? -(1 - (point - start) / edge) * elapsed * .9
            : point > end - edge ? (1 - (end - point) / edge) * elapsed * .9 : 0;
        };
        if (!scrolledX && /(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth) {
          const before = element.scrollLeft;
          element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, before + speed(clientX, left, right)));
          scrolledX = before !== element.scrollLeft;
        }
        if (!scrolledY && /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
          const before = element.scrollTop;
          element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, before + speed(clientY, top, bottom)));
          scrolledY = before !== element.scrollTop;
        }
      }
      if (scrolledX || scrolledY) updatePreview(current.id, target(clientX, clientY));
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  };
  return { preview, handlers: (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || !event.isPrimary || drag.current) return;
      if ((event.target as Element).closest('button:not(.kanban-card-open):not(.kanban-card-handle), input, textarea, select, a')) return;
      suppressClick.current = null;
      drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY, moved: false, button: event.currentTarget };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
      event.preventDefault();
      current.moved = true;
      current.clientX = event.clientX;
      current.clientY = event.clientY;
      updatePreview(id, target(event.clientX, event.clientY));
      if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(autoScroll);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const drop = current.moved ? target(event.clientX, event.clientY) : null;
      if (current.moved) suppressClick.current = id;
      cancel();
      if (drop && drop.targetId !== id) onMove(id, drop);
    },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (suppressClick.current === id) { event.preventDefault(); event.stopPropagation(); suppressClick.current = null; }
    },
    onPointerCancel: cancel, onLostPointerCapture: cancel,
    onDragStart: (event: React.DragEvent<HTMLElement>) => event.preventDefault(),
  }) };
}
