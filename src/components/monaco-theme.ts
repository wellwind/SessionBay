import type { editor } from 'monaco-editor';
import { uiTokens, type ColorMode } from '../themes';

export const previewThemeName = 'sessionbay-preview';
function luminance(color: string) {
  return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
}
function readable(color: string, backgrounds: string[], mode: ColorMode) {
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const target = mode === 'dark' ? 255 : 0;
  for (let step = 0; step <= 255; step++) {
    const adjusted = '#' + channels.map(channel => Math.round(channel + (target - channel) * step / 255).toString(16).padStart(2, '0')).join('');
    if (backgrounds.every(background => {
      const a = luminance(adjusted), b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5;
    })) return adjusted;
  }
  return mode === 'dark' ? '#ffffff' : '#000000';
}

/** UI appearance only: never consult terminalTheme or its ANSI palette. */
export function previewTheme(palette = 'bay', mode: ColorMode = 'dark'): editor.IStandaloneThemeData {
  const t = uiTokens(palette, mode);
  const backgrounds = [t.bg, t['accent-bg']];
  const text = readable(t.text, backgrounds, mode);
  const accent = readable(t.accent, backgrounds, mode);
  const muted = readable(t.muted, backgrounds, mode);
  const warning = readable(t.warning, backgrounds, mode);
  const danger = readable(t.danger, backgrounds, mode);
  const syntax = [
    ['', text], ['comment', muted], ['keyword', accent], ['string', readable(t['accent-strong'], backgrounds, mode)],
    ['number', warning], ['regexp', warning], ['type', danger], ['type.identifier', danger],
    ['identifier', text], ['delimiter', text], ['operator', accent], ['tag', accent],
    ['attribute.name', danger], ['attribute.value', warning], ['metatag', muted],
    ['annotation', muted], ['constant', warning], ['variable', text], ['invalid', danger],
  ];
  return {
    base: mode === 'light' ? 'vs' : 'vs-dark',
    // Avoid inherited syntax colors that were designed for a different background.
    inherit: false,
    rules: syntax.map(([token, foreground]) => ({ token, foreground: foreground.slice(1) })),
    colors: {
      'editor.background': t.bg, 'editor.foreground': text,
      'editorGutter.background': t.bg,
      'editorLineNumber.foreground': muted, 'editorLineNumber.activeForeground': text,
      'editorCursor.foreground': accent,
      'editor.selectionBackground': t['accent-bg'], 'editor.selectionForeground': text,
      'editor.inactiveSelectionBackground': t['accent-bg'],
      'editor.selectionHighlightBackground': t['accent-bg'],
      'editor.lineHighlightBackground': t.bg, 'editor.lineHighlightBorder': t.surface,
      'editorWhitespace.foreground': t.border, 'editorIndentGuide.background1': t.border,
      'editorIndentGuide.activeBackground1': muted,
      'editor.findMatchBackground': t['accent-bg'], 'editor.findMatchBorder': accent,
      'editor.findMatchHighlightBackground': t['accent-bg'], 'editor.findMatchHighlightBorder': accent,
      'editorBracketMatch.background': t['accent-bg'], 'editorBracketMatch.border': accent,
      'editorBracketHighlight.foreground1': accent, 'editorBracketHighlight.foreground2': warning,
      'editorBracketHighlight.foreground3': danger, 'editorBracketHighlight.foreground4': accent,
      'editorBracketHighlight.foreground5': warning, 'editorBracketHighlight.foreground6': danger,
      'editorBracketHighlight.unexpectedBracket.foreground': danger,
      'editorWidget.background': t.surface, 'editorWidget.foreground': t.text, 'editorWidget.border': t.border,
      'editorHoverWidget.background': t.surface, 'editorHoverWidget.foreground': t.text,
      'input.background': t['code-input'], 'input.foreground': t['code-input-text'],
      'input.border': t['control-border'], 'input.placeholderForeground': t.subtle,
      'inputOption.activeBackground': t['accent-bg'], 'inputOption.activeBorder': t.accent,
      'inputOption.activeForeground': t.text, 'focusBorder': t['code-focus'],
      'scrollbarSlider.background': t.border + '66',
      'scrollbarSlider.hoverBackground': t.border + '99',
      'scrollbarSlider.activeBackground': t.border + 'cc',
    },
  };
}
