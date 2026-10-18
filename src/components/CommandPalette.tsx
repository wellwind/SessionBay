import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import './command-palette.css';

export interface PaletteOption {
  id: string;
  label: ReactNode;
  search: string;
  detail?: ReactNode;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({ options, query, onQueryChange, label = '搜尋命令或專案', placeholder = '輸入命令或專案名稱…', listLabel = '命令與專案', emptyLabel = '沒有符合的命令或專案' }: {
  label?: string; placeholder?: string; listLabel?: string; emptyLabel?: string;
  options: PaletteOption[]; query: string; onQueryChange: (query: string) => void;
}) {
  const listId = useId();
  const composing = useRef(false);
  const [selection, setSelection] = useState<{ query: string; id: string } | null>(null);
  const filtered = options.filter(option => option.search.toLowerCase().includes(query.trim().toLowerCase()));
  const enabled = filtered.filter(option => !option.disabled);
  const selected = enabled.find(option => selection?.query === query && option.id === selection.id) ?? enabled[0];
  const activeId = selected ? `${listId}-${selected.id}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId, query]);
  return <div className="command-palette">
    <div className="palette-input search-field">
      <Search size={18} />
      <input autoFocus role="combobox" aria-label={label} placeholder={placeholder}
        aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={activeId} aria-describedby={`${listId}-help`} value={query}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onBlur={() => { composing.current = false; }}
        onChange={event => { setSelection(null); onQueryChange(event.target.value); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) {
            event.stopPropagation();
            if (event.key === 'Escape') event.preventDefault();
            return;
          }
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation();
            if (!enabled.length) return;
            const index = enabled.findIndex(option => option.id === selected?.id);
            const next = enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
            setSelection({ query, id: next.id });
          }
          if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            selected?.run();
          }
        }} />
    </div>
    <p id={`${listId}-help`} className="palette-help">↑／↓ 選取；Enter 執行；Escape 關閉</p>
    <div role="listbox" aria-label={listLabel} id={listId} className="palette-results">
      {filtered.map(option => <button type="button" role="option" key={option.id} id={`${listId}-${option.id}`}
        tabIndex={-1} disabled={option.disabled} aria-disabled={option.disabled || undefined}
        aria-selected={option.id === selected?.id}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => { if (!option.disabled) setSelection({ query, id: option.id }); }}
        onFocus={() => { if (!option.disabled) setSelection({ query, id: option.id }); }}
        onClick={() => { if (!option.disabled) option.run(); }}>
        <span>{option.label}</span>{option.detail}
      </button>)}
      {!filtered.length && <p role="status">{emptyLabel}</p>}
    </div>
  </div>;
}
