import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';

export function KanbanScroll({ count, children }: { count: number; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const element = root.current;
    if (element) setEdges({ left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
  };
  useLayoutEffect(() => {
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [count]);
  return <div className={`kanban-scroll${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}>
    <div ref={root} className="kanban-columns" aria-label={t('Board columns')} onScroll={measure}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, count)}, minmax(240px, 1fr))` }}>{children}</div>
  </div>;
}
