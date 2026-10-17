/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import clipboardSource from '../node_modules/@xterm/xterm/src/browser/Clipboard.ts?raw';
import { filePasteText } from './file-input';
import { TerminalInputQueue } from './terminal-queue';

// Execute the installed xterm implementation, not a substitute framing helper.
const compiled = ts.transpileModule(clipboardSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
interface Core {
  decPrivateModes: { bracketedPasteMode: boolean };
  triggerDataEvent(data: string, userInput: boolean): void;
}
const exports: { paste?: (text: string, textarea: { value: string }, core: Core, options: { rawOptions: { ignoreBracketedPasteMode?: boolean } }) => void } = {};
new Function('exports', 'require', compiled)(exports, (name: string) => {
  throw new Error(`Unexpected xterm clipboard dependency: ${name}`);
});

describe('file input framing through installed xterm and the product queue', () => {
  it('keeps images and a later caption in distinct paste frames without Enter, even when PTY writes coalesce', async () => {
    const writes: string[] = [];
    const send = vi.fn(async (_runtimeId: string, bytes: string) => { writes.push(bytes); });
    const queue = new TerminalInputQueue(send, (error) => { throw error; });
    const core: Core = { decPrivateModes: { bracketedPasteMode: true }, triggerDataEvent: (bytes) => { queue.enqueue('synthetic', bytes); } };
    const image = filePasteText('codex', '/private/專案 alpha/色塊 probe.png');
    const payloads = [image, image, 'Describe the image'];
    for (const text of payloads) exports.paste!(text, { value: '' }, core, { rawOptions: {} });
    await queue.drained();
    expect(writes).toEqual(payloads.map((body) => `\x1b[200~${body}\x1b[201~`));
    expect(send.mock.calls.every(([id]) => id === 'synthetic')).toBe(true);
    // The backend may concatenate byte chunks; it must not strip the boundaries.
    expect(writes.join('').split('\x1b[201~\x1b[200~')).toHaveLength(3);
    expect(writes.join('')).not.toMatch(/[\r\n]/);
    expect(queue.pending).toBe(0);
  });

  it.each([[false, false], [true, true]])('characterizes plain text when mode=%s and ignore=%s', (mode, ignore) => {
    const send = vi.fn();
    const core: Core = { decPrivateModes: { bracketedPasteMode: mode }, triggerDataEvent: send };
    const text = filePasteText('codex', '/private/probe.png');
    exports.paste!(text, { value: '' }, core, { rawOptions: { ignoreBracketedPasteMode: ignore } });
    expect(send).toHaveBeenCalledExactlyOnceWith(text, true);
    // TerminalPane rejects disabled mode, and does not enable ignoreBracketedPasteMode.
    // Plain terminal text is not evidence of native attachment recognition.
  });
});
