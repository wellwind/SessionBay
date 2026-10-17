/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import compositionSource from '../node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts?raw';
import terminalSource from '../node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts?raw';
import { shouldHandleTerminalKey } from './terminal-ime';
import { handleTerminalKey, shiftEnterSequence } from './terminal-keyboard';
import { TerminalInputQueue } from './terminal-queue';

interface Composition {
  compositionstart(): void;
  compositionupdate(event: Pick<CompositionEvent, 'data'>): void;
  compositionend(): void;
  keydown(event: KeyboardEvent): boolean;
}
type CompositionConstructor = new (...dependencies: unknown[]) => Composition;

// Exercise the installed dependency, not a rewritten model of its input logic.
// Only its DI decorators are removed; TypeScript erases type annotations/imports.
// No bundled source is modified and this harness never enters the product build.
const compiled = ts.transpileModule(compositionSource.replace(
  /@(IBufferService|IOptionsService|ICoreService|IRenderService)\s+/g, '',
), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const moduleExports: { CompositionHelper?: CompositionConstructor } = {};
new Function('exports', 'require', compiled)(moduleExports, (name: string) => {
  if (name !== 'common/data/EscapeSequences') throw new Error(`Unexpected xterm test dependency: ${name}`);
  return { C0: { DEL: '\x7f' } };
});

function harness(guarded = true, onEmit: () => void = () => {}) {
  const textarea = document.createElement('textarea');
  const view = document.createElement('div');
  const sent: string[] = [];
  const helper = new moduleExports.CompositionHelper!(textarea, view,
    { buffer: { isCursorInViewport: false } }, {}, { triggerDataEvent: (data: string) => { onEmit(); sent.push(data); } }, {});
  return {
    textarea, sent, helper,
    start(text: string) {
      helper.compositionstart();
      textarea.value += text;
      helper.compositionupdate({ data: text });
      vi.runAllTimers();
    },
    key(event: KeyboardEvent) {
      if (!guarded || shouldHandleTerminalKey(event)) helper.keydown(event);
    },
    end() { helper.compositionend(); },
  };
}
const caps = (init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', {
  key: 'CapsLock', code: 'CapsLock', keyCode: 20, bubbles: true, cancelable: true, ...init,
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CapsLock terminal IME guard with installed xterm CompositionHelper', () => {
  it('uses the upstream 6.0 CapsLock fix even without the semantic app guard', () => {
    const h = harness(false);
    h.start('中文');
    h.key(caps({ isComposing: true }));
    expect(h.sent).toEqual([]);
    h.end();
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文']);
  });

  it.each([true, false])('sends a native commit only once even if keydown isComposing is %s', (isComposing) => {
    const h = harness();
    h.start('中文');
    h.key(caps({ isComposing }));
    expect(h.sent).toEqual([]);
    h.end();
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文']);
  });

  it('lets a genuine native cancellation remove preedit without sending it', () => {
    const h = harness();
    h.start('尚未提交');
    h.key(caps());
    h.textarea.value = '';
    h.end();
    vi.runAllTimers();
    expect(h.sent).toEqual([]);
  });

  it('preserves a pending compositionend when CapsLock keydown arrives afterward', () => {
    const h = harness();
    h.start('中文');
    h.end();
    h.key(caps());
    expect(h.sent).toEqual([]);
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文']);
  });

  it('preserves two legitimate identical commits and normal composition without CapsLock', () => {
    const h = harness();
    for (let count = 0; count < 2; count++) {
      h.start('中文');
      h.end();
      vi.runAllTimers();
    }
    expect(h.sent).toEqual(['中文', '中文']);
  });

  it.each(['', 'Unidentified'])('supports a legacy CapsLock keyCode only when key is %j', (key) => {
    expect(shouldHandleTerminalKey(caps({ key }))).toBe(false);
  });

  it('does not cancel native input-source switching or stop DOM propagation', () => {
    const event = caps();
    const prevent = vi.spyOn(event, 'preventDefault');
    const stop = vi.spyOn(event, 'stopPropagation');
    expect(shouldHandleTerminalKey(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(prevent).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    ['a', 'KeyA', 65, false, false], ['A', 'KeyA', 65, false, false],
    ['Enter', 'Enter', 13, false, false], ['Escape', 'CapsLock', 20, false, false],
    ['Process', 'KeyA', 229, false, false], ['Dead', 'KeyN', 78, false, false],
    ['c', 'KeyC', 67, true, false], ['v', 'KeyV', 86, false, true],
    ['Tab', 'Tab', 9, true, false], ['1', 'Digit1', 49, false, true],
  ] as const)('passes ordinary, remapped, IME, or shortcut key %s unchanged', (key, code, keyCode, ctrlKey, metaKey) => {
    const event = new KeyboardEvent('keydown', { key, code, keyCode, ctrlKey, metaKey, cancelable: true });
    expect(shouldHandleTerminalKey(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['keyup', 'keypress'])('does not intercept CapsLock %s', (type) => {
    expect(shouldHandleTerminalKey(new KeyboardEvent(type, { key: 'CapsLock', keyCode: 20 }))).toBe(true);
  });

  it('does not deduplicate input bytes, repeated paste, or terminal shortcut sequences', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new TerminalInputQueue(send, vi.fn());
    const chunks = ['aa', 'aa', '中文中文', '\x1b[200~中文中文\nnext\x1b[201~', '\x1b[200~中文中文\nnext\x1b[201~', '\x03', '\r', '\t'];
    for (const chunk of chunks) queue.enqueue('synthetic-runtime', chunk);
    await queue.drained();
    expect(send.mock.calls.map(([, data]) => data)).toEqual(chunks);
  });
});

// Execute installed keydown/up/press/input/blur and keyboard evaluator with
// the same single public hook as TerminalPane. Rendering services are inert.
const terminalAst = ts.createSourceFile('CoreBrowserTerminal.ts', terminalSource, ts.ScriptTarget.Latest, true);
const terminalClass = terminalAst.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CoreBrowserTerminal')!;
import keyboardSource from '../node_modules/@xterm/xterm/src/common/input/Keyboard.ts?raw';
import escapeSource from '../node_modules/@xterm/xterm/src/common/data/EscapeSequences.ts?raw';
import typesSource from '../node_modules/@xterm/xterm/src/common/Types.ts?raw';

function executeSource(source: string, dependencies: Record<string, unknown> = {}): Record<string, unknown> {
  const exports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('exports', 'require', output)(exports, (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected xterm dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}
const escapeExports = executeSource(escapeSource);
const typesAst = ts.createSourceFile('Types.ts', typesSource, ts.ScriptTarget.Latest, true);
const keyboardEnum = typesAst.statements.find((node) => ts.isEnumDeclaration(node) && node.name.text === 'KeyboardResultType')!;
const enumExports = executeSource(keyboardEnum.getText(typesAst));
const keyboardExports = executeSource(keyboardSource, {
  'common/Types': enumExports, 'common/data/EscapeSequences': escapeExports,
});
const routedMethods = ['_keyDown', '_keyUp', '_keyPress', '_isThirdLevelShift', '_inputEvent', '_handleTextAreaBlur', 'cancel'];
const methodSource = routedMethods.map((name) => terminalClass.members.find((node) =>
  ts.isMethodDeclaration(node) && node.name.getText(terminalAst) === name)!.getText(terminalAst)).join('\n');
const modifierFunction = terminalAst.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'wasModifierKeyOnlyEvent')!.getText(terminalAst);
const routedExports = executeSource(`
  import { C0 } from 'escapes';
  import { KeyboardResultType } from 'types';
  import { evaluateKeyboardEvent } from 'keyboard';
  ${modifierFunction}
  export class RoutedTerminal { ${methodSource} }
`, { escapes: escapeExports, types: enumExports, keyboard: keyboardExports });
interface RoutedTerminal {
  _keyDown(event: KeyboardEvent): boolean | undefined;
  _keyUp(event: KeyboardEvent): void;
  _keyPress(event: KeyboardEvent): boolean;
  _inputEvent(event: InputEvent): boolean;
  _handleTextAreaBlur(): void;
}
const RoutedTerminal = routedExports.RoutedTerminal as new () => RoutedTerminal;
function routedDom(guarded = true, screenReaderMode = false) {
  const h = harness();
  const host = document.createElement('div'); host.append(h.textarea);
  const terminal = new RoutedTerminal();
  let composing = false;
  host.addEventListener('compositionstart', () => { composing = true; }, true);
  host.addEventListener('compositionend', () => { composing = false; }, true);
  const emit = (data: string) => h.sent.push(data);
  Object.assign(terminal, {
    textarea: h.textarea, element: host,
    _compositionHelper: h.helper,
    _customKeyEventHandler: guarded ? (event: KeyboardEvent) => handleTerminalKey(event, {
      composing, canInput: true, blocked: false, input: emit,
    }) : shouldHandleTerminalKey,
    browser: { isMac: true, isWindows: false },
    options: { macOptionIsMeta: false, scrollOnUserInput: false, cancelEvents: false },
    optionsService: { rawOptions: { screenReaderMode, cancelEvents: false } },
    coreService: { triggerDataEvent: emit, decPrivateModes: {} },
    buffer: { y: 0 }, rows: 24,
    updateCursorStyle() {}, focus() {}, refresh() {}, _showCursor() {},
    _onKey: { fire() {} }, _onBlur: { fire() {} },
  });
  h.textarea.addEventListener('compositionstart', () => h.helper.compositionstart());
  h.textarea.addEventListener('compositionupdate', (event) => h.helper.compositionupdate(event));
  h.textarea.addEventListener('compositionend', () => h.helper.compositionend());
  h.textarea.addEventListener('keydown', (event) => terminal._keyDown(event), true);
  h.textarea.addEventListener('keyup', (event) => terminal._keyUp(event), true);
  h.textarea.addEventListener('keypress', (event) => terminal._keyPress(event), true);
  h.textarea.addEventListener('input', (event) => terminal._inputEvent(event as InputEvent), true);
  h.textarea.addEventListener('blur', () => terminal._handleTextAreaBlur());

  return {
    ...h, dispose: () => host.remove(), host,
    begin(text: string) {
      h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      h.textarea.value += text;
      h.textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
      vi.runAllTimers();
    },
    caps() { h.textarea.dispatchEvent(caps()); },
    up() { h.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'CapsLock', keyCode: 20, bubbles: true })); },
    end() { h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); },
    insert(text: string, composed = true, inputType = 'insertFromComposition') {
      const event = new InputEvent('input', { bubbles: true, composed, cancelable: true, inputType, data: text });
      h.textarea.dispatchEvent(event);
      return event;
    },
  };
}


// Observed trusted event order, without inventing its unrecorded legacy keyCode.
function nativeCapsSequence(h: ReturnType<typeof routedDom>, keyCode: number) {
  h.textarea.dispatchEvent(caps({ isComposing: true }));
  vi.advanceTimersByTime(4);
  h.textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Unidentified', keyCode, isComposing: true, bubbles: true, composed: true,
  }));
  vi.advanceTimersByTime(103);
  h.textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteCompositionText', bubbles: true, composed: true }));
  h.textarea.value = '';
  h.textarea.dispatchEvent(new InputEvent('input', { inputType: 'deleteCompositionText', bubbles: true, composed: true }));
  h.textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromComposition', data: '中文', bubbles: true, composed: true }));
  h.textarea.value = '中文'; h.insert('中文');
  h.end(); vi.advanceTimersByTime(6); h.up(); vi.runAllTimers();
}

describe('upstream 6.0 with a public composing-key hook', () => {
  it.each([[0, ['中文', '中文']], [229, ['中文']]] as const)(
    'characterizes upstream-only unknown-keyCode branch %s', (keyCode, expected) => {
      const h = routedDom(false); h.begin('中文'); nativeCapsSequence(h, keyCode);
      expect(h.sent).toEqual(expected); h.dispose();
    },
  );
  it.each([0, 229, 65])('keeps browser-marked preedit until native commit, legacy code %s', (keyCode) => {
    const h = routedDom(); h.begin('中文'); nativeCapsSequence(h, keyCode);
    expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('does not cancel or stop propagation of composing key, input or composition events', () => {
    const h = routedDom(); h.begin('中文');
    const key = new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 0, isComposing: true, bubbles: true, cancelable: true });
    const listener = vi.fn(); h.host.addEventListener('keydown', listener);
    h.textarea.dispatchEvent(key); const input = h.insert('中文');
    expect(key.defaultPrevented).toBe(false); expect(input.defaultPrevented).toBe(false);
    expect(listener).toHaveBeenCalledOnce(); expect(h.sent).toEqual([]);
    h.end(); vi.runAllTimers(); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it.each([false, true])('lets native composition Enter finish without sending CR/CSI (shift=%s)', (shiftKey) => {
    const h = routedDom(); h.begin('中文');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: true, shiftKey, bubbles: true }));
    expect(h.sent).toEqual([]); h.insert('中文'); h.end(); vi.runAllTimers();
    expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('leaves a browser-marked composing CtrlC to the IME without sending ETX', () => {
    const h = routedDom(); h.begin('中文');
    const event = new KeyboardEvent('keydown', { key: 'c', keyCode: 67, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
    h.textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(h.sent).toEqual([]);
    h.end(); vi.runAllTimers(); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it.each([false, true])('characterizes upstream composing Enter keypress if a browser emits it (shift=%s)', (shiftKey) => {
    const h = routedDom(); h.begin('中文');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: true, shiftKey, bubbles: true }));
    h.textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', charCode: 13, keyCode: 13, isComposing: true, shiftKey, bubbles: true }));
    // Native occurrence is unverified. The public keydown hook does not change this upstream phase.
    expect(h.sent).toEqual(['\r']); h.dispose();
  });
  it('preserves non-composing Enter while helper still has preedit', () => {
    const h = routedDom(); h.begin('中文');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true }));
    expect(h.sent).toEqual(['中文', '\r']); h.dispose();
  });
  it('preserves normal Enter, ShiftEnter and CtrlC after composition completes', () => {
    const h = routedDom(); h.begin('中文'); nativeCapsSequence(h, 0);
    for (const init of [
      { key: 'Enter', keyCode: 13 }, { key: 'Enter', keyCode: 13, shiftKey: true },
      { key: 'c', keyCode: 67, ctrlKey: true },
    ]) h.textarea.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    expect(h.sent).toEqual(['中文', '\r', shiftEnterSequence, '\x03']); h.dispose();
  });
  it('preserves normal CtrlC during preedit when the browser marks it non-composing', () => {
    const h = routedDom(); h.begin('中文');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', keyCode: 67, ctrlKey: true, isComposing: false, bubbles: true }));
    expect(h.sent).toEqual(['中文', '\x03']); h.dispose();
  });
  it('preserves cancellation and ordinary letters after compositionend', () => {
    const h = routedDom(); h.begin('中文'); h.caps();
    h.textarea.value = ''; h.end(); vi.runAllTimers();
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, bubbles: true }));
    expect(h.sent).toEqual(['a']); h.dispose();
  });
  it('keeps two legitimate identical native commits', () => {
    const h = routedDom();
    for (let i = 0; i < 2; i++) { h.begin('中文'); nativeCapsSequence(h, 0); h.textarea.value = ''; }
    expect(h.sent).toEqual(['中文', '中文']); h.dispose();
  });
  it('leaves screen-reader event propagation and native commit intact', () => {
    const h = routedDom(true, true); const listener = vi.fn(); h.host.addEventListener('input', listener);
    h.begin('中文'); nativeCapsSequence(h, 0);
    expect(listener).toHaveBeenCalledTimes(2); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('does not erase a committed input when real blur clears the textarea afterward', () => {
    const h = routedDom(); h.begin('中文'); nativeCapsSequence(h, 0);
    h.textarea.dispatchEvent(new FocusEvent('blur'));
    expect(h.textarea.value).toBe(''); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('applies the upstream principle to a dead key completed with a real keyCode', () => {
    const h = routedDom(); h.begin('`');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, isComposing: true, bubbles: true }));
    h.textarea.value = 'à'; h.end(); vi.runAllTimers();
    expect(h.sent).toEqual(['à']); h.dispose();
  });
});
