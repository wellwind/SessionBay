/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import clipboardSource from '../node_modules/@xterm/xterm/src/browser/Clipboard.ts?raw';
import keyboardSource from '../node_modules/@xterm/xterm/src/common/input/Keyboard.ts?raw';
import { describeDraft, draftProblem, isTerminalDraftKey, terminalDraftLimit } from './terminal-draft';
import { reservedTerminalDraftShortcut, shortcutConflicts } from './commands';

const key = (init: KeyboardEventInit = {}, type = 'keydown') => new KeyboardEvent(type, {
  key: 'Enter', keyCode: 13, shiftKey: true, ...init,
});

describe('terminal local draft shortcut', () => {
  it('only recognizes unmodified Shift+Enter keydown, outside composition', () => {
    expect(isTerminalDraftKey(key())).toBe(true);
    expect(isTerminalDraftKey(key(), true)).toBe(false);
    for (const init of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
      { isComposing: true }, { keyCode: 229 }, { key: 'Process' }, { key: 'CapsLock' }])
      expect(isTerminalDraftKey(key(init))).toBe(false);
    expect(isTerminalDraftKey(key({}, 'keyup'))).toBe(false);
    expect(isTerminalDraftKey(key({}, 'keypress'))).toBe(false);
  });
  it('reserves aliases against custom workspace commands without reserving Ctrl+Enter', () => {
    expect(reservedTerminalDraftShortcut('shift+Return')).toBe(true);
    expect(reservedTerminalDraftShortcut('CTRL+Shift+Enter')).toBe(false);
    expect(shortcutConflicts({ one: 'Shift+Enter', two: 'Ctrl+Enter' })).toEqual(new Set(['one']));
  });
  it('reports all trailing newlines without trimming or changing the draft', () => {
    expect(describeDraft('a\r\nb\n\n')).toBe('4 行 · 末尾有 2 個換行，會一併貼上');
    expect(describeDraft('  ')).toBe('1 行 · 末尾沒有換行');
    expect(draftProblem(' \t中文\n\n')).toBe(null);
    expect(draftProblem('')).toContain('請先');
  });
  it('rejects terminal control injection and oversized UTF-8, without rewriting content', () => {
    for (const text of ['x\x1b[201~\r', '\x03', '\x00', '\x7f', '\x9b']) expect(draftProblem(text)).toContain('控制字元');
    expect(draftProblem('a'.repeat(terminalDraftLimit))).toBe(null);
    expect(draftProblem('中'.repeat(Math.ceil(terminalDraftLimit / 3)))).toContain('上限');
  });
});

function load<T>(source: string): T {
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function('exports', 'require', output)(exports, (name: string) => {
    if (name === 'common/Types') return { KeyboardResultType: { SEND_KEY: 0 } };
    if (name === 'common/data/EscapeSequences') return { C0: { CR: '\r', ESC: '\x1b', LF: '\n' } };
    throw new Error(`Unexpected xterm dependency: ${name}`);
  });
  return exports as T;
}

describe('installed xterm 5.5 input contract (actual dependency source)', () => {
  const clipboard = load<{ paste: (text: string, textarea: HTMLTextAreaElement, core: unknown, options: unknown) => void }>(clipboardSource);
  const keyboard = load<{ evaluateKeyboardEvent: (event: KeyboardEvent, cursor: boolean, mac: boolean, meta: boolean) => { key: string } }>(keyboardSource);
  it.each([false, true])('keeps Enter encoding unchanged on mac=%s', (mac) => {
    expect(keyboard.evaluateKeyboardEvent(key({ shiftKey: false }), false, mac, false).key).toBe('\r');
    // This is why the local editor intercepts the chord rather than sending its fallback.
    expect(keyboard.evaluateKeyboardEvent(key(), false, mac, false).key).toBe('\r');
  });
  it.each([false, true])('preserves content and trailing line count through existing bracketed-paste=%s', (bracketedPasteMode) => {
    const sent: string[] = [];
    clipboard.paste('  one\r\n中文\t\n\n', document.createElement('textarea'), {
      decPrivateModes: { bracketedPasteMode }, triggerDataEvent: (text: string) => sent.push(text),
    }, { rawOptions: {} });
    const content = '  one\r中文\t\r\r';
    expect(sent).toEqual([bracketedPasteMode ? '\x1b[200~' + content + '\x1b[201~' : content]);
  });
});
