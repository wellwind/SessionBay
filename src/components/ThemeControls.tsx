import { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { Appearance } from '../themes';
import { effectiveTerminalTheme, paletteOptions, terminalOptions } from '../themes';
import { useResolvedColorMode } from '../use-ui-theme';
import { Select } from './controls';
import './themes.css';
import { t } from '../i18n';

export function ThemeControls({ value, disabled = false, onChange }: {
  value: Appearance;
  disabled?: boolean;
  onChange: (patch: Partial<Appearance>) => void;
}) {
  const modeLabel = useId();
  return <div className="theme-controls">
    <div className="theme-mode-field">
      <span id={modeLabel}>{t('Interface mode')}</span>
      <div className="theme-modes" role="group" aria-labelledby={modeLabel}>
        {([
          { id: 'dark', label: t('Dark'), icon: Moon },
          { id: 'light', label: t('Light'), icon: Sun },
          { id: 'system', label: t('System'), icon: Monitor },
        ] as const).map(({ id, label, icon: Icon }) => <button type="button" key={id}
          disabled={disabled} aria-pressed={value.theme === id}
          className={value.theme === id ? 'selected' : ''} onClick={() => onChange({ theme: id })}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>)}
      </div>
    </div>
    <label className="theme-field">
      <span>{t('Interface palette')}</span>
      <Select aria-label={t('Interface palette')} value={value.themePalette ?? 'bay'} disabled={disabled}
        options={paletteOptions(value.themePalette)} onChange={(themePalette) => onChange({ themePalette })} />
    </label>
    <label className="theme-field">
      <span>{t('Terminal colors')}</span>
      <Select aria-label={t('Terminal colors')} value={value.terminalTheme} disabled={disabled}
        options={terminalOptions(value.terminalTheme)} onChange={(terminalTheme) => onChange({ terminalTheme })} />
    </label>
    <label className="theme-terminal-dark">
      <input type="checkbox" className="checkbox" checked={value.terminalAlwaysDark ?? false} disabled={disabled}
        onChange={(event) => onChange({ terminalAlwaysDark: event.currentTarget.checked })} />
      <span>{t('Always use a dark terminal')}</span>
      <small>{t('When off, the terminal follows the interface light or dark mode.')}</small>
    </label>
  </div>;
}

export function TerminalPreview({ value }: { value: Appearance }) {
  const colors = effectiveTerminalTheme(value, useResolvedColorMode(value.theme));
  return <div className="theme-terminal-preview" aria-label={t('Terminal colors and font preview')} style={{
    background: colors.background, color: colors.foreground,
    fontFamily: value.fontFamily || 'monospace',
    fontSize: Number.isFinite(value.fontSize) ? Math.min(Math.max(value.fontSize, 9), 32) : 14,
  }}>
    <span className="theme-preview-caption">{t('Aa · Terminal preview')}</span>
    <p><span style={{ color: colors.green }}>❯</span> Session Bay</p>
    <p>{t('Pick up every piece of work where you left off.')}</p>
    <p><span style={{ color: colors.blue }}>src/</span> <span style={{ color: colors.magenta }}>theme.ts</span> <span style={{ color: colors.yellow }}>{t('modified')}</span> <span style={{ color: colors.red }}>{t('error')}</span></p>
    <span className="theme-preview-cursor" style={{ background: colors.cursor }} aria-hidden="true" />
  </div>;
}
