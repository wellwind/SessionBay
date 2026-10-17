import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Capture before descendant autoFocus runs during commit, never the modal's own input.
  const [previous] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const root = ref.current;
    let composing = false;
    const start = (event: CompositionEvent) => { if (event.target instanceof Node && root?.contains(event.target)) composing = true; };
    const end = () => { composing = false; };
    (
      root?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ??
      root?.querySelector<HTMLElement>('[data-dialog-confirm]:not(:disabled)') ??
      root?.querySelector<HTMLElement>('button:not(:disabled)')
    )?.focus();
    const guardConfirmationEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.target instanceof Node) || !root?.contains(event.target) ||
          !root.querySelector('[data-dialog-confirm]')) return;
      // Keep native focused-control activation; only suppress IME and held opener keys.
      if (event.isComposing || composing || event.keyCode === 229 || event.repeat) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const focusable = Array.from(
          root?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
        if (!focusable.length) return;
        if (event.shiftKey && document.activeElement === focusable[0]) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        }
        if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
          event.preventDefault();
          focusable[0].focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    document.addEventListener('keydown', guardConfirmationEnter, true);
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    window.addEventListener('blur', end);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('keydown', guardConfirmationEnter, true);
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      window.removeEventListener('blur', end);
      if (previous?.isConnected && !root?.contains(previous)) previous.focus();
    };
  }, [previous]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`dialog ${wide ? 'wide' : ''}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="關閉對話框">
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
