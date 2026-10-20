import { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { Appearance } from '../themes';
import { effectiveTerminalTheme, paletteOptions, terminalOptions } from '../themes';
import { useResolvedColorMode } from '../use-ui-theme';
import { Select } from './controls';
import './themes.css';

export function ThemeControls({ value, disabled = false, onChange }: {
  value: Appearance;
  disabled?: boolean;
  onChange: (patch: Partial<Appearance>) => void;
}) {
  const modeLabel = useId();
  return <div className="theme-controls">
    <div className="theme-mode-field">
      <span id={modeLabel}>介面模式</span>
      <div className="theme-modes" role="group" aria-labelledby={modeLabel}>
        {([
          { id: 'dark', label: '深色', icon: Moon },
          { id: 'light', label: '淺色', icon: Sun },
          { id: 'system', label: '跟隨系統', icon: Monitor },
        ] as const).map(({ id, label, icon: Icon }) => <button type="button" key={id}
          disabled={disabled} aria-pressed={value.theme === id}
          className={value.theme === id ? 'selected' : ''} onClick={() => onChange({ theme: id })}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>)}
      </div>
    </div>
    <label className="theme-field">
      <span>介面色系</span>
      <Select aria-label="介面色系" value={value.themePalette ?? 'bay'} disabled={disabled}
        options={paletteOptions(value.themePalette)} onChange={(themePalette) => onChange({ themePalette })} />
    </label>
    <label className="theme-field">
      <span>終端色票</span>
      <Select aria-label="終端色票" value={value.terminalTheme} disabled={disabled}
        options={terminalOptions(value.terminalTheme)} onChange={(terminalTheme) => onChange({ terminalTheme })} />
    </label>
    <label className="theme-terminal-dark">
      <input type="checkbox" className="checkbox" checked={value.terminalAlwaysDark ?? false} disabled={disabled}
        onChange={(event) => onChange({ terminalAlwaysDark: event.currentTarget.checked })} />
      <span>終端固定用深色</span>
      <small>關閉時，終端會跟著介面模式切換深淺色。</small>
    </label>
  </div>;
}

export function TerminalPreview({ value }: { value: Appearance }) {
  const colors = effectiveTerminalTheme(value, useResolvedColorMode(value.theme));
  return <div className="theme-terminal-preview" aria-label="終端色票與字型預覽" style={{
    background: colors.background, color: colors.foreground,
    fontFamily: value.fontFamily || 'monospace',
    fontSize: Number.isFinite(value.fontSize) ? Math.min(Math.max(value.fontSize, 9), 32) : 14,
  }}>
    <span className="theme-preview-caption">Aa · Terminal 預覽</span>
    <p><span style={{ color: colors.green }}>❯</span> Session Bay</p>
    <p>讓每一次工作，都能接續。</p>
    <p><span style={{ color: colors.blue }}>src/</span> <span style={{ color: colors.magenta }}>theme.ts</span> <span style={{ color: colors.yellow }}>修改</span> <span style={{ color: colors.red }}>錯誤</span></p>
    <span className="theme-preview-cursor" style={{ background: colors.cursor }} aria-hidden="true" />
  </div>;
}
