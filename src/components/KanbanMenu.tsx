import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { FloatingPanel, useDismiss } from './controls';

/** Shared overflow control with dismissal, focus restoration and arrow navigation. */
export function KanbanMenu({ label, disabled, children, trigger: triggerContent }: { label: string; disabled?: boolean; children: ReactNode; trigger?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useDismiss(open, root, panel, close);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled)')?.focus(); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={root} className="kanban-overflow">
    <button ref={trigger} type="button" className={triggerContent ? 'secondary kanban-menu-trigger' : 'icon-button'} disabled={disabled} aria-label={label}
      aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}>{triggerContent ?? <MoreHorizontal size={16} aria-hidden="true" />}</button>
    {open && <FloatingPanel anchor={root} panel={panel} className="select-options kanban-menu" id={id} aria-label={label}
      onClick={event => { if ((event.target as Element).closest('button')) close(true); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.target instanceof HTMLSelectElement) return;
        if (event.key === 'Tab') { close(true); return; }
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : null;
        if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
      }}>{children}</FloatingPanel>}
  </div>;
}
