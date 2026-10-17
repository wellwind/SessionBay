import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

interface Item { id: string; group?: string | null }
interface Target { id: string; after: boolean }
interface Point { clientX: number; clientY: number }
interface Drag {
  id: string; pointerId: number; x: number; y: number; moved: boolean;
  button: HTMLButtonElement; rects: Map<string, DOMRect>; hitRects: Map<string, DOMRect>;
  lastPointer: Point; previewTarget: Target | null; cleanupScroll: () => void;
  scroll: { element: HTMLElement; x: number; y: number }[];
}

/** Preview with transforms only: DOM identity and persisted order change only on release. */
export function useAnimatedReorder(items: Item[], axis: 'x' | 'y', selector: string,
  onMove: (id: string, target: string, after: boolean) => void) {
  const elements = useRef(new Map<string, HTMLDivElement>());
  // Optional header-only hit region when a measured group includes expanded children.
  const targets = useRef(new Map<string, HTMLDivElement>());
  const dragging = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ id: string; offsets: Map<string, number> } | null>(null);
  const signature = items.map(item => `${item.group ?? ''}:${item.id}`).join('|');
  const stopDrag = useCallback(() => {
    const drag = dragging.current;
    dragging.current = null;
    drag?.cleanupScroll();
    if (drag?.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
  }, []);
  const cancel = useCallback(() => { stopDrag(); setPreview(null); }, [stopDrag]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); stopDrag(); };
  }, [cancel, stopDrag]);
  useEffect(() => { cancel(); }, [signature, cancel]);

  const scrollShift = (drag: Drag) => drag.scroll.reduce((sum, entry) => sum + (axis === 'x' ? entry.element.scrollLeft - entry.x : entry.element.scrollTop - entry.y), 0);
  const geometry = (event: Point, drag: Drag) => {
    const source = items.find(item => item.id === drag.id);
    if (!source) return null;
    const container = drag.button.closest(selector);
    // Every scrolling ancestor clips drop geometry, including a scrolled sidebar.
    for (const element of [container, ...drag.scroll.map(entry => entry.element)]) {
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    }
    // Reject sticky toolbar controls covering the strip, even under pointer capture.
    if (container && typeof document.elementFromPoint === 'function') {
      const sourceElement = elements.current.get(drag.id);
      // The lifted source paints above sticky controls; inspect the stack below it.
      // The list itself is allowed beneath the empty preview slot; frozen header
      // geometry below still rejects gaps, expanded children, and other groups.
      const hit = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(event.clientX, event.clientY).find(element => !sourceElement?.contains(element))
        : document.elementFromPoint(event.clientX, event.clientY);
      if (!hit || (hit !== container && ![...elements.current].some(([id, element]) => (targets.current.get(id) ?? element).contains(hit)))) return null;
    }
    const shift = scrollShift(drag);
    const coordinate = axis === 'x' ? event.clientX : event.clientY;
    let target: Target | null = null;
    for (const item of items) {
      if (item.group !== source.group) continue;
      const rect = drag.hitRects.get(item.id);
      if (!rect) continue;
      const start = (axis === 'x' ? rect.left : rect.top) - shift;
      const size = axis === 'x' ? rect.width : rect.height;
      const cross = axis === 'x' ? event.clientY >= rect.top && event.clientY <= rect.bottom : event.clientX >= rect.left && event.clientX <= rect.right;
      if (cross && coordinate >= start && coordinate <= start + size) target = { id: item.id, after: coordinate >= start + size / 2 };
    }
    if (!target) return null;
    return { target, shift };
  };
  const update = (event: Point, drag: Drag) => {
    const result = geometry(event, drag);
    // Invalid drop regions (including ordinary gaps) must not interrupt tracking.
    // Retain the last preview slot, but release always rechecks actual validity.
    if (result) drag.previewTarget = result.target;
    const target = drag.previewTarget;
    const shift = scrollShift(drag);
    const group = items.find(item => item.id === drag.id)?.group;
    const siblings = items.filter(item => item.group === group).map(item => item.id);
    if (target && target.id !== drag.id) {
      siblings.splice(siblings.indexOf(drag.id), 1);
      siblings.splice(siblings.indexOf(target.id) + Number(target.after), 0, drag.id);
    }
    let siblingIndex = 0;
    const ordered = items.map(item => item.group === group ? siblings[siblingIndex++] : item.id);
    const offsets = new Map<string, number>();
    const start = (id: string) => { const rect = drag.rects.get(id)!; return axis === 'x' ? rect.left : rect.top; };
    const size = (id: string) => { const rect = drag.rects.get(id)!; return axis === 'x' ? rect.width : rect.height; };
    // Reconstruct the preview slots using actual widths/heights and original gaps.
    let cursor = start(items[0].id);
    ordered.forEach((id, index) => {
      offsets.set(id, cursor - start(id));
      const gap = index + 1 < items.length ? start(items[index + 1].id) - start(items[index].id) - size(items[index].id) : 0;
      cursor += size(id) + gap;
    });
    offsets.set(drag.id, (axis === 'x' ? event.clientX - drag.x : event.clientY - drag.y) + shift);
    setPreview({ id: drag.id, offsets });
    return target;
  };
  return {
    targetRef: (id: string, element: HTMLDivElement | null) => { if (element) targets.current.set(id, element); else targets.current.delete(id); },
    ref: (id: string, element: HTMLDivElement | null) => { if (element) elements.current.set(id, element); else elements.current.delete(id); },
    className: (id: string) => preview ? `reorder-preview ${preview.id === id ? 'reorder-dragging' : ''}` : '',
    style: (id: string): CSSProperties | undefined => preview ? { transform: `translate${axis.toUpperCase()}(${preview.offsets.get(id) ?? 0}px)` } : undefined,
    consumeClick: (detail: number) => { if (suppressClick.current && detail !== 0) { suppressClick.current = false; return true; } return false; },
    handlers: (id: string) => ({
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || !event.isPrimary || dragging.current) return;
        suppressClick.current = false;
        const scroll: Drag['scroll'] = [];
        for (let element = event.currentTarget.parentElement; element; element = element.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(element).overflow + getComputedStyle(element).overflowX + getComputedStyle(element).overflowY)) scroll.push({ element, x: element.scrollLeft, y: element.scrollTop });
        }
        const drag: Drag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button: event.currentTarget,
          rects: new Map([...elements.current].map(([key, element]) => [key, element.getBoundingClientRect()])),
          hitRects: new Map([...elements.current].map(([key, element]) => [key, (targets.current.get(key) ?? element).getBoundingClientRect()])), scroll,
          lastPointer: { clientX: event.clientX, clientY: event.clientY }, previewTarget: null, cleanupScroll: () => {} };
        dragging.current = drag;
        // One passive listener per clipping ancestor, only for this gesture.
        const onScroll = () => { if (dragging.current === drag && drag.moved) update(drag.lastPointer, drag); };
        for (const { element } of scroll) element.addEventListener('scroll', onScroll, { passive: true });
        drag.cleanupScroll = () => { for (const { element } of scroll) element.removeEventListener('scroll', onScroll); };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const drag = dragging.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
        drag.lastPointer = { clientX: event.clientX, clientY: event.clientY };
        drag.moved = true; suppressClick.current = true; update(drag.lastPointer, drag);
      },
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
        const drag = dragging.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const target = drag.moved ? geometry(event, drag)?.target : null;
        cancel();
        if (target && target.id !== drag.id) {
          const group = items.find(item => item.id === drag.id)?.group;
          const siblings = items.filter(item => item.group === group).map(item => item.id);
          const from = siblings.indexOf(drag.id);
          const remaining = siblings.filter(id => id !== drag.id);
          const to = remaining.indexOf(target.id) + Number(target.after);
          if (from !== to) onMove(drag.id, target.id, target.after);
        }
      },
      onPointerCancel: cancel, onLostPointerCapture: cancel,
      onDragStart: (event: React.DragEvent<HTMLButtonElement>) => event.preventDefault(),
    }),
  };
}
