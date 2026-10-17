/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import vector from '../fixtures/keyboard/shift-enter.json';
import terminalSource from '../node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts?raw';
import keyboardSource from '../node_modules/@xterm/xterm/src/common/input/Keyboard.ts?raw';
import { handleTerminalKey, shiftEnterSequence } from './terminal-keyboard';
import { reservedWorkspaceShortcut, shortcutConflicts } from './commands';

const key = (type = 'keydown', init: KeyboardEventInit = {}) => new KeyboardEvent(type, {
  key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true, cancelable: true, ...init,
});
function harness(patch: Partial<Parameters<typeof handleTerminalKey>[1]> = {}) {
  const input = vi.fn();
  const options = { composing: false, canInput: true, blocked: false, input, ...patch };
  return { input, run: (event: KeyboardEvent) => handleTerminalKey(event, options) };
}

describe('explicit modified Enter compatibility', () => {
  it('consumes all three phases with exactly one input and no CR/LF', () => {
    const h = harness();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = key(type);
      expect(h.run(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(h.input).toHaveBeenCalledExactlyOnceWith('\x1b[13;2u');
    expect([...new TextEncoder().encode(shiftEnterSequence)]).toEqual([27, 91, 49, 51, 59, 50, 117]);
    expect(shiftEnterSequence).not.toMatch(/[\r\n]/);
    expect(shiftEnterSequence).toBe(vector.encoding);
    expect(vector.hex).toBe('1b5b31333b3275');
  });
  it('preserves a repeated keydown as one additional modified key, not a release event', () => {
    const h = harness();
    h.run(key()); h.run(key('keydown', { repeat: true })); h.run(key('keyup'));
    expect(h.input.mock.calls).toEqual([[shiftEnterSequence], [shiftEnterSequence]]);
  });
  it.each([
    { shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { key: 'a' }, { key: 'Process', keyCode: 229 }, { isComposing: true }, { keyCode: 229 },
  ])('preserves ordinary keys / other modifiers / IME %j', (init) => {
    const h = harness(); const event = key('keydown', init);
    expect(h.run(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(h.input).not.toHaveBeenCalled();
  });
  it('does not interfere with active IME composition', () => {
    const h = harness({ composing: true }); const event = key();
    expect(h.run(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(h.input).not.toHaveBeenCalled();
  });
  it.each([{ canInput: false }, { blocked: true }])('never emits on stale/unavailable target %j', (options) => {
    const h = harness(options);
    expect(h.run(key())).toBe(false);
    expect(h.input).not.toHaveBeenCalled();
  });
  it('keeps CapsLock native composition handling without cancelling the DOM event', () => {
    const h = harness(); const event = key('keydown', { key: 'CapsLock', keyCode: 20 });
    expect(h.run(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(h.input).not.toHaveBeenCalled();
  });
  it('reserves Shift+Enter and its alias against global action bindings', () => {
    expect(reservedWorkspaceShortcut('Shift+Enter')).toBe(true);
    expect(reservedWorkspaceShortcut('shift+return')).toBe(true);
    expect(shortcutConflicts({ 'close-pane': 'Shift+Enter' }).has('close-pane')).toBe(true);
    expect(reservedWorkspaceShortcut('Ctrl+Enter')).toBe(false);
  });
});

// Characterize the installed xterm 5.5 evaluator rather than assuming the emulator's encoding.
const compiled = ts.transpileModule(keyboardSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports: { evaluateKeyboardEvent?: (event: KeyboardEvent, ...options: boolean[]) => { key?: string } } = {};
new Function('exports', 'require', compiled)(exports, (name: string) => {
  if (name === 'common/Types') return { KeyboardResultType: { SEND_KEY: 0, SELECT_ALL: 1, PAGE_UP: 2, PAGE_DOWN: 3 } };
  if (name === 'common/data/EscapeSequences') return { C0: { ESC: '\x1b', CR: '\r', LF: '\n', DEL: '\x7f', HT: '\t', BS: '\b' } };
  throw new Error(`Unexpected xterm keyboard dependency: ${name}`);
});
it('installed xterm maps both Enter and Shift+Enter to CR before the compatibility hook', () => {
  expect(exports.evaluateKeyboardEvent!(key('keydown', { shiftKey: false }), false, false, false).key).toBe('\r');
  expect(exports.evaluateKeyboardEvent!(key(), false, false, false).key).toBe('\r');
});

// Run the installed xterm phase methods with the real hook. Any fall-through
// would need missing terminal services and fail rather than silently passing.
const source = ts.createSourceFile('Terminal.ts', terminalSource, ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CoreBrowserTerminal')!;
const methods = declaration.members.filter((node) => ts.isMethodDeclaration(node) && ['_keyDown', '_keyPress', '_keyUp'].includes(node.name.getText(source)));
const phaseCode = ts.transpileModule(`exports.Phases = class { ${methods.map((node) => node.getText(source)).join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
interface PhaseHarness {
  _customKeyEventHandler: (event: KeyboardEvent) => boolean;
  _keyDown(event: KeyboardEvent): unknown;
  _keyPress(event: KeyboardEvent): unknown;
  _keyUp(event: KeyboardEvent): unknown;
}
const phases: { Phases?: new () => PhaseHarness } = {};
new Function('exports', phaseCode)(phases);
it('installed xterm phase methods cannot fall through to a second CR after the hook', () => {
  const h = harness(); const terminal = new phases.Phases!();
  terminal._customKeyEventHandler = h.run;
  terminal._keyDown(key('keydown'));
  terminal._keyPress(key('keypress'));
  terminal._keyUp(key('keyup'));
  expect(h.input).toHaveBeenCalledExactlyOnceWith(shiftEnterSequence);
});
