import { describe, expect, it } from 'vitest';
import { normalizeLegacyShortcuts, reservedWorkspaceShortcut, workspaceTabIndex } from './commands';
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
describe('reserved workspace tab navigation', () => {
  it.each([true, false])('selects the visible project tab by number on mac=%s', (mac) => {
    for (let n = 1; n <= 8; n++) expect(workspaceTabIndex(key({ key: String(n), code: `Digit${n}`, metaKey: mac, ctrlKey: !mac }), 10, 4, mac)).toBe(n - 1);
    expect(workspaceTabIndex(key({ key: '9', code: 'Digit9', metaKey: mac, ctrlKey: !mac }), 10, 0, mac)).toBe(9);
    expect(workspaceTabIndex(key({ key: '8', metaKey: mac, ctrlKey: !mac }), 3, 0, mac)).toBeNull();
    expect(workspaceTabIndex(key({ key: '1', metaKey: !mac, ctrlKey: mac }), 3, 0, mac)).toBeNull();
  });
  it.each([true, false])('cycles both directions and wraps on mac=%s', (mac) => {
    expect(workspaceTabIndex(key({ key: 'Tab', ctrlKey: true }), 3, 2, mac)).toBe(0);
    expect(workspaceTabIndex(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 3, 0, mac)).toBe(2);
    expect(workspaceTabIndex(key({ key: 'Tab', ctrlKey: true }), 3, -1, mac)).toBe(0);
    expect(workspaceTabIndex(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 3, -1, mac)).toBe(2);
  });
  it.each([['BracketLeft', '{', 0], ['BracketRight', '}', 2], ['BracketRight', 'å', 2]])('uses physical bracket code %s despite shifted/layout key %s', (code, value, expected) => {
    expect(workspaceTabIndex(key({ key: value as string, code: code as string, metaKey: true, shiftKey: true }), 3, 1, true)).toBe(expected);
  });
  it('retains macOS Option-arrow aliases without taking unmodified terminal navigation', () => {
    expect(workspaceTabIndex(key({ key: 'ArrowLeft', metaKey: true, altKey: true }), 3, 1, true)).toBe(0);
    expect(workspaceTabIndex(key({ key: 'ArrowRight', metaKey: true, altKey: true }), 3, 1, true)).toBe(2);
    expect(workspaceTabIndex(key({ key: 'ArrowRight', altKey: true }), 3, 1, true)).toBeNull();
    expect(workspaceTabIndex(key({ key: 'ArrowRight', ctrlKey: true, altKey: true }), 3, 1, false)).toBeNull();
  });
  it('leaves IME, mixed modifiers, plain Tab, missing tabs, and zero alone', () => {
    for (const init of [
      { key: 'Tab' }, { key: 'Tab', ctrlKey: true, isComposing: true },
      { key: 'Tab', ctrlKey: true, keyCode: 229 }, { key: 'Tab', ctrlKey: true, altKey: true },
      { key: '0', ctrlKey: true }, { key: '1', ctrlKey: true, shiftKey: true },
    ]) expect(workspaceTabIndex(key(init), 3, 0, false)).toBeNull();
    expect(workspaceTabIndex(key({ key: 'Tab', ctrlKey: true }), 0, -1, false)).toBeNull();
  });
  it('moves only the original conflicting pane default and preserves custom shortcuts', () => {
    expect(normalizeLegacyShortcuts({ 'next-pane': 'Mod+Shift+]', custom: 'Alt+J' })).toMatchObject({ 'next-pane': 'Mod+Alt+ArrowDown', custom: 'Alt+J' });
    expect(normalizeLegacyShortcuts({ 'next-pane': 'Ctrl+Alt+K' })['next-pane']).toBe('Ctrl+Alt+K');
    expect(reservedWorkspaceShortcut('Cmd+Shift+]', true)).toBe(true);
    expect(reservedWorkspaceShortcut('Ctrl+Shift+]', false)).toBe(false);
    expect(reservedWorkspaceShortcut('Ctrl+Tab', false)).toBe(true);
    expect(reservedWorkspaceShortcut('Ctrl+9', false)).toBe(true);
  });
});
