import type { ITheme } from '@xterm/xterm';
import type { Settings } from './types';
import { codeTerminalTheme, codeUiTokens } from './code-themes';

const legacyTerminalThemes: Record<string, ITheme> = {
  bay: {
    background: '#11151a',
    foreground: '#d9e1e8',
    cursor: '#9bd9bd',
    selectionBackground: '#3b5f5580',
    black: '#19222a',
    red: '#ef8794',
    green: '#9bd9bd',
    yellow: '#e2c58f',
    blue: '#92b8e0',
    magenta: '#c4a0d9',
    cyan: '#8bced5',
    white: '#d9e1e8',
    brightBlack: '#72808e',
    brightRed: '#ff9caa',
    brightGreen: '#b4efd3',
    brightYellow: '#f0d6a3',
    brightBlue: '#b5d4f7',
    brightMagenta: '#dfbdec',
    brightCyan: '#abe6ec',
    brightWhite: '#ffffff',
  },
  classic: {
    background: '#090909',
    foreground: '#e0e0e0',
    cursor: '#f2f2f2',
    selectionBackground: '#66666680',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
  },
};

export type ColorMode = 'dark' | 'light';
export type Appearance = Pick<Settings, 'theme' | 'themePalette' | 'terminalTheme' | 'fontSize' | 'fontFamily' | 'appZoom'>;
export interface ThemePalette {
  id: string;
  label: string;
  dark: { background: string; surface: string; accent: string };
  light: { background: string; surface: string; accent: string };
}

// One catalog drives Settings, the quick switcher, CSS tokens and xterm palettes.
export const themePalettes: ThemePalette[] = [
  { id: 'bay', label: 'Bay · 港灣', dark: { background: '#10171c', surface: '#1d2b33', accent: '#7dd9b4' }, light: { background: '#f3f6f7', surface: '#e5eef1', accent: '#0c7058' } },
  { id: 'graphite', label: 'Graphite · 石墨', dark: { background: '#18191b', surface: '#2c2e32', accent: '#c2cad8' }, light: { background: '#f6f6f7', surface: '#e9eaed', accent: '#495565' } },
  { id: 'ocean', label: 'Ocean · 海洋', dark: { background: '#0d1929', surface: '#1c3047', accent: '#91c8fa' }, light: { background: '#f3f7fc', surface: '#e3edf8', accent: '#205b9c' } },
  { id: 'forest', label: 'Forest · 森林', dark: { background: '#111d18', surface: '#23352b', accent: '#a2d4a0' }, light: { background: '#f4f8f2', surface: '#e5efdf', accent: '#346330' } },
  { id: 'amber', label: 'Amber · 琥珀', dark: { background: '#211b11', surface: '#372c1d', accent: '#edc07c' }, light: { background: '#fcf8ed', surface: '#f3ead3', accent: '#795617' } },
  { id: 'rose', label: 'Rose · 玫瑰', dark: { background: '#21171c', surface: '#382730', accent: '#efa6bc' }, light: { background: '#fcf4f6', surface: '#f4e3e9', accent: '#963855' } },
  { id: 'plum', label: 'Plum · 紫李', dark: { background: '#1d1729', surface: '#30263f', accent: '#c7aff1' }, light: { background: '#f8f4fc', surface: '#ece3f5', accent: '#71429d' } },
  { id: 'slate', label: 'Slate · 青岩', dark: { background: '#111e21', surface: '#233339', accent: '#85cdd5' }, light: { background: '#f2f8f8', surface: '#e0eeee', accent: '#23626c' } },
  { id: 'coffee', label: 'Coffee · 咖啡', dark: { background: '#211914', surface: '#362b23', accent: '#d9b49a' }, light: { background: '#faf6f1', surface: '#eee5db', accent: '#795238' } },
  { id: 'sand', label: 'Sand · 沙丘', dark: { background: '#1e1d16', surface: '#333126', accent: '#d3cd95' }, light: { background: '#f9f8f0', surface: '#eeecdc', accent: '#626027' } },
  { id: 'code-modern', label: 'Code Modern', dark: { background: '#1f1f1f', surface: '#202020', accent: '#4daafc' }, light: { background: '#ffffff', surface: '#f8f8f8', accent: '#005fb8' } },
  { id: 'code-2026', label: 'Code 2026', dark: { background: '#121314', surface: '#202122', accent: '#48a0c7' }, light: { background: '#ffffff', surface: '#fafafd', accent: '#0069cc' } },
];

function mix(a: string, b: string, amount: number): string {
  const rgb = (value: string) => [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  const first = rgb(a), second = rgb(b);
  return '#' + first.map((value, i) => Math.round(value * (1 - amount) + second[i] * amount).toString(16).padStart(2, '0')).join('');
}

export function uiTokens(paletteId = 'bay', mode: ColorMode = 'dark'): Record<string, string> {
  const palette = themePalettes.find((entry) => entry.id === paletteId) ?? themePalettes[0];
  const { background, surface, accent } = palette[mode];
  const dark = mode === 'dark';
  return {
    bg: background,
    sidebar: mix(background, surface, 0.3),
    panel: dark ? mix(background, surface, 0.5) : '#ffffff',
    surface,
    'surface-hover': mix(surface, dark ? '#ffffff' : '#000000', dark ? 0.035 : 0.025),
    border: dark ? '#53606b' : '#a5b1bc',
    'control-border': dark ? '#8493a0' : '#687885',
    text: dark ? '#edf2f5' : '#172936',
    muted: dark ? '#b7c3ce' : '#445361',
    subtle: dark ? '#b7c3ce' : '#445361',
    accent,
    'accent-strong': mix(accent, dark ? '#ffffff' : '#000000', 0.14),
    'accent-bg': mix(background, accent, dark ? 0.12 : 0.07),
    'on-accent': dark ? '#12222a' : '#ffffff',
    warning: dark ? '#f2cc8d' : '#75500f',
    danger: dark ? '#f0a2a7' : '#a12c3f',
    'danger-bg': dark ? '#452b32' : '#fbe8eb',
    shadow: dark ? '0 20px 70px #0006' : '0 20px 70px #142c3626',
    // Always include scoped token names so preview cleanup also restores them
    // when switching from a Code family back to an existing palette.
    'code-titlebar': surface, 'code-input': background, 'code-input-text': dark ? '#edf2f5' : '#172936',
    'code-primary': accent, 'code-primary-hover': accent, 'code-secondary': surface,
    'code-secondary-hover': surface, 'code-secondary-text': dark ? '#edf2f5' : '#172936', 'code-focus': accent,
    'code-tab-active': background, 'code-tab-text': dark ? '#edf2f5' : '#172936',
    'code-tab-inactive': surface, 'code-tab-inactive-text': dark ? '#b7c3ce' : '#445361',
    'code-tab-border': accent, 'code-tab-hover': surface,
    ...codeUiTokens(palette.id, mode),
  };
}

const darkAnsi = {
  black: '#9aa5b1', red: '#ef8794', green: '#9bd9bd', yellow: '#e2c58f',
  blue: '#92b8e0', magenta: '#c4a0d9', cyan: '#8bced5', white: '#d9e1e8',
  brightBlack: '#aab6c3', brightRed: '#ff9caa', brightGreen: '#b4efd3', brightYellow: '#f0d6a3',
  brightBlue: '#b5d4f7', brightMagenta: '#dfbdec', brightCyan: '#abe6ec', brightWhite: '#ffffff',
};
const lightAnsi = {
  black: '#18212d', red: '#9b2335', green: '#155e37', yellow: '#715200',
  blue: '#205398', magenta: '#783991', cyan: '#145a68', white: '#475569',
  brightBlack: '#526070', brightRed: '#a3243c', brightGreen: '#206637', brightYellow: '#79540c',
  brightBlue: '#285d9d', brightMagenta: '#813e98', brightCyan: '#176575', brightWhite: '#536274',
};
export const terminalPresets = (['dark', 'light'] as const).flatMap((mode) => themePalettes.map((palette) => ({
  id: `${palette.id}-${mode}`,
  label: `${mode === 'dark' ? '深色' : '淺色'} · ${palette.label}`,
  mode,
  colors: {
    ...(mode === 'dark' ? darkAnsi : lightAnsi),
    background: palette[mode].background,
    foreground: mode === 'dark' ? '#edf2f5' : '#172936',
    cursor: palette[mode].accent,
    cursorAccent: palette[mode].background,
    selectionBackground: mode === 'dark' ? '#486079' : '#c5d7e8',
    selectionForeground: mode === 'dark' ? '#ffffff' : '#172936',
    ...codeTerminalTheme(palette.id, mode),
  } satisfies ITheme,
})));

export function terminalTheme(id: string): ITheme {
  return terminalPresets.find((preset) => preset.id === id)?.colors ?? (Object.hasOwn(legacyTerminalThemes, id) ? legacyTerminalThemes[id] : legacyTerminalThemes.bay);
}
export function paletteOptions(id = 'bay') {
  const options = themePalettes.map((palette) => ({ value: palette.id, label: palette.label }));
  return options.some((option) => option.value === id) ? options : [{ value: id, label: `${id} · 未知色系（暫用 Bay）` }, ...options];
}
export function terminalOptions(id: string) {
  const options = [
    ...terminalPresets.map((preset) => ({ value: preset.id, label: preset.label })),
    { value: 'bay', label: 'Bay · 原有色票' }, { value: 'classic', label: 'Classic · 原有色票' },
  ];
  return options.some((option) => option.value === id) ? options : [{ value: id, label: `${id} · 未知色票（暫用 Bay）` }, ...options];
}
export function validThemeId(id: string) { return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id); }
export function appearanceOf(settings: Settings): Appearance {
  return { theme: settings.theme, themePalette: settings.themePalette, terminalTheme: settings.terminalTheme,
    fontSize: settings.fontSize, fontFamily: settings.fontFamily, appZoom: settings.appZoom ?? 100 };
}
