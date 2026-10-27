import { useEffect, useId, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { t } from '../i18n';

/** A single icon-only toggle; portal keeps the tooltip outside tab-strip clipping. */
export function FocusModeButton({ active, onClick, buttonRef }: {
  active: boolean;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const label = active ? t('Exit focus mode') : t('Enter focus mode');
  const open = !!anchor && (hovered || focused) && !dismissed;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    };
    const hide = () => setDismissed(true);
    window.addEventListener('keydown', dismiss, true);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', dismiss, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open]);
  const position = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setAnchor({ top: rect.bottom, right: Math.max(8, window.innerWidth - rect.right) });
    setDismissed(false);
  };
  return <button type="button" ref={buttonRef} className="icon-button focus-mode-toggle"
    aria-label={label} aria-pressed={active} aria-describedby={open ? id : undefined}
    onMouseEnter={event => { position(event.currentTarget); setHovered(true); }}
    onMouseLeave={() => setHovered(false)}
    onFocus={event => { position(event.currentTarget); setFocused(true); }}
    onBlur={() => setFocused(false)}
    onClick={() => { setDismissed(true); onClick(); }}
    >
    {active ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
    {open && createPortal(<span id={id} role="tooltip" className="focus-mode-tooltip" style={anchor!}>{label}</span>, document.body)}
  </button>;
}
