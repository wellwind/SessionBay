/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import compositionSource from '../node_modules/@xterm/xterm/src/browser/input/CompositionHelper.ts?raw';
import { shouldHandleTerminalKey } from './terminal-ime';
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

function harness(guarded = true) {
  const textarea = document.createElement('textarea');
  const view = document.createElement('div');
  const sent: string[] = [];
  const helper = new moduleExports.CompositionHelper!(textarea, view,
    { buffer: { isCursorInViewport: false } }, {}, { triggerDataEvent: (data: string) => sent.push(data) }, {});
  return {
    textarea, sent,
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
