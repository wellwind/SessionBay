import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AriaAttributes, CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import './controls.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
  description?: string;
}
export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  disabled?: boolean;
  className?: string;
}

function FloatingPanel({ anchor, panel, width, className, children, ...attributes }: HTMLAttributes<HTMLDivElement> & {
  anchor: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  width?: number;
}) {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = Math.min(width ?? Math.max(rect.width, 190), Math.max(160, window.innerWidth - 16));
      const height = panel.current?.getBoundingClientRect().height ?? 300;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const up = below < Math.min(height, 220) && above > below;
      setPosition({
        width: panelWidth,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8)),
        top: up ? Math.max(8, rect.top - Math.min(height, above) - 6) : Math.max(8, rect.bottom + 6),
        maxHeight: Math.max(120, up ? above : below),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, panel, width]);
  return createPortal(<div {...attributes} ref={panel} className={`control-popover ${className ?? ''}`} style={position}>{children}</div>, anchor.current?.closest('[role="dialog"]') ?? document.body);
}

function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, close: (restoreFocus: boolean) => void) {
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) latestClose.current(false);
    };
    // Capture on window before a surrounding dialog's document-level Escape handler.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current(true);
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open, root, panel]);
}

export function Select({ value, onChange, options, id, disabled = false, className = '', ...aria }: SelectProps) {
  const generated = useId();
  const buttonId = id ?? `select-${generated}`;
  const listId = `${buttonId}-options`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const search = useRef({ value: '', time: 0 });
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  const close = (restoreFocus = false) => {
    setOpen(false);
    search.current.value = '';
    if (restoreFocus) trigger.current?.focus();
  };
  useDismiss(open, root, panel, close);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open && (!options[active] || options[active].disabled)) setActive(options.findIndex((option) => !option.disabled));
  }, [open, options, active]);
  useEffect(() => {
    if (open && active >= 0) panel.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  const begin = (last = false) => {
    setOpen(true);
    setActive(selected >= 0 && !options[selected].disabled ? selected : enabled.at(last ? -1 : 0) ?? -1);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End') {
        setOpen(true);
        setActive(enabled.at(event.key === 'End' ? -1 : 0) ?? -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (open) choose(active); else begin();
      } else if (!open) begin(event.key === 'ArrowUp');
      else {
        const current = enabled.indexOf(active);
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setActive(enabled[(current + direction + enabled.length) % enabled.length] ?? -1);
      }
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const now = performance.now();
    const character = event.key.toLocaleLowerCase();
    const previous = now - search.current.time < 700 ? search.current.value : '';
    const repeated = previous.length > 0 && [...previous].every((letter) => letter === character);
    const query = repeated ? character : previous + character;
    search.current = { value: query, time: now };
    const start = Math.max(0, enabled.indexOf(open ? active : selected));
    const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
    if (query.length === 1 && (open ? active : selected) >= 0 && ordered.length > 1) ordered.push(ordered.shift()!);
    const match = ordered.find((index) => options[index].label.toLocaleLowerCase().startsWith(query));
    setOpen(true);
    if (match !== undefined) setActive(match);
    else if (!open) setActive(enabled[0] ?? -1);
  };
  return <div ref={root} className={`select-control ${className}`}>
    <button {...aria} id={buttonId} ref={trigger} type="button" role="combobox" className="select-trigger"
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      disabled={disabled} onKeyDown={key} onClick={() => open ? close() : begin()}>
      {selected >= 0 && options[selected].icon && <span className="select-icon" aria-hidden="true">{options[selected].icon}</span>}
      <span className="select-value">{selected >= 0 ? options[selected].label : '請選擇'}</span>
      <ChevronDown size={15} className={open ? 'select-chevron is-open' : 'select-chevron'} aria-hidden="true" />
    </button>
    {open && <FloatingPanel anchor={trigger} panel={panel} id={listId} role="listbox"
      aria-label={aria['aria-label']} aria-labelledby={aria['aria-label'] ? undefined : buttonId} className="select-options">
      {options.map((option, index) => <div id={`${listId}-${index}`} key={option.value} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        data-option-index={index} data-active={active === index || undefined} className="select-option"
        onPointerDown={(event) => event.preventDefault()} onMouseEnter={() => { if (!option.disabled) setActive(index); }}
        onClick={() => choose(index)}>
        {option.icon && <span className="select-icon" aria-hidden="true">{option.icon}</span>}
        <span className="select-option-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Check size={15} aria-hidden="true" />}
      </div>)}
    </FloatingPanel>}
  </div>;
}

function localDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}
function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = localDate(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
function isoDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function addDays(date: Date, days: number): Date {
  return localDate(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
function addMonths(date: Date, months: number): Date {
  const first = localDate(date.getFullYear(), date.getMonth() + months, 1);
  const last = localDate(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return localDate(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
}
function dateLocale(): string {
  // Linux WebKit may expose POSIX values such as "C" instead of a BCP 47 tag.
  // Validate each preference separately so one malformed value cannot crash History.
  const preferences = typeof navigator === 'undefined' ? [] : [navigator.language, ...navigator.languages];
  for (const candidate of preferences) {
    if (!candidate) continue;
    try {
      const supported = Intl.DateTimeFormat.supportedLocalesOf([candidate]);
      if (supported.length) return supported[0];
    } catch { /* Try the next browser preference, then the app's language. */ }
  }
  return 'zh-TW';
}
function localeWeekStart(locale: string): number {
  const information = new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
  return (information.getWeekInfo?.().firstDay ?? information.weekInfo?.firstDay ?? 7) % 7;
}
export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
  resetKey?: string | number;
}

export function DatePicker({ value, onChange, id, disabled = false, resetKey, 'aria-label': label }: DatePickerProps) {
  const generated = useId();
  const inputId = id ?? `date-${generated}`;
  const popupId = `${inputId}-calendar`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const lastEmitted = useRef<string | null>(null);
  const previousReset = useRef(resetKey);
  useEffect(() => {
    const explicitReset = previousReset.current !== resetKey;
    previousReset.current = resetKey;
    if (explicitReset || value !== lastEmitted.current) { setDraft(null); setInvalid(false); }
    lastEmitted.current = null;
  }, [value, resetKey]);
  const emit = (next: string) => { lastEmitted.current = next; onChange(next); };
  const initial = parseDate(value) ?? new Date();
  const [focused, setFocused] = useState(initial);
  const [month, setMonth] = useState(initial);
  const locale = dateLocale();
  const format = new Intl.DateTimeFormat(locale, { calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });
  const monthFormat = new Intl.DateTimeFormat(locale, { calendar: 'gregory', year: 'numeric', month: 'long' });
  const fullFormat = new Intl.DateTimeFormat(locale, { calendar: 'gregory', dateStyle: 'full' });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const weekStart = localeWeekStart(locale);
  const selected = parseDate(value);
  const today = isoDate(new Date());
  const focusedISO = isoDate(focused);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useDismiss(open, root, panel, close);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedISO}"]`)?.focus();
  }, [open, focusedISO]);
  const show = () => {
    if (disabled) return;
    const date = parseDate(value) ?? new Date();
    setFocused(date);
    setMonth(date);
    setOpen(true);
  };
  const choose = (date: Date) => {
    const next = isoDate(date);
    if (!parseDate(next) || disabled) return;
    if (next !== value) emit(next);
    setDraft(null);
    setInvalid(false);
    close(true);
  };
  const acceptDraft = () => {
    if (draft === null || disabled) return;
    const next = draft.trim();
    if (next && !parseDate(next)) { setInvalid(true); return; }
    if (next !== value) emit(next);
    setDraft(null);
    setInvalid(false);
  };
  const moveFocus = (next: Date) => {
    if (next.getFullYear() < 1 || next.getFullYear() > 9999) return;
    setFocused(next);
    setMonth(next);
  };
  const calendarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const distances: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in distances) { event.preventDefault(); moveFocus(addDays(focused, distances[event.key])); }
    else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const offset = (focused.getDay() - weekStart + 7) % 7;
      moveFocus(addDays(focused, event.key === 'Home' ? -offset : 6 - offset));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      moveFocus(addMonths(focused, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)));
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(focused); }
  };
  const first = localDate(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() - weekStart + 7) % 7));
  return <div ref={root} className={`date-control ${invalid ? 'is-invalid' : ''}`}>
    <div className="date-field">
      <input ref={input} id={inputId} type="text" inputMode="numeric" aria-label={label} disabled={disabled}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? `${inputId}-error` : undefined}
        placeholder="YYYY-MM-DD" autoComplete="off" value={draft ?? (selected ? format.format(selected) : '')}
        onFocus={() => { if (draft === null) setDraft(selected ? value : ''); }}
        onChange={(event) => {
          if (disabled) return;
          const next = event.target.value;
          setDraft(next);
          setInvalid(false);
          if ((!next || parseDate(next)) && next !== value) emit(next);
        }} onBlur={acceptDraft} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); acceptDraft(); }
          if (event.key === 'ArrowDown' || event.key === 'F4') { event.preventDefault(); show(); }
        }} />
      <button ref={trigger} type="button" disabled={disabled} aria-label={`${label || '日期'}，開啟日曆`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
        onClick={() => open ? close() : show()}><CalendarDays size={16} aria-hidden="true" /></button>
    </div>
    {invalid && <span id={`${inputId}-error`} className="control-error" role="alert">請輸入有效日期（YYYY-MM-DD）。</span>}
    {open && <FloatingPanel anchor={root} panel={panel} width={304} id={popupId} role="dialog"
      aria-label={label ? `選擇${label}` : '選擇日期'} aria-modal="true" className="date-popover" onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        event.stopPropagation();
        const focusable = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([tabindex="-1"])') ?? []);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="calendar-heading">
        <button type="button" aria-label="上一個月" onClick={() => moveFocus(addMonths(focused, -1))}><ChevronLeft size={17} /></button>
        <span id={`${popupId}-month`} aria-live="polite">{monthFormat.format(month)}</span>
        <button type="button" aria-label="下一個月" onClick={() => moveFocus(addMonths(focused, 1))}><ChevronRight size={17} /></button>
      </div>
      <div className="calendar-grid" role="grid" aria-labelledby={`${popupId}-month`} onKeyDown={calendarKey}>
        <div role="row" className="calendar-week">
          {Array.from({ length: 7 }, (_, index) => <span role="columnheader" key={index}>{weekdayFormat.format(localDate(2024, 0, 7 + weekStart + index))}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => <div role="row" className="calendar-week" key={week}>
          {Array.from({ length: 7 }, (_, day) => {
            const date = addDays(start, week * 7 + day);
            const iso = isoDate(date);
            return <div role="gridcell" aria-selected={iso === value} key={iso}>
              <button type="button" data-date={iso} tabIndex={iso === focusedISO ? 0 : -1}
                disabled={!parseDate(iso)} aria-label={fullFormat.format(date)} aria-current={iso === today ? 'date' : undefined}
                className={`calendar-day ${date.getMonth() !== month.getMonth() ? 'outside-month' : ''} ${iso === value ? 'is-selected' : ''}`}
                onFocus={() => setFocused(date)} onClick={() => choose(date)}>{date.getDate()}</button>
            </div>;
          })}
        </div>)}
      </div>
      <div className="calendar-footer">
        <button type="button" onClick={() => { if (value) emit(''); setDraft(null); setInvalid(false); close(true); }}>清除日期</button>
        <button type="button" onClick={() => choose(new Date())}>今天</button>
      </div>
    </FloatingPanel>}
  </div>;
}
