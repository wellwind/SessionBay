import { createGhosttyTerminal } from '../../src/ghostty-terminal';
import { handleTerminalKey } from '../../src/terminal-keyboard';

// Synthetic data only: drives the real ghostty-web bundle and WASM through the adapter.
const host = document.querySelector<HTMLElement>('#terminal')!;
const events: string[] = [];
const sent: string[] = [];
const write = (terminal: { write(data: string, done: () => void): void }, data: string) =>
  new Promise<void>(resolve => terminal.write(data, resolve));

async function scenario() {
  const created = await createGhosttyTerminal({
    fontSize: 14, fontFamily: 'monospace', theme: { background: '#000000', foreground: '#ffffff' }, scrollback: 1000,
    links: { activate: (_event, uri) => events.push(`activate ${uri}`), hover: uri => events.push(`hover ${uri}`), leave: () => events.push('leave') },
  });
  const { terminal, search } = created;
  const inner = created.inner as unknown as { viewportY: number; linkDetector: { providers: unknown[] }; selectionManager: { copyToClipboard(text: string): Promise<void> } };
  terminal.attachCustomKeyEventHandler(event => handleTerminalKey(event, { composing: false, blocked: false, canInput: true, input: data => terminal.input(data, true) }));
  terminal.open(host);
  terminal.onData(data => sent.push(data));
  const result: Record<string, unknown> = { cols: terminal.cols, rows: terminal.rows };

  for (let index = 0; index < 200; index += 1) await write(terminal, `line ${index}\r\n`);
  result.scrollback = terminal.buffer.active.baseY;
  terminal.scrollLines(-20);
  const before = inner.viewportY;
  await write(terminal, 'more 1\r\nmore 2\r\nmore 3\r\n');
  result.held = { before, after: inner.viewportY };
  terminal.scrollToBottom();
  await write(terminal, 'tail\r\n');
  result.followsAtBottom = inner.viewportY;

  result.providers = inner.linkDetector.providers.length;
  let copied = false;
  const clipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { copied = true; } } });
  await inner.selectionManager.copyToClipboard('x');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  result.copiedOnSelect = copied;

  result.bracketedBefore = terminal.modes.bracketedPasteMode;
  await write(terminal, '\x1b[?2004h');
  result.bracketedAfter = terminal.modes.bracketedPasteMode;
  terminal.paste('pasted');

  result.found = search.findNext('line 150');
  result.selection = terminal.getSelection();
  result.notFound = search.findNext('no such text');

  terminal.textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  terminal.textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
  result.sent = sent.slice();
  terminal.reset();
  result.afterReset = terminal.buffer.active.baseY;
  terminal.dispose();
  return result;
}
(window as unknown as { ghosttyScenario: typeof scenario }).ghosttyScenario = scenario;
