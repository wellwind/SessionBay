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
  'next-pane': 'Mod+Shift+]',
  'maximize-pane': 'Mod+Shift+M',
  'close-pane': 'Mod+Shift+W',
  'toggle-sidebar': 'Mod+Shift+B',
};
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
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
  return new Set([...groups.values()].filter((group) => group.length > 1).flat());
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
