import type { ITheme } from '@xterm/xterm';
import sources from './theme-sources/code-palettes.json';

// Color data adapted from Microsoft's MIT-licensed VS Code default themes.
// Pinned source, include chains and deliberate contrast changes: docs/theme-preview.md.
type Mode = 'dark' | 'light';
export const codePaletteIds = ['code-modern', 'code-2026'] as const;
function source(id: string, mode: Mode): Record<string, string> | undefined {
  const file = id === 'code-modern' ? `${mode}_modern.json` : id === 'code-2026' ? `2026-${mode}.json` : null;
  return file ? sources.palettes[file as keyof typeof sources.palettes] : undefined;
}
function rgb(color: string) {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
}
function blend(color: string, background: string, amount: number) {
  const base = rgb(background);
  return '#' + rgb(color).map((channel, i) =>
    Math.round(channel * (1 - amount) + base[i] * amount).toString(16).padStart(2, '0')).join('');
}
function opaque(color: string, background: string) {
  return color.length === 9 ? blend(color, background, 1 - parseInt(color.slice(7), 16) / 255) : color;
}
function luminance(color: string) {
  return rgb(color).map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}
/** Keep reviewed source colors exact unless this usage fails our contrast floor. */
function readable(color: string, backgrounds: string[], mode: Mode, minimum = 4.5) {
  for (let step = 0; step <= 255; step++) {
    const adjusted = blend(color, mode === 'dark' ? '#ffffff' : '#000000', step / 255);
    if (backgrounds.every((background) => contrast(adjusted, background) >= minimum)) return adjusted;
  }
  return mode === 'dark' ? '#ffffff' : '#000000';
}

export function codeUiTokens(id: string, mode: Mode): Record<string, string> | undefined {
  const c = source(id, mode);
  if (!c) return;
  const bg = c['editor.background'], panel = c['panel.background'], surface = c['editorWidget.background'];
  const hover = opaque(c['list.hoverBackground'] ?? c['button.secondaryHoverBackground'], surface);
  // Selection is a neutral list surface, not the primary button fill.
  const selected = opaque(c['list.activeSelectionBackground'] ?? c['inputOption.activeBackground'], bg);
  const input = c['input.background'];
  const backgrounds = [bg, panel, surface, hover, selected, input, c['sideBar.background']];
  const text = readable(c.foreground, backgrounds, mode);
  const accent = readable(c['textLink.foreground'], backgrounds, mode);
  const primary = readable(c['button.background'], ['#ffffff'], 'light');
  const primaryHover = readable(c['button.hoverBackground'], ['#ffffff'], 'light');
  const focus = readable(opaque(c.focusBorder, bg), backgrounds, mode, 3);
  return {
    bg, panel, surface, sidebar: c['sideBar.background'], 'surface-hover': hover,
    border: c['panel.border'], text,
    muted: readable(c.descriptionForeground, backgrounds, mode),
    subtle: readable(c['input.placeholderForeground'], backgrounds, mode),
    accent, 'accent-strong': readable(c['textLink.activeForeground'], backgrounds, mode),
    'accent-bg': selected, 'on-accent': '#ffffff',
    warning: readable(mode === 'dark' ? '#e5ba7d' : '#895503', backgrounds, mode),
    danger: readable(c.errorForeground, backgrounds, mode),
    'control-border': readable(opaque(c['input.border'], input), backgrounds, mode, 3),
    'code-titlebar': c['titleBar.activeBackground'],
    'code-input': input, 'code-input-text': c['input.foreground'],
    'code-primary': primary, 'code-primary-hover': primaryHover,
    'code-secondary': opaque(c['button.secondaryBackground'], panel),
    'code-secondary-hover': opaque(c['button.secondaryHoverBackground'], panel),
    'code-secondary-text': c['button.secondaryForeground'],
    'code-focus': focus, 'code-tab-active': c['tab.activeBackground'],
    'code-tab-text': c['tab.activeForeground'],
    'code-tab-inactive': c['tab.inactiveBackground'],
    'code-tab-inactive-text': readable(c['tab.inactiveForeground'], [c['tab.inactiveBackground']], mode),
    'code-tab-border': readable(c['tab.activeBorderTop'], [c['tab.activeBackground']], mode, 3),
    'code-tab-hover': c['tab.hoverBackground'],
  };
}

export function codeTerminalTheme(id: string, mode: Mode) {
  const c = source(id, mode);
  if (!c) return;
  // VS Code terminal.background defaults to the panel; ANSI values come from
  // terminalColorRegistry, not TextMate tokenColors or the editor foreground.
  const background = c['terminal.background'] ?? c['panel.background'];
  const foreground = readable(c['terminal.foreground'], [background], mode);
  const defaults = sources.ansiDefaults[mode];
  const ansi = Object.fromEntries(Object.entries(defaults).map(([name, color]) => [
    name, readable(c[`terminal.ansi${name[0].toUpperCase()}${name.slice(1)}`] ?? color, [background], mode),
  ])) as typeof defaults;
  const selectionBackground = opaque(c['terminal.selectionBackground'] ?? c['editor.selectionBackground']
    ?? (mode === 'dark' ? '#264f78' : '#add6ff'), background);
  return {
    ...ansi, background, foreground,
    cursor: readable(c['terminalCursor.foreground'] ?? foreground, [background], mode),
    cursorAccent: c['terminalCursor.background'] ?? background,
    selectionBackground, selectionForeground: readable(foreground, [selectionBackground], mode),
  } satisfies ITheme;
}
