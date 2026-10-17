export interface Command {
  id: string;
  label: string;
  shortcut: string;
  run: () => void;
  disabled?: boolean;
}
export const shortcutDefaults: Record<string, string> = {
  'command-palette': 'Mod+Shift+P',
  'new-terminal': 'Mod+Shift+T',
  'new-agent': 'Mod+Shift+A',
  'search-sessions': 'Mod+Shift+F',
  'split-right': 'Mod+Shift+D',
  'split-down': 'Mod+Shift+E',
  'next-pane': 'Mod+Alt+ArrowDown',
  'maximize-pane': 'Mod+Shift+M',
  'close-pane': 'Mod+Shift+W',
  'toggle-sidebar': 'Mod+Shift+B',
  // Opt-in: avoid stealing terminal/application shortcuts or native fullscreen.
  'toggle-focus-mode': '',
};
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export function normalizeLegacyShortcuts(shortcuts: Record<string, string>): Record<string, string> {
  const next = { ...shortcutDefaults, ...shortcuts };
  // The original default is now reserved for Chrome-style next-tab navigation.
  if (next['next-pane'] === 'Mod+Shift+]') next['next-pane'] = shortcutDefaults['next-pane'];
  return next;
}
export function workspaceTabIndex(event: KeyboardEvent, count: number, current: number, mac = isMac()): number | null {
  if (count < 1 || event.isComposing || event.keyCode === 229) return null;
  if (!event.altKey && !event.shiftKey && event.metaKey === mac && event.ctrlKey === !mac) {
    const digit = /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : /^[1-9]$/.test(event.key) ? event.key : '';
    if (digit) return digit === '9' ? count - 1 : Number(digit) <= count ? Number(digit) - 1 : null;
  }
  let direction = 0;
  if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) direction = event.shiftKey ? -1 : 1;
  if (mac && event.metaKey && !event.ctrlKey && event.shiftKey && !event.altKey) {
    if (event.code === 'BracketLeft' || (!event.code && ['[', '{'].includes(event.key))) direction = -1;
    if (event.code === 'BracketRight' || (!event.code && [']', '}'].includes(event.key))) direction = 1;
  }
  if (mac && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key === 'ArrowLeft') direction = -1;
    if (event.key === 'ArrowRight') direction = 1;
  }
  if (!direction) return null;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}
export function reservedWorkspaceShortcut(shortcut: string, mac = isMac()): boolean {
  const fixed = ['Shift+Enter', 'Mod+=', 'Mod++', 'Mod+Shift+=', 'Mod+Shift++', 'Mod+-', 'Mod+Shift+-', 'Mod+0', 'Mod+Shift+0', 'Ctrl+Tab', 'Ctrl+Shift+Tab', ...Array.from({ length: 9 }, (_, i) => `${mac ? 'Meta' : 'Ctrl'}+${i + 1}`)];
  if (mac) fixed.push('Meta+W', 'Meta+Shift+[', 'Meta+Shift+]', 'Meta+Alt+ArrowLeft', 'Meta+Alt+ArrowRight');
  return fixed.some((binding) => normalizedShortcut(binding, mac) === normalizedShortcut(shortcut, mac));
}
export const workspaceTabShortcutHelp = '工作區分頁：macOS ⌘W 關閉目前分頁（保留視窗）；⌘1–8／⌘9（最後）、⌘⇧[／⌘⇧]；Linux Ctrl+1–8／Ctrl+9。兩平台 Ctrl+Tab／Ctrl+Shift+Tab；macOS 亦可 ⌘⌥←／⌘⌥→。僅切換目前目錄或臨時 Terminal 的工作分頁，不切換導覽頁面。';
const keyAlias = (value: string) =>
  ({
    esc: 'escape',
    return: 'enter',
    space: ' ',
    arrowleft: 'arrowleft',
    arrowright: 'arrowright',
  })[value] ?? value;
export function normalizedShortcut(value: string, mac = isMac()): string {
  const parts = value.toLowerCase().replace(/\s/g, '').split('+');
  const key = parts.pop() ?? '';
  return [
    ...new Set(
      parts.map((part) =>
        part === 'mod'
          ? mac
            ? 'meta'
            : 'ctrl'
          : ['command', 'cmd'].includes(part)
            ? 'meta'
            : part === 'control'
              ? 'ctrl'
              : part === 'option'
                ? 'alt'
                : part,
      ),
    ),
    keyAlias(key),
  ]
    .sort()
    .join('+');
}
export function shortcutConflicts(shortcuts: Record<string, string>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const [id, shortcut] of Object.entries(shortcuts))
    if (shortcut.trim()) {
      const key = normalizedShortcut(shortcut);
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
  return new Set([
    ...[...groups.values()].filter((group) => group.length > 1).flat(),
    ...Object.entries(shortcuts).filter(([, binding]) => reservedWorkspaceShortcut(binding)).map(([id]) => id),
  ]);
}
export function matchesShortcut(event: KeyboardEvent, shortcut: string, mac = isMac()): boolean {
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((p) => p.trim());
  const rawKey = parts.pop();
  if (!rawKey) return false;
  const key = keyAlias(rawKey);
  const wantsMod = parts.includes('mod');
  const ctrl = parts.includes('ctrl') || parts.includes('control') || (wantsMod && !mac);
  const meta =
    parts.includes('meta') ||
    parts.includes('cmd') ||
    parts.includes('command') ||
    (wantsMod && mac);
  const punctuation: Record<string, string> = {
    ']': 'BracketRight',
    '[': 'BracketLeft',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    ',': 'Comma',
    '.': 'Period',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
  };
  const keyMatches =
    event.key.toLowerCase() === key || (!!punctuation[key] && event.code === punctuation[key]);
  return (
    keyMatches &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.altKey === (parts.includes('alt') || parts.includes('option')) &&
    event.shiftKey === parts.includes('shift')
  );
}
