import { describe, expect, it } from 'vitest';
import { previewTheme } from './components/monaco-theme';
import { themePalettes, uiTokens } from './themes';

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = hex.replace('#', '').match(/../g)!.slice(0, 3).map(value => parseInt(value, 16) / 255);
    return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
describe('Monaco UI palette adapter', () => {
  for (const mode of ['dark', 'light'] as const) for (const palette of themePalettes) {
    it(`${palette.id} ${mode} maps UI tokens with readable syntax and selected text`, () => {
      const theme = previewTheme(palette.id, mode), tokens = uiTokens(palette.id, mode);
      expect(theme.base).toBe(mode === 'dark' ? 'vs-dark' : 'vs');
      expect(theme.inherit).toBe(false);
      expect(theme.colors['editor.background']).toBe(tokens.bg);
      expect(theme.colors['editorWidget.background']).toBe(tokens.surface);
      expect(theme.colors['input.background']).toBe(tokens['code-input']);
      expect(theme.rules.some(rule => rule.token === '')).toBe(true);
      for (const background of [theme.colors['editor.background'], theme.colors['editor.selectionBackground']]) {
        for (const rule of theme.rules) {
          expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/i);
          expect(contrast(rule.foreground!, background)).toBeGreaterThanOrEqual(4.5);
        }
        for (const key of ['editor.foreground', 'editor.selectionForeground', 'editorLineNumber.foreground',
          'editorBracketHighlight.foreground1', 'editorBracketHighlight.foreground2', 'editorBracketHighlight.foreground3']) {
          expect(contrast(theme.colors[key], background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
  it('uses Bay for unknown IDs without changing settings', () => {
    expect(previewTheme('unknown-palette', 'light')).toEqual(previewTheme('bay', 'light'));
  });
});
