import '../viewport-layout.css';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/** Preserve controls and their DOM while making secondary chrome explicit on small surfaces. */
export function ResponsiveControls({ label, summary, children, narrowWidth = 600, forceCompact = false, closeOnAction = false }: {
  label: string; summary?: ReactNode; children: ReactNode; narrowWidth?: number; forceCompact?: boolean; closeOnAction?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const focusExpanded = useRef(false);
  const [measuredCompact, setCompact] = useState(false);
  const compact = forceCompact || measuredCompact;
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const next = forceCompact || window.innerHeight <= 640 || (parent.clientWidth > 0 && parent.clientWidth < narrowWidth);
      if (!next && document.activeElement === trigger.current) focusExpanded.current = true;
      // Keep a focused control reachable when its group becomes collapsed.
      if (next && content.current?.contains(document.activeElement)) setOpen(true);
      setCompact(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [narrowWidth, forceCompact]);
  useLayoutEffect(() => {
    if (!compact && focusExpanded.current) {
      focusExpanded.current = false;
      content.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus();
    }
  }, [compact]);
  useEffect(() => {
    if (!compact || !open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [compact, open]);
  return <div ref={root} className={`responsive-controls${compact ? ' is-compact' : ''}`}
    onBlur={event => {
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (compact && open && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    }}>
    {compact && <div className="compact-control-heading">
      {summary && <strong className="compact-control-title">{summary}</strong>}
      <button ref={trigger} type="button" className="icon-button" aria-label={label} title={label}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><MoreHorizontal size={18} aria-hidden="true" /></button>
    </div>}
    <div ref={content} id={id} className="responsive-control-content" hidden={compact && !open}
      onClick={event => {
        if (compact && closeOnAction && event.target instanceof Element && event.target.closest('button')) {
          setOpen(false);
          // Respect an action that has already moved focus (for example to xterm).
          if (content.current?.contains(document.activeElement)) trigger.current?.focus();
        }
      }}>{children}</div>
  </div>;
}
