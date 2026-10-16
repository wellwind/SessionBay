import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appearanceOf, terminalPresets, terminalTheme, themePalettes, uiTokens, validThemeId } from './themes';
import type { Appearance } from './themes';
import { useUiTheme } from './use-ui-theme';
import { SettingsPanel } from './components/SettingsPanel';
import type { Settings } from './types';
import { defaultAgentOptions } from './agents';
import { shortcutDefaults } from './commands';
import codeSources from './theme-sources/code-palettes.json';

function luminance(color: string): number {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}
const settings: Settings = {
  version: 1, theme: 'dark', terminalTheme: 'classic', fontFamily: 'monospace', fontSize: 14,
  defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [{ id: 'shell', name: 'Shell', executable: '/bin/sh', args: [], env: {} }],
  sources: [], executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy' },
  agentOptions: defaultAgentOptions(), shortcuts: { ...shortcutDefaults }, onboardingComplete: true,
};
const index = { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] };
const noop = async () => {};

function Harness({ initial = settings, save = noop }: { initial?: Settings; save?: (next: Settings) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [committed, setCommitted] = useState(initial);
  const [preview, setPreview] = useState<Appearance | null>(null);
  const effective = { ...committed, ...preview };
  useUiTheme(effective);
  return <>
    <output data-testid="appearance">{JSON.stringify(appearanceOf(effective))}</output>
    <button onClick={() => setOpen(true)}>Open settings</button>
    <button onClick={() => setCommitted({ ...committed, theme: 'light', themePalette: 'forest', terminalTheme: 'forest-light' })}>External saved update</button>
    {open && <SettingsPanel settings={committed} installations={[]} index={index}
      onPreviewAppearance={setPreview} onClose={() => setOpen(false)}
      onSave={async (next) => { await save(next); setCommitted(next); }}
      onScan={noop} onCancelScan={noop} onClearIndex={noop} onDetect={noop} />}
  </>;
}
function appearance() { return JSON.parse(screen.getByTestId('appearance').textContent!) as Appearance; }
function openAppearance() { fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' })); }
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

describe('theme catalog and contrast', () => {
  it('preserves the ten original families and adds both Code families in each mode', () => {
    expect(themePalettes.map((palette) => palette.id)).toEqual([
      'bay', 'graphite', 'ocean', 'forest', 'amber', 'rose', 'plum', 'slate', 'coffee', 'sand', 'code-modern', 'code-2026',
    ]);
    expect(new Set(themePalettes.map((palette) => palette.id)).size).toBe(12);
    for (const mode of ['dark', 'light'] as const) {
      expect(new Set(themePalettes.slice(0, 10).map((palette) => uiTokens(palette.id, mode).bg)).size).toBe(10);
      expect(terminalPresets.filter((preset) => preset.mode === mode)).toHaveLength(12);
    }
    expect(new Set(terminalPresets.map((preset) => preset.id)).size).toBe(24);
  });
  for (const palette of themePalettes) for (const mode of ['dark', 'light'] as const) {
    it(`${palette.id}/${mode} keeps text, controls and terminal ANSI colors readable`, () => {
      const tokens = uiTokens(palette.id, mode);
      for (const fg of ['text', 'muted', 'subtle', 'accent', 'warning', 'danger']) {
        for (const bg of ['bg', 'panel', 'surface', 'surface-hover', 'accent-bg']) {
          expect(contrast(tokens[fg], tokens[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      const fills = palette.id.startsWith('code-') ? ['code-primary', 'code-primary-hover'] : ['accent', 'accent-strong'];
      for (const bg of fills) expect(contrast(tokens['on-accent'], tokens[bg])).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['bg', 'panel', 'surface', 'surface-hover']) expect(contrast(tokens['control-border'], tokens[bg])).toBeGreaterThanOrEqual(3);
      const colors = terminalPresets.find((preset) => preset.id === `${palette.id}-${mode}`)!.colors;
      for (const [name, color] of Object.entries(colors)) {
        if (['background', 'selectionBackground', 'selectionForeground', 'cursorAccent'].includes(name)) continue;
        expect(contrast(color, colors.background), name).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.selectionForeground, colors.selectionBackground)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('preserves old palettes exactly and safely falls back for unknown identifiers', () => {
    expect(terminalTheme('bay')).toMatchObject({ background: '#11151a', foreground: '#d9e1e8' });
    expect(terminalTheme('classic')).toMatchObject({ background: '#090909', foreground: '#e0e0e0' });
    expect(terminalTheme('future-theme')).toEqual(terminalTheme('bay'));
    expect(terminalTheme('constructor')).toEqual(terminalTheme('bay'));
    expect(uiTokens('future-palette', 'light')).toEqual(uiTokens('bay', 'light'));
    expect(validThemeId('future-theme')).toBe(true);
    for (const id of ['', '-bad', 'UPPER', 'a'.repeat(65), 'url(example)', 'x\0']) expect(validThemeId(id)).toBe(false);
  });
  it.each([
    ['code-modern', 'dark', 'dark_modern.json'], ['code-modern', 'light', 'light_modern.json'],
    ['code-2026', 'dark', '2026-dark.json'], ['code-2026', 'light', '2026-light.json'],
  ] as const)('%s/%s maps pinned source semantics and explicitly improves low-contrast colors', (id, mode, file) => {
    const source = codeSources.palettes[file] as Record<string, string>;
    const tokens = uiTokens(id, mode);
    for (const [token, upstream] of Object.entries({
      bg: 'editor.background', sidebar: 'sideBar.background', panel: 'panel.background', border: 'panel.border',
      'code-titlebar': 'titleBar.activeBackground', 'code-input': 'input.background',
      'code-tab-active': 'tab.activeBackground', 'code-tab-inactive': 'tab.inactiveBackground',
      'code-tab-text': 'tab.activeForeground', 'code-primary': 'button.background',
    })) expect(tokens[token], token).toBe(source[upstream]);
    expect(tokens['control-border']).not.toBe(source['input.border']);
    for (const bg of ['bg', 'sidebar', 'panel', 'surface', 'surface-hover', 'accent-bg', 'code-input']) {
      expect(contrast(tokens['code-focus'], tokens[bg]), `focus/${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens['control-border'], tokens[bg]), `control/${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(tokens['code-input-text'], tokens['code-input'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['code-secondary-text'], tokens['code-secondary'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['code-secondary-text'], tokens['code-secondary-hover'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['code-tab-text'], tokens['code-tab-active'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['code-tab-inactive-text'], tokens['code-tab-inactive'])).toBeGreaterThanOrEqual(4.5);
    const terminal = terminalTheme(`${id}-${mode}`);
    expect(terminal.background).toBe(source['terminal.background'] ?? source['panel.background']);
    expect(terminal.foreground).toBe(source['terminal.foreground']);
    // Values with sufficient contrast stay upstream-exact; low ANSI values are adapted.
    expect(terminal.red === codeSources.ansiDefaults[mode].red).toBe(contrast(codeSources.ansiDefaults[mode].red, terminal.background!) >= 4.5);
    expect(terminal.green === codeSources.ansiDefaults[mode].green).toBe(contrast(codeSources.ansiDefaults[mode].green, terminal.background!) >= 4.5);
  });
  it('keeps Code token ownership complete and restores styles when previews leave', () => {
    const previous = document.documentElement.style.getPropertyValue('--code-input');
    const Probe = ({ palette }: { palette: string }) => {
      useUiTheme({ ...appearanceOf(settings), themePalette: palette });
      return null;
    };
    const view = render(<Probe palette="code-modern" />);
    expect(document.documentElement.style.getPropertyValue('--code-input')).toBe('#313131');
    view.rerender(<Probe palette="code-2026" />);
    expect(document.documentElement.style.getPropertyValue('--code-input')).toBe('#191a1b');
    view.rerender(<Probe palette="bay" />);
    expect(document.documentElement.style.getPropertyValue('--code-input')).toBe(uiTokens('bay').bg);
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--code-input')).toBe(previous);
  });
});

describe('live settings appearance transaction', () => {
  it.each([
    ['Code Modern', 'code-modern', '深色', 'dark'], ['Code Modern', 'code-modern', '淺色', 'light'],
    ['Code 2026', 'code-2026', '深色', 'dark'], ['Code 2026', 'code-2026', '淺色', 'light'],
  ] as const)('previews, cancels and saves %s/%s/%s with its independent terminal preset', async (label, id, modeLabel, mode) => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<Harness save={save} />);
    const select = () => {
      openAppearance();
      fireEvent.click(screen.getByRole('button', { name: modeLabel }));
      choose('介面色系', label);
      choose('終端色票', `${modeLabel} · ${label}`);
    };
    select();
    expect(appearance()).toMatchObject({ theme: mode, themePalette: id, terminalTheme: `${id}-${mode}` });
    expect(document.documentElement.style.getPropertyValue('--code-input')).toBe(uiTokens(id, mode)['code-input']);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(appearance()).toMatchObject({ theme: 'dark', terminalTheme: 'classic' });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    select();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ theme: mode, themePalette: id, terminalTheme: `${id}-${mode}` }));
    expect(appearance()).toMatchObject({ themePalette: id, terminalTheme: `${id}-${mode}` });
  });
  it.each(['取消', '關閉設定', 'Escape'])('previews immediately and restores both themes after %s/discard, repeatedly', (exit) => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<Harness save={save} />);
    for (let i = 0; i < 2; i++) {
      openAppearance();
      fireEvent.click(screen.getByRole('button', { name: '淺色' }));
      choose('介面色系', 'Ocean · 海洋');
      choose('終端色票', '淺色 · Rose · 玫瑰');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.dataset.themePalette).toBe('ocean');
      expect(appearance().terminalTheme).toBe('rose-light');
      expect(save).not.toHaveBeenCalled();
      // Switching Settings sections does not discard or commit the preview.
      fireEvent.click(screen.getByRole('button', { name: '來源與工具' }));
      expect(appearance().terminalTheme).toBe('rose-light');
      if (exit === 'Escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: exit }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '捨棄變更' }));
      expect(appearance()).toMatchObject({ theme: 'dark', terminalTheme: 'classic' });
      expect(document.documentElement.dataset.themePalette).toBe('bay');
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    }
  });
  it('Back discards preview without saving and unmount removes global styles', () => {
    const save = vi.fn();
    const original = document.documentElement.style.getPropertyValue('--bg');
    const view = render(<Harness save={save} />);
    openAppearance();
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(appearance().theme).toBe('dark');
    expect(save).not.toHaveBeenCalled();
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(original);
  });
  it('locks repeat save/close while pending, keeps failed draft preview and permits retry', async () => {
    let reject!: (reason: Error) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    render(<Harness save={save} />);
    openAppearance();
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    choose('終端色票', '淺色 · Plum · 紫李');
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    fireEvent.submit(screen.getByRole('button', { name: '處理中…' }).closest('form')!);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => reject(new Error('Disk full')));
    expect(screen.getByText('Disk full')).toBeInTheDocument();
    expect(appearance()).toMatchObject({ theme: 'light', terminalTheme: 'plum-light' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(appearance()).toMatchObject({ theme: 'light', terminalTheme: 'plum-light' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    openAppearance();
    fireEvent.click(screen.getByRole('button', { name: '深色' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(appearance()).toMatchObject({ theme: 'light', terminalTheme: 'plum-light' });
  });
  it('adopts external saved settings as the new cancellation baseline', () => {
    render(<Harness />);
    openAppearance();
    choose('終端色票', '深色 · Ocean · 海洋');
    fireEvent.click(screen.getByRole('button', { name: 'External saved update' }));
    expect(appearance()).toMatchObject({ theme: 'light', themePalette: 'forest', terminalTheme: 'forest-light' });
    choose('終端色票', '深色 · Ocean · 海洋');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(appearance()).toMatchObject({ theme: 'light', themePalette: 'forest', terminalTheme: 'forest-light' });
  });
  it('keeps unknown IDs and all unrelated settings when saving a known mode change', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={{ ...settings, themePalette: 'future-ui', terminalTheme: 'future-terminal' }} save={save} />);
    openAppearance();
    expect(screen.getByRole('combobox', { name: '介面色系' })).toHaveTextContent('future-ui');
    expect(screen.getByRole('combobox', { name: '終端色票' })).toHaveTextContent('future-terminal');
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ ...settings, theme: 'light', themePalette: 'future-ui', terminalTheme: 'future-terminal' }));
  });
});
