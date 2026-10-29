import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FloatingPanel, useDismiss } from './controls';
import { t } from '../i18n';

export function KanbanMoveMenu({ title, disabled, options }: {
  title: string; disabled: boolean;
  options: { id: string; label: string; disabled?: boolean; action: () => void }[];
}) {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useDismiss(open, root, panel, close);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div ref={root} className="kanban-move-menu">
    <button ref={trigger} type="button" className="select-trigger" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-label={t('Move "{{title}}"…', { title })}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}>{t('Move to…')}<ChevronDown size={12} aria-hidden="true" /></button>
    {open && <FloatingPanel anchor={root} panel={panel} className="select-options kanban-menu" role="menu" id={id} aria-label={t('Move to…')}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Tab') { close(true); return; }
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : null;
        if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
      }}>
      {options.map(option => <button key={option.id} type="button" role="menuitem" tabIndex={-1} className="select-option" disabled={option.disabled}
        onClick={() => { close(true); option.action(); }}>{option.label}</button>)}
    </FloatingPanel>}
  </div>;
}
