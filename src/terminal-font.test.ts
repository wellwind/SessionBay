import { describe, expect, it } from 'vitest';
import { acceptsTerminalFontShortcut, nextTerminalFontSize, terminalFontShortcut } from './terminal-font';
import { reservedWorkspaceShortcut } from './commands';
const key = (key: string, patch: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, ...patch });
describe('terminal font shortcuts', () => {
  it('recognizes semantic plus/equal, minus and zero on the platform modifier', () => {
    for (const mac of [false, true]) {
      const mods = { ctrlKey: !mac, metaKey: mac };
      expect(terminalFontShortcut(key('=', mods), mac)).toBe('increase');
      expect(terminalFontShortcut(key('+', { ...mods, shiftKey: true }), mac)).toBe('increase');
      expect(terminalFontShortcut(key('+', { ...mods, code: 'NumpadAdd' }), mac)).toBe('increase');
      expect(terminalFontShortcut(key('-', mods), mac)).toBe('decrease');
      expect(terminalFontShortcut(key('0', mods), mac)).toBe('reset');
      // Some keyboard layouts require Shift to produce these semantic keys.
      expect(terminalFontShortcut(key('=', { ...mods, shiftKey: true }), mac)).toBe('increase');
      expect(terminalFontShortcut(key('-', { ...mods, shiftKey: true }), mac)).toBe('decrease');
      expect(terminalFontShortcut(key('0', { ...mods, shiftKey: true }), mac)).toBe('reset');
      expect(terminalFontShortcut(key('=', { ctrlKey: mac, metaKey: !mac }), mac)).toBeNull();
    }
  });
  it('leaves composing, non-zoom and modified terminal keys alone', () => {
    for (const e of [key('=', { isComposing: true }), key('=', { keyCode: 229 }), key('=', { altKey: true }), key('=', { metaKey: true }), key('=', { ctrlKey: false }), key('_', { shiftKey: true }), key(')', { shiftKey: true }), key('Enter', { shiftKey: true }), key('c')]) expect(terminalFontShortcut(e, false)).toBeNull();
    const cancelled = key('='); cancelled.preventDefault();
    expect(terminalFontShortcut(cancelled, false)).toBeNull();
  });
  it('clamps to existing bounds and resets to the catalog default', () => {
    expect(nextTerminalFontSize(9, 'decrease')).toBe(9);
    expect(nextTerminalFontSize(32, 'increase')).toBe(32);
    expect(nextTerminalFontSize(19, 'reset')).toBe(14);
    expect(nextTerminalFontSize(19, 'increase')).toBe(20);
    expect(nextTerminalFontSize(Number.NaN, 'decrease')).toBe(13);
  });
  it('excludes editable fields but accepts the actual xterm textarea', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input><textarea></textarea><select></select><div contenteditable="true"><b>Text</b></div><div role="textbox"></div><section class="terminal-pane"><textarea class="xterm-helper-textarea"></textarea></section><button>Tools</button>';
    for (const selector of ['input', 'textarea', 'select', 'b', '[role="textbox"]']) expect(acceptsTerminalFontShortcut(root.querySelector(selector))).toBe(false);
    expect(acceptsTerminalFontShortcut(root.querySelector('.xterm-helper-textarea'))).toBe(true);
    expect(acceptsTerminalFontShortcut(root.querySelector('button'))).toBe(true);
  });
  it('reserves zoom combinations against custom command conflicts', () => {
    for (const mac of [true, false]) {
      for (const binding of ['Mod+=', 'Mod++', 'Mod+Shift+=', 'Mod+Shift++', 'Mod+-', 'Mod+Shift+-', 'Mod+0', 'Mod+Shift+0']) expect(reservedWorkspaceShortcut(binding, mac)).toBe(true);
      expect(reservedWorkspaceShortcut('Mod+Alt+-', mac)).toBe(false);
    }
  });
});
