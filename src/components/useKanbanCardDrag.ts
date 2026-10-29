import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

export interface CardDrop { columnId: string; targetId?: string; after: boolean }

/** Cross-column pointer capture with the same cancellation and keyboard alternatives as tab reordering. */
export function useKanbanCardDrag(root: RefObject<HTMLElement | null>, signature: string,
  onMove: (id: string, drop: CardDrop) => void) {
  const drag = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean; button: HTMLButtonElement } | null>(null);
  const [preview, setPreview] = useState<(CardDrop & { id: string }) | null>(null);
  const cancel = useCallback(() => {
    const current = drag.current;
    drag.current = null;
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
  const target = (event: PointerEvent<HTMLButtonElement>): CardDrop | null => {
    const hit = document.elementFromPoint?.(event.clientX, event.clientY);
    if (!hit || !root.current?.contains(hit) || hit.closest('[role="dialog"], .kanban-column-header')) return null;
    const column = hit.closest<HTMLElement>('[data-kanban-column]');
    if (!column) return null;
    const card = hit.closest<HTMLElement>('[data-kanban-card]');
    return { columnId: column.dataset.kanbanColumn!, targetId: card?.dataset.kanbanCard,
      after: card ? event.clientY >= card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2 : true };
  };
  return { preview, handlers: (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button: event.currentTarget };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
      current.moved = true;
      const drop = target(event);
      setPreview(drop ? { ...drop, id } : null);
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const drop = current.moved ? target(event) : null;
      cancel();
      if (drop && drop.targetId !== id) onMove(id, drop);
    },
    onPointerCancel: cancel, onLostPointerCapture: cancel,
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) => event.preventDefault(),
  }) };
}
