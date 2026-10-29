import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MoreHorizontal } from 'lucide-react';
import './activity-shell.css';
import { t } from '../i18n';

export interface ActivityContribution {
  /** Stable identity; also scopes the retained panel DOM. */
  id: string;
  label: string;
  shortcut?: string;
  icon: LucideIcon;
  renderSidebar: () => ReactNode;
  available?: boolean;
  badge?: string | number;
  onActivate?: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

/** Keep the button as a direct rail child for sizing and keyboard navigation. */
function ActivityRailButton({ label, shortcut, buttonRef, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  return <button {...props} ref={buttonRef} aria-label={label} aria-describedby={open ? tooltipId : undefined}
    onMouseEnter={() => { setHovered(true); setDismissed(false); }}
    onMouseLeave={() => setHovered(false)}
    onFocus={() => { setFocused(true); setDismissed(false); }}
    onBlur={() => setFocused(false)}
    onClick={event => { setDismissed(true); props.onClick?.(event); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
      }
    }}>
    {children}
    {open && <span id={tooltipId} role="tooltip" className="activity-tooltip">
      <span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
    </span>}
  </button>;
}

/** The shell knows no feature IDs, routing, data sources, or runtime lifecycle. */
export function ActivityShell({ contributions, activeId, onActiveChange, scopeKey = 'default' }: {
  scopeKey?: string;
  contributions: readonly ActivityContribution[];
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
}) {
  const selected = contributions.some(entry => entry.id === activeId && entry.available !== false) ? activeId : null;
  const panelId = useId();
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const maximumWidth = Math.max(80, Math.min(640, Math.floor(viewportWidth * 0.45) - 44));
  const minimumWidth = Math.min(160, maximumWidth);
  const clampWidth = (value: number) => Math.max(minimumWidth, Math.min(maximumWidth, value));
  const panelWidth = clampWidth(widths[scopeKey] ?? 320);
  const drag = useRef<{ x: number; width: number; scope: string } | null>(null);
  const updateWidth = (width: number) => setWidths(previous => ({ ...previous, [scopeKey]: clampWidth(width) }));
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const rail = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const measuredHeight = useRef<number | null>(null);
  const overflowFocus = useRef<string | null>(null);
  const pendingFocus = useRef<{ owner: Element; id: string | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visited, setVisited] = useState(() => new Set(selected ? [selected] : []));
  useEffect(() => {
    if (selected) setVisited(previous => previous.has(selected) ? previous : new Set([...previous, selected]));
  }, [selected]);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () => {
      const next = element.clientHeight;
      if (next <= 0 || next === measuredHeight.current) return;
      const owner = document.activeElement;
      if (owner && element.contains(owner)) {
        const button = owner.closest<HTMLButtonElement>('button');
        if (button) pendingFocus.current = { owner, id: button.dataset.activityId ?? overflowFocus.current };
      }
      measuredHeight.current = next;
      setHeight(next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const capacity = height === null ? contributions.length : Math.max(1, Math.floor(height / 44));
  const hasOverflow = contributions.length > capacity;
  const visibleCount = hasOverflow ? Math.max(0, capacity - 1) : contributions.length;
  const visible = contributions.slice(0, visibleCount);
  const overflow = contributions.slice(visibleCount);
  overflowFocus.current = overflow.some(entry => entry.id === selected) ? selected : overflow[0]?.id ?? null;
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || (document.activeElement !== pending.owner && document.activeElement !== document.body)) return;
    const target = [...(rail.current?.querySelectorAll<HTMLButtonElement>('button[data-activity-id]') ?? [])]
      .find(button => button.dataset.activityId === pending.id) ?? moreButton.current;
    target?.focus({ preventScroll: true });
  }, [height]);
  useEffect(() => { if (!hasOverflow) setMenuOpen(false); }, [hasOverflow]);
  useEffect(() => {
    for (const entry of overflow) if (entry.buttonRef) entry.buttonRef.current = moreButton.current;
  });
  useEffect(() => {
    if (menuOpen) rail.current?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!rail.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const activate = (entry: ActivityContribution) => {
    if (entry.available === false) return;
    const next = selected === entry.id ? null : entry.id;
    onActiveChange(next);
    if (next) entry.onActivate?.();
    if (menuOpen) { setMenuOpen(false); moreButton.current?.focus(); }
  };
  const moveFocus = (event: KeyboardEvent<HTMLElement>, selector: string) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)].filter(button => !button.disabled);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  return <>
    <div id={panelId} className="activity-panel-shell" hidden={!selected} style={{ width: panelWidth }}>
    {contributions.filter(entry => visited.has(entry.id) || entry.id === selected).map(entry =>
      <div key={entry.id} id={`activity-${entry.id}-panel`} className="activity-panel" data-activity-id={entry.id}
        hidden={selected !== entry.id || entry.available === false} aria-label={entry.label}>
        {entry.renderSidebar()}
      </div>)}
      <div role="separator" aria-label={t('Resize tool panel')} aria-orientation="vertical" aria-controls={panelId}
        aria-valuemin={minimumWidth} aria-valuemax={maximumWidth} aria-valuenow={panelWidth}
        tabIndex={selected ? 0 : -1} className="activity-panel-resize"
        onPointerDown={event => {
          event.preventDefault(); event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: panelWidth, scope: scopeKey };
        }}
        onPointerMove={event => {
          if (drag.current?.scope === scopeKey && event.currentTarget.hasPointerCapture(event.pointerId))
            updateWidth(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          updateWidth(event.key === 'Home' ? minimumWidth : event.key === 'End' ? maximumWidth
            : panelWidth + (event.key === 'ArrowLeft' ? 16 : -16));
        }} />
    </div>
    <nav ref={rail} className="workspace-activity-bar" aria-label={t('Workspace tools')}
      onKeyDown={event => { if (!(event.target as Element).closest('[role="menu"]')) moveFocus(event, ':scope > button'); }}>
      {visible.map(entry => {
        const Icon = entry.icon;
        return <ActivityRailButton key={entry.id} data-activity-id={entry.id} buttonRef={entry.buttonRef} className="workspace-activity"
          label={entry.label} shortcut={entry.shortcut} aria-pressed={selected === entry.id}
          aria-expanded={selected === entry.id} aria-controls={`activity-${entry.id}-panel`}
          disabled={entry.available === false} onClick={() => activate(entry)}>
          <Icon size={21} aria-hidden="true" />
          {entry.badge !== undefined && <span className="activity-badge" aria-label={t('{{label}}: {{badge}}', { label: entry.label, badge: entry.badge })}>{entry.badge}</span>}
        </ActivityRailButton>;
      })}
      {hasOverflow && <ActivityRailButton buttonRef={moreButton} className="workspace-activity" label={t('More tools')}
        aria-haspopup="menu" aria-expanded={menuOpen} aria-pressed={overflow.some(entry => entry.id === selected)}
        onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={21} aria-hidden="true" /></ActivityRailButton>}
      {menuOpen && hasOverflow && <div className="activity-overflow-menu" role="menu" aria-label={t('More workspace tools')}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); moreButton.current?.focus(); }
          else moveFocus(event, 'button');
        }}>
        {overflow.map(entry => {
          const Icon = entry.icon;
          return <button key={entry.id} data-activity-id={entry.id} role="menuitemradio" aria-label={entry.label} aria-checked={entry.id === selected}
            disabled={entry.available === false} onClick={() => activate(entry)}>
            <Icon size={18} aria-hidden="true" /><span>{entry.label}</span>
            {entry.shortcut && <kbd className="activity-overflow-shortcut">{entry.shortcut}</kbd>}
            {entry.badge !== undefined && <span>{entry.badge}</span>}
          </button>;
        })}
      </div>}
    </nav>

  </>;
}
