import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { themePalettes, terminalOptions } from '../themes';
import type { Appearance } from '../themes';
import './command-theme-picker.css';

export type ThemeTarget = 'ui' | 'terminal';
export type ThemePatch = Partial<Pick<Appearance, 'theme' | 'themePalette' | 'terminalTheme'>>;
export function CommandThemePicker({ target, value, saving, error, onPreview, onCommit, onBack }: {
  target: ThemeTarget; value: Appearance; saving: boolean; error: string;
  onPreview: (patch: ThemePatch | null) => void;
  onCommit: (patch: ThemePatch) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const composing = useRef(false);
  const listId = useId();
  const options = useMemo(() => target === 'terminal'
    ? terminalOptions(value.terminalTheme).map(option => ({ id: option.value, label: option.label, patch: { terminalTheme: option.value } as ThemePatch }))
    : (['dark', 'light', 'system'] as const).flatMap(theme => themePalettes.map(palette => ({
      id: `${palette.id}-${theme}`, label: `${palette.label} · ${theme === 'dark' ? '深色 Dark' : theme === 'light' ? '淺色 Light' : '跟隨系統 System'}`,
      patch: { theme, themePalette: palette.id } as ThemePatch,
    }))), [target, value.terminalTheme]);
  const filtered = options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  const savedId = target === 'terminal' ? value.terminalTheme : `${value.themePalette ?? 'bay'}-${value.theme}`;
  const selected = filtered.find(option => option.id === selectedId) ?? filtered.find(option => option.id === savedId) ?? filtered[0];
  useEffect(() => {
    if (selected) document.getElementById(`${listId}-${selected.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [listId, selected]);
  const select = (option: (typeof options)[number] | undefined) => {
    if (saving) return;
    setSelectedId(option?.id ?? '');
    onPreview(option?.patch ?? null);
  };
  return <div className="command-theme-picker" onKeyDown={event => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) { event.stopPropagation(); if (event.key === 'Escape') event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onBack(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = filtered.findIndex(option => option.id === selected?.id);
      select(filtered[(index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length]);
    }
  }}>
    <button type="button" onClick={onBack}>返回命令</button>
    <p id={`${listId}-help`}>↑／↓ 即時預覽；Enter 儲存；Escape 或返回取消預覽。儲存後才會保留。</p>
    <input autoFocus role="combobox" aria-label="搜尋主題" aria-expanded="true" aria-controls={listId}
      aria-autocomplete="list" aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
      aria-describedby={`${listId}-help`} value={query} disabled={saving}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
          event.preventDefault(); if (selected && !saving) onCommit(selected.patch);
        }
      }}
      onChange={event => {
        setQuery(event.target.value);
        select(options.find(option => option.label.toLowerCase().includes(event.target.value.trim().toLowerCase())));
      }} />
    <div role="listbox" aria-label={target === 'ui' ? '介面主題' : 'Terminal 主題'} id={listId} className="palette-results">
      {filtered.map(option => <button type="button" role="option" key={option.id} id={`${listId}-${option.id}`}
        aria-selected={option.id === selected?.id} disabled={saving} tabIndex={-1}
        onMouseEnter={() => select(option)} onFocus={() => select(option)}
        onClick={() => { if (!saving) { setSelectedId(option.id); onCommit(option.patch); } }}>
        <span>{option.label}</span>{option.id === savedId && <small>已儲存</small>}
      </button>)}
      {!filtered.length && <p role="status">沒有符合的主題</p>}
    </div>
    <p role="status">{saving ? '正在儲存；已送出的變更會在儲存完成後保留。' : '預覽不會寫入設定。'}</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={saving || !selected} onClick={() => selected && onCommit(selected.patch)}>儲存選取主題</button>
  </div>;
}
