import { describe, expect, it } from 'vitest';
import { resolveTerminalThemeId, terminalPresets, terminalTheme, themePalettes } from './themes';

// WCAG 2.x relative luminance / contrast ratio.
function luminance(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a: string, b: string) {
  const [lo, hi] = [luminance(a.slice(0, 7)), luminance(b.slice(0, 7))].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}
const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
const textual = [...ansi, 'foreground'] as const;
/** Intentional exceptions (none today). `white`/`brightWhite` are slate grays in light presets, so they pass. */
const exceptions: Partial<Record<(typeof textual)[number], string>> = {};
const lightPresets = terminalPresets.filter((p) => p.mode === 'light' && !p.id.startsWith('code-'));

describe('light terminal ANSI contrast', () => {
  it.each(lightPresets.map((p) => [p.id, p.colors] as const))('%s: every text color >= 4.5:1, cursor >= 3:1', (_id, colors) => {
    for (const name of textual) {
      if (exceptions[name]) continue;
      expect(contrast(colors[name]!, colors.background!), name).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(colors.cursor!, colors.background!), 'cursor').toBeGreaterThanOrEqual(3);
    expect(contrast(colors.selectionForeground!, colors.selectionBackground!), 'selection text').toBeGreaterThanOrEqual(4.5);
    // Normal and bright variants must not collapse into the same color.
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      const bright = `bright${name[0].toUpperCase()}${name.slice(1)}` as (typeof ansi)[number];
      expect(colors[bright], `${name}/${bright}`).not.toBe(colors[name]);
    }
  });
  it('prints the contrast table when TERMINAL_CONTRAST_REPORT=1', () => {
    if (!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TERMINAL_CONTRAST_REPORT) return;
    const rows = textual.map((name) => {
      const ratios = lightPresets.map((p) => contrast(p.colors[name]!, p.colors.background!));
      return `| ${name} | ${lightPresets[0].colors[name]} | ${Math.min(...ratios).toFixed(2)} | ${Math.max(...ratios).toFixed(2)} |`;
    });
    console.log(['| color | hex | min ratio (10 light bgs) | max |', '|---|---|---|---|', ...rows].join('\n'));
  });
});

describe('dark terminal palettes are unchanged', () => {
  it('keeps the dark ANSI palette and legacy palettes exact', () => {
    expect(terminalTheme('bay-dark')).toMatchObject({
      black: '#9aa5b1', red: '#ef8794', green: '#9bd9bd', yellow: '#e2c58f', blue: '#92b8e0', magenta: '#c4a0d9',
      cyan: '#8bced5', white: '#d9e1e8', brightBlack: '#aab6c3', brightRed: '#ff9caa', brightGreen: '#b4efd3',
      brightYellow: '#f0d6a3', brightBlue: '#b5d4f7', brightMagenta: '#dfbdec', brightCyan: '#abe6ec', brightWhite: '#ffffff',
      background: '#10171c', foreground: '#edf2f5', selectionBackground: '#486079',
    });
    expect(terminalTheme('bay')).toMatchObject({ background: '#11151a', foreground: '#d9e1e8', red: '#ef8794' });
    expect(terminalTheme('classic')).toMatchObject({ background: '#090909', red: '#cd3131' });
  });
});

describe('terminal follows the UI mode', () => {
  it('swaps preset families to the UI mode unless pinned dark', () => {
    expect(resolveTerminalThemeId('ocean-dark', 'light')).toBe('ocean-light');
    expect(resolveTerminalThemeId('ocean-light', 'dark')).toBe('ocean-dark');
    expect(resolveTerminalThemeId('ocean-dark', 'light', true)).toBe('ocean-dark');
    expect(resolveTerminalThemeId('ocean-light', 'light', true)).toBe('ocean-dark');
    expect(resolveTerminalThemeId('code-2026-dark', 'light')).toBe('code-2026-light');
  });
  it('keeps legacy dark palettes exact in dark mode and uses the UI palette when light', () => {
    expect(resolveTerminalThemeId('bay', 'dark')).toBe('bay');
    expect(resolveTerminalThemeId('classic', 'dark')).toBe('classic');
    expect(resolveTerminalThemeId('bay', 'light', false, 'forest')).toBe('forest-light');
    expect(resolveTerminalThemeId('classic', 'light', true)).toBe('classic');
    expect(resolveTerminalThemeId('future-terminal', 'light', false, 'future-ui')).toBe('bay-light');
    for (const palette of themePalettes) expect(terminalPresets.some((p) => p.id === `${palette.id}-light`)).toBe(true);
  });
});
