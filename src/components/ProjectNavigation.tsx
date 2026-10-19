import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './project-navigation.css';

export function navigationWidthLimits(viewport: number) {
  // The app already keeps a 700px minimum canvas at high native page zoom.
  // Reserve 520px outside the left navigation when possible, including right tools.
  return { minimum: 160, maximum: Math.max(160, Math.min(480, Math.floor(viewport * 0.4), viewport - 520)) };
}

export function ProjectNavigation({ hidden, preferredWidth, onWidthChange, children }: {
  hidden: boolean; preferredWidth: number; onWidthChange: (width: number) => void; children: ReactNode;
}) {
  const id = useId();
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{ owner: HTMLDivElement; pointer: number; x: number; width: number; current: number } | null>(null);
  const { minimum, maximum } = navigationWidthLimits(viewport);
  const clamp = (width: number) => Math.max(minimum, Math.min(maximum, Math.round(width)));
  const width = clamp(draft ?? preferredWidth);
  const release = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    if (active?.owner.hasPointerCapture(active.pointer)) active.owner.releasePointerCapture(active.pointer);
  }, []);
  const cancel = useCallback(() => { release(); setDraft(null); }, [release]);
  useEffect(() => {
    const resize = () => { cancel(); setViewport(window.innerWidth); };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('blur', cancel); release(); };
  }, [cancel, release]);
  useEffect(() => { if (hidden) cancel(); }, [hidden, cancel]);
  return <>
    <aside id={id} className="sidebar" hidden={hidden} aria-label="專案導覽" style={{ width }}>{children}</aside>
    <div className="project-navigation-resize" hidden={hidden}
      role="separator" aria-label="調整專案導覽寬度" aria-orientation="vertical" aria-controls={id}
      aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
      aria-valuetext={`${width} 像素`} tabIndex={hidden ? -1 : 0}
      onPointerDown={event => {
        if (event.button !== 0 || event.isPrimary === false || drag.current) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { owner: event.currentTarget, pointer: event.pointerId, x: event.clientX, width, current: width };
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        active.current = clamp(active.width + event.clientX - active.x);
        setDraft(active.current);
      }}
      onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        const { current: next, width: initialWidth } = drag.current;
        release(); setDraft(null);
        if (next !== initialWidth) onWidthChange(next);
      }}
      onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) cancel(); }}
      onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) cancel(); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); cancel();
        const next = clamp(event.key === 'Home' ? minimum : event.key === 'End' ? maximum
          : width + (event.key === 'ArrowRight' ? 16 : -16));
        if (next !== width) onWidthChange(next);
      }} />
  </>;
}
