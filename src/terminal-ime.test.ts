/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import compositionSource from '../node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts?raw';
import terminalSource from '../node_modules/@xterm/xterm/src/browser/Terminal.ts?raw';
import { installCapsLockCommitGuard, shouldHandleTerminalKey } from './terminal-ime';
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
  it('characterizes the pinned dependency premature flush without the guard', () => {
    const h = harness(false);
    h.start('中文');
    h.key(caps({ isComposing: true }));
    expect(h.sent).toEqual(['中文']);
    h.end();
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文', '中文']);
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

// Execute the installed Terminal input method as well as CompositionHelper.
const terminalAst = ts.createSourceFile('Terminal.ts', terminalSource, ts.ScriptTarget.Latest, true);
const terminalClass = terminalAst.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'Terminal')!;
const inputMethod = terminalClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(terminalAst) === '_inputEvent')!;
const inputCompiled = ts.transpileModule(`class InputConsumer { ${inputMethod.getText(terminalAst)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const InputConsumer = new Function(`${inputCompiled}; return InputConsumer;`)() as new () => {
  _inputEvent: (event: InputEvent) => boolean;
  _keyDownSeen: boolean;
  _keyPressHandled: boolean;
  optionsService: unknown;
  coreService: unknown;
  cancel: () => void;
};
function dualRoute(guarded: boolean) {
  const observed = () => {};
  const h = harness(true, () => observed());
  const host = document.createElement('div');
  host.append(h.textarea);
  const consumer = new InputConsumer();
  consumer._keyDownSeen = false; // Isolated input eligibility; routedDom below dispatches actual keyup.
  consumer._keyPressHandled = false;
  consumer.optionsService = { rawOptions: { screenReaderMode: false } };
  consumer.coreService = { triggerDataEvent: (data: string) => { observed(); h.sent.push(data); } };
  consumer.cancel = () => {};
  h.textarea.addEventListener('input', (event) => consumer._inputEvent(event as InputEvent));
  h.textarea.addEventListener('compositionend', () => h.end());
  const dispose = guarded ? installCapsLockCommitGuard(host, { textarea: h.textarea, _core: { _compositionHelper: h.helper }, input: (data: string) => { observed(); h.sent.push(data); } } as Parameters<typeof installCapsLockCommitGuard>[1]) : () => {};
  return {
    ...h, dispose,
    unrelatedData() { h.sent.push('\x1b[0n'); },
    commit(text: string, capsLock = true) {
      h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      h.start(text);
      if (capsLock) h.textarea.dispatchEvent(caps());
      h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
      h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      vi.runAllTimers();
    },
  };
}
describe('CapsLock pending commit ownership across both installed xterm handlers', () => {
  it('characterizes duplicate insertText plus deferred finalizer despite the key guard', () => {
    const h = dualRoute(false);
    h.commit('中文');
    expect(h.sent).toEqual(['中文', '中文']);
  });
  it('keeps one commit and preserves consecutive identical transactions', () => {
    const h = dualRoute(true);
    h.commit('中文'); h.commit('中文');
    expect(h.sent).toEqual(['中文', '中文']);
    h.dispose();
  });
  it('does not filter ordinary insertText after the finalizer', () => {
    const h = dualRoute(true);
    h.commit('中文');
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    expect(h.sent).toEqual(['中文', '中文']);
    h.dispose();
  });
  it('does not cancel DOM insertion or suppress a cancelled composition', () => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('尚未提交');
    h.textarea.dispatchEvent(caps());
    h.textarea.value = '';
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const input = new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'a' });
    h.textarea.dispatchEvent(input);
    vi.runAllTimers();
    expect(h.sent).toEqual(['a']);
    expect(input.defaultPrevented).toBe(false);
    h.dispose();
  });
  it('preserves a distinct following insertion before the finalizer reads the textarea', () => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中文');
    h.textarea.dispatchEvent(caps());
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    h.textarea.value += '中文';
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文', '中文']);
    h.dispose();
  });
  it('removes event listeners and pending cleanup on disposal', () => {
    const h = dualRoute(true);
    h.dispose();
    h.commit('中文');
    expect(h.sent).toEqual(['中文', '中文']);
  });
  it('does not change a non-CapsLock transaction', () => {
    const h = dualRoute(true);
    h.commit('中文', false);
    expect(h.sent).toEqual(['中文', '中文']);
    h.dispose();
  });
});

describe('independent interrupted ownership review', () => {
  it.each([false,true])('retains committed input across synchronous focus loss guarded=%s', (guarded) => {
    const h = dualRoute(guarded);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中文');
    h.textarea.dispatchEvent(caps());
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: '中文' }));
    // Run installed Terminal._handleTextAreaBlur, whose first action clears textarea.
    const blurMethod = terminalClass.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(terminalAst) === '_handleTextAreaBlur')!;
    const blurCompiled = ts.transpileModule(`class BlurConsumer { ${blurMethod.getText(terminalAst)} }`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    const BlurConsumer = new Function(`${blurCompiled}; return BlurConsumer;`)();
    const blur = new BlurConsumer();
    Object.assign(blur, {textarea: h.textarea, refresh() {}, buffer: {y:0}, coreService: {decPrivateModes: {sendFocus:false}}, element: document.createElement('div'), _onBlur:{fire(){}}});
    h.textarea.addEventListener('blur', () => blur._handleTextAreaBlur());
    h.textarea.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文']);
    h.dispose();
  });
  it('does not flush again when blur runs after the real finalizer but before cleanup', () => {
    const h = dualRoute(true);
    h.textarea.addEventListener('compositionend', () => {
      setTimeout(() => h.textarea.dispatchEvent(new FocusEvent('blur')), 0);
    });
    h.textarea.addEventListener('blur', () => { h.textarea.value = ''; });
    h.commit('中文');
    expect(h.sent).toEqual(['中文']);
    h.dispose();
  });
  it.each([['Shift', 16], ['Control', 17], ['Alt', 18], ['Process', 229]] as const)('keeps finalizer ownership when ignored %s arrives before duplicate insertText', (key, keyCode) => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中文'); h.textarea.dispatchEvent(caps());
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const shift = new KeyboardEvent('keydown', {key, keyCode, bubbles:true});
    h.textarea.dispatchEvent(shift); h.key(shift);
    h.textarea.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText', data:'中文'}));
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文']);
    h.dispose();
  });
});

 describe('independent unrelated terminal response review', () => {
  it('preserves held commit if unrelated onData response occurs before blur', () => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
    h.start('中文'); h.textarea.dispatchEvent(caps());
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));
    h.textarea.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:'中文'}));
    h.unrelatedData();
    h.textarea.addEventListener('blur', () => {h.textarea.value = '';});
    h.textarea.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    expect(h.sent).toEqual(['中文', '\x1b[0n']);
    h.dispose();
  });
 });

// Sending is synchronous now: completion precedes any reentrant focus/input work.
describe('pinned pending-finalizer adapter boundaries', () => {
  it('fails open when the private dependency shape is unavailable', () => {
    const host = document.createElement('div');
    const textarea = document.createElement('textarea'); host.append(textarea);
    const received = vi.fn(); textarea.addEventListener('input', received);
    const send = vi.fn(); const dispose = installCapsLockCommitGuard(host, { textarea, input: send });
    textarea.dispatchEvent(caps());
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    expect(received).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    dispose();
  });
  it('marks the real pending send complete before a reentrant emission can blur', () => {
    const h = harness(); const host = document.createElement('div'); host.append(h.textarea);
    let pendingDuringSend = true;
    const terminal = { textarea: h.textarea, _core: { _compositionHelper: h.helper }, input(data: string) {
      pendingDuringSend = (h.helper as unknown as { _isSendingComposition: boolean })._isSendingComposition;
      h.sent.push(data); h.textarea.value = ''; vi.runAllTimers();
    } };
    const dispose = installCapsLockCommitGuard(host, terminal);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中文'); h.textarea.dispatchEvent(caps()); h.end();
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    expect(pendingDuringSend).toBe(false); expect(h.sent).toEqual(['中文']); dispose();
  });
});

describe('deferred finalizer range compatibility', () => {
  it('uses the final textarea range rather than stale compositionupdate end', () => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中'); h.textarea.dispatchEvent(caps()); h.textarea.value = '中文';
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' }));
    vi.runAllTimers(); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('preserves the installed finalizer already-sent offset', () => {
    const h = dualRoute(true);
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.start('中文'); h.textarea.dispatchEvent(caps());
    (h.helper as unknown as { _dataAlreadySent: string })._dataAlreadySent = '中';
    h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    h.textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '文' }));
    vi.runAllTimers(); expect(h.sent).toEqual(['文']); h.dispose();
  });
});

// DOM-level sequences below execute xterm's actual keydown, keyup, keypress,
// input, blur and composition handlers. No keyboard-state flag is fabricated.
// Rendering/services are inert because this is a synthetic routing regression,
// not evidence of macOS/WKWebView or an installed input method's event order.
import keyboardSource from '../node_modules/@xterm/xterm/src/common/input/Keyboard.ts?raw';
import escapeSource from '../node_modules/@xterm/xterm/src/common/data/EscapeSequences.ts?raw';
import typesSource from '../node_modules/@xterm/xterm/src/common/Types.d.ts?raw';

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
  const emit = (data: string) => h.sent.push(data);
  Object.assign(terminal, {
    textarea: h.textarea, element: host,
    _compositionHelper: h.helper, _customKeyEventHandler: shouldHandleTerminalKey,
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
  const dispose = guarded ? installCapsLockCommitGuard(host, {
    textarea: h.textarea, input: emit, options: { screenReaderMode }, _core: { _compositionHelper: h.helper },
  } as Parameters<typeof installCapsLockCommitGuard>[1]) : () => {};
  return {
    ...h, dispose, host,
    begin(text: string) {
      h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      h.textarea.value += text;
      h.textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
      vi.runAllTimers();
    },
    caps() { h.textarea.dispatchEvent(caps()); },
    up() { h.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'CapsLock', keyCode: 20, bubbles: true })); },
    end() { h.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); },
    insert(text: string, composed = true) {
      const event = new InputEvent('input', { bubbles: true, composed, cancelable: true, inputType: 'insertText', data: text });
      h.textarea.dispatchEvent(event);
      return event;
    },
  };
}

describe('installed xterm DOM keyboard and composition routing', () => {
  it.each([false, true])('captures the keyup-before-insertText duplicate, guard=%s', (guarded) => {
    const h = routedDom(guarded);
    h.begin('中文'); h.caps(); h.up(); h.end(); h.insert('中文'); vi.runAllTimers();
    expect(h.sent).toEqual(guarded ? ['中文'] : ['中文', '中文']); h.dispose();
  });
  it.each([true, false])('preserves commit with keyup after composed=%s input', (composed) => {
    const h = routedDom();
    h.begin('中文'); h.caps(); h.end(); const event = h.insert('中文', composed); h.up(); vi.runAllTimers();
    expect(h.sent).toEqual(['中文']); expect(event.defaultPrevented).toBe(false); h.dispose();
  });
  it('preserves actual next Enter routing and clears the textarea', () => {
    const h = routedDom(); h.begin('中文'); h.caps(); h.up(); h.end(); h.insert('中文');
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    vi.runAllTimers(); expect(h.sent).toEqual(['中文', '\r']); expect(h.textarea.value).toBe(''); h.dispose();
  });
  it('preserves two identical commits with real compositionstart/keyup transitions', () => {
    const h = routedDom();
    for (let i = 0; i < 2; i++) {
      h.begin('中文'); h.caps(); h.up(); h.end(); h.insert('中文'); vi.runAllTimers();
    }
    expect(h.sent).toEqual(['中文', '中文']); h.dispose();
  });
  it('preserves cancellation and the next normal character through keypress', () => {
    const h = routedDom(); h.begin('中文'); h.caps(); h.up(); h.textarea.value = ''; h.end(); vi.runAllTimers();
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', keyCode: 65, bubbles: true }));
    h.textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'A', charCode: 65, keyCode: 65, bubbles: true }));
    h.textarea.value = 'A'; h.insert('A');
    expect(h.sent).toEqual(['A']); h.dispose();
  });
  it('preserves committed data across the real blur handler before timers', () => {
    const h = routedDom(); h.begin('中文'); h.caps(); h.up(); h.end(); h.insert('中文');
    h.textarea.dispatchEvent(new FocusEvent('blur')); vi.runAllTimers();
    expect(h.sent).toEqual(['中文']); expect(h.textarea.value).toBe(''); h.dispose();
  });
});

describe('pending transaction restart regression', () => {
  it('does not resurrect an already-consumed timer when the next transaction ends', () => {
    const h = routedDom(); h.begin('甲'); h.caps(); h.up(); h.end(); h.insert('甲');
    // Deliberately do not run timers between native transaction boundaries.
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.textarea.value += '乙'; h.end();
    vi.runAllTimers(); expect(h.sent).toEqual(['甲', '乙']); h.dispose();
  });
  it('does not discard an earlier pending commit when a later CapsLock commit is consumed', () => {
    const h = routedDom(); h.begin('甲'); h.end();
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.textarea.value += '乙'; h.caps(); h.up(); h.end(); h.insert('乙');
    vi.runAllTimers(); expect(h.sent).toEqual(['甲', '乙']); h.dispose();
  });
});


describe('transaction finalizer compatibility without native CapsLock interception', () => {
  it('leaves screen-reader input propagation available and commits once', () => {
    const h = routedDom(true, true); const listener = vi.fn();
    h.host.addEventListener('input', listener);
    h.begin('中文'); h.caps(); h.up(); h.end(); h.insert('中文'); vi.runAllTimers();
    expect(listener).toHaveBeenCalledOnce(); expect(h.sent).toEqual(['中文']); h.dispose();
  });
  it('preserves ordinary commits and the next Enter before the propagation timer', () => {
    const h = routedDom(); h.begin('中文'); h.end();
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    vi.runAllTimers(); expect(h.sent).toEqual(['中文', '\r']); h.dispose();
  });
  it('preserves two non-CapsLock compositions ending in the same task', () => {
    const h = routedDom(); h.begin('甲'); h.end();
    h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    h.textarea.value += '乙'; h.end(); vi.runAllTimers();
    expect(h.sent).toEqual(['甲', '乙']); h.dispose();
  });
  it('cancels the owned propagation callback when the terminal is disposed', () => {
    const h = routedDom(); h.begin('中文'); h.end(); h.dispose();
    vi.runAllTimers(); expect(h.sent).toEqual([]);
  });
});


it('uses the final value when a Korean-style trailing consonant rolls into the next composition', () => {
  const h = routedDom(); h.begin('가ㄴ'); h.textarea.value = '가'; h.end();
  h.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  h.textarea.value += '나'; h.end(); vi.runAllTimers();
  expect(h.sent).toEqual(['가', '나']); h.dispose();
});
