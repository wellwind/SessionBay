// Experimental Ghostty engine: wraps ghostty-web (libghostty-vt compiled to WASM)
// behind the slice of the xterm.js API that TerminalPane uses, and removes
// ghostty-web defaults that conflict with SessionBay's safety rules.
// ghostty-web is pinned to an exact version: this module touches its internals.
import type { ILinkProvider, ITheme, Terminal } from '@xterm/xterm';
import type { Ghostty, ILink, ITerminalOptions, Terminal as GhosttyWebTerminal } from 'ghostty-web';

export type TerminalEngine = 'xterm' | 'ghostty';
export const terminalEngines: readonly TerminalEngine[] = ['xterm', 'ghostty'];
export function normalizeTerminalEngine(value: unknown): TerminalEngine {
  return value === 'ghostty' ? 'ghostty' : 'xterm';
}

type GhosttyModule = typeof import('ghostty-web');
let loading: Promise<{ module: GhosttyModule; ghostty: Ghostty }> | null = null;

/** Load ghostty-web and its WASM once. The bundle stays out of the xterm path. */
export function loadGhostty() {
  loading ??= (async () => {
    const [module, wasm] = await Promise.all([import('ghostty-web'), import('ghostty-web/ghostty-vt.wasm?url')]);
    return { module, ghostty: await module.Ghostty.load(wasm.default) };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** ghostty-web internals this adapter depends on (verified against 0.4.0). */
interface Internals {
  viewportY: number;
  writeInternal(data: string | Uint8Array, callback?: () => void): void;
  getScrollbackLength(): number;
  linkDetector?: { providers: Array<{ provideLinks(y: number, done: (links?: ILink[]) => void): void }>; invalidateCache(): void };
  selectionManager?: {
    copyToClipboard(text: string): Promise<void>;
    selectionStart: { col: number; absoluteRow: number } | null;
    selectionEnd: { col: number; absoluteRow: number } | null;
    requestRender(): void;
  };
  renderer?: { setTheme(theme: ITheme): void; render(...args: unknown[]): void };
  wasmTerm?: { getHyperlinkUri(id: number): string | null; isAlternateScreen(): boolean };
}

export interface EmbeddedLinkHandler {
  activate(event: MouseEvent, uri: string): void;
  hover(uri: string): void;
  leave(): void;
}

interface Disposable { dispose(): void }
type Listener<T> = (listener: (value: T) => void) => Disposable;

export interface GhosttySearch {
  findNext(term: string, options?: { incremental?: boolean }): boolean;
  findPrevious(term: string): boolean;
}

/**
 * Keep a reader's scrollback position while output arrives. ghostty-web 0.4.0
 * snaps every write to the bottom, which makes history unreadable while an
 * agent streams output.
 */
export function holdViewport(inner: Pick<Internals, 'viewportY' | 'getScrollbackLength'>, write: () => void) {
  const held = inner.viewportY;
  const before = inner.getScrollbackLength();
  write();
  if (held <= 0) return;
  const after = inner.getScrollbackLength();
  inner.viewportY = Math.min(after, held + Math.max(0, after - before));
}

/** Map an xterm link provider (1-based rows and columns) onto ghostty-web (0-based). */
export function adaptLinkProvider(provider: ILinkProvider) {
  return {
    provideLinks(y: number, done: (links?: ILink[]) => void) {
      provider.provideLinks(y + 1, links => done(links?.map(link => ({
        text: link.text,
        range: {
          start: { x: link.range.start.x - 1, y: link.range.start.y - 1 },
          end: { x: link.range.end.x - 1, y: link.range.end.y - 1 },
        },
        activate: event => link.activate(event, link.text),
        hover: hovered => hovered ? link.hover?.(new MouseEvent('mousemove'), link.text) : link.leave?.(new MouseEvent('mouseleave'), link.text),
      }))));
    },
  };
}

/** Find the next or previous match of `needle` in buffer rows; rows are absolute. */
export function findInRows(rows: (index: number) => string | undefined, count: number, needle: string,
  from: { row: number; col: number } | null, backwards: boolean) {
  if (!needle || count <= 0) return null;
  const query = needle.toLowerCase();
  const step = backwards ? -1 : 1;
  let row = from ? Math.min(Math.max(from.row, 0), count - 1) : backwards ? count - 1 : 0;
  // The starting row is visited twice: from `from.col` first, then whole after wrapping.
  for (let visited = 0; visited <= count; visited += 1) {
    const text = (rows(row) ?? '').toLowerCase();
    let col: number;
    if (visited === 0 && from) col = backwards ? (from.col > 0 ? text.lastIndexOf(query, from.col - 1) : -1) : text.indexOf(query, from.col);
    else col = backwards ? text.lastIndexOf(query) : text.indexOf(query);
    if (col >= 0) return { row, col, length: needle.length };
    row = (row + step + count) % count;
  }
  return null;
}

/**
 * Build a ghostty-web terminal that TerminalPane can drive like an xterm.js
 * Terminal. Only the members TerminalPane, terminal-fit, terminal-tail,
 * terminal-resize-follow and terminal-file-links use are provided.
 */
export async function createGhosttyTerminal(options: {
  fontSize: number; fontFamily: string; theme: ITheme; scrollback: number; links: EmbeddedLinkHandler;
}) {
  const { module, ghostty } = await loadGhostty();
  const initial: ITerminalOptions = {
    fontSize: options.fontSize, fontFamily: options.fontFamily, theme: options.theme as ITerminalOptions['theme'],
    scrollback: options.scrollback, cursorBlink: true, convertEol: false, ghostty,
  };
  const inner = new module.Terminal(initial);
  const internals = inner as unknown as Internals;
  const fit = new module.FitAddon();
  inner.loadAddon(fit);
  let keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  // xterm: false means "skip default handling". ghostty-web: true means "handled".
  inner.attachCustomKeyEventHandler(event => keyHandler ? !keyHandler(event) : false);
  let searchMatch: { row: number; col: number } | null = null;
  const cleanups: Array<() => void> = [];

  const buffer = {
    get type() { return inner.buffer.active.type; },
    get cursorX() { return inner.buffer.active.cursorX; },
    get cursorY() { return inner.buffer.active.cursorY; },
    get baseY() { return inner.buffer.active.type === 'alternate' ? 0 : internals.getScrollbackLength(); },
    get viewportY() { return Math.max(0, buffer.baseY - Math.floor(internals.viewportY)); },
    get length() { return inner.buffer.active.length; },
    getLine: (y: number) => inner.buffer.active.getLine(y),
  };

  const adapter = {
    get cols() { return inner.cols; },
    get rows() { return inner.rows; },
    get element() { return inner.element; },
    get textarea() { return inner.textarea; },
    buffer: { get active() { return buffer; }, onBufferChange: inner.buffer.onBufferChange as Listener<unknown> },
    modes: { get bracketedPasteMode() { return inner.hasBracketedPaste(); } },
    // ghostty-web 0.4.0 has no OSC 52 clipboard access, so there is nothing to block.
    parser: { registerOscHandler: () => ({ dispose() {} }) },
    options: {
      get fontSize() { return inner.options.fontSize; },
      set fontSize(value: number) { inner.options.fontSize = value; },
      get fontFamily() { return inner.options.fontFamily; },
      set fontFamily(value: string) { inner.options.fontFamily = value; },
      // The WASM palette is fixed at open; the renderer still takes new
      // default colors, cursor and selection without a reset.
      set theme(value: ITheme) { internals.renderer?.setTheme(value); },
    },
    onData: inner.onData as Listener<string>,
    onRender: inner.onRender as Listener<unknown>,
    onScroll: inner.onScroll as Listener<number>,
    onSelectionChange: inner.onSelectionChange as Listener<void>,
    hasSelection: () => inner.hasSelection(),
    getSelection: () => inner.getSelection(),
    scrollToBottom: () => inner.scrollToBottom(),
    scrollLines: (amount: number) => inner.scrollLines(amount),
    focus: () => inner.focus(),
    reset: () => { searchMatch = null; inner.reset(); },
    resize: (cols: number, rows: number) => inner.resize(cols, rows),
    input: (data: string, user?: boolean) => inner.input(data, user),
    paste: (data: string) => inner.paste(data),
    write: (data: string | Uint8Array, callback?: () => void) => inner.write(data, callback),
    loadAddon: () => undefined,
    attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => { keyHandler = handler; },
    registerLinkProvider: (provider: ILinkProvider) => {
      const adapted = adaptLinkProvider(provider);
      internals.linkDetector?.providers.push(adapted);
      internals.linkDetector?.invalidateCache();
      return { dispose() {
        const providers = internals.linkDetector?.providers;
        const index = providers?.indexOf(adapted) ?? -1;
        if (index >= 0) providers!.splice(index, 1);
      } };
    },
    open(parent: HTMLElement) {
      inner.open(parent);
      const write = internals.writeInternal.bind(inner);
      internals.writeInternal = (data, callback) => holdViewport(internals, () => write(data, callback));
      // Selection only copies on an explicit copy, never on mouse-up.
      const selection = internals.selectionManager;
      if (selection) selection.copyToClipboard = async () => undefined;
      const copy = (event: ClipboardEvent) => {
        const text = inner.getSelection();
        if (!text || !event.clipboardData) return;
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      };
      parent.addEventListener('copy', copy);
      cleanups.push(() => parent.removeEventListener('copy', copy));
      // Replace the built-in providers: they open any OSC 8 or plain URL in a
      // new window on Ctrl/Cmd-click. Embedded links only reveal their target.
      const detector = internals.linkDetector;
      if (detector) {
        const osc8 = detector.providers[0];
        detector.providers.length = 0;
        if (osc8) detector.providers.push({
          provideLinks: (y, done) => osc8.provideLinks(y, links => done(links?.map(link => ({
            ...link,
            activate: event => options.links.activate(event, link.text),
            hover: hovered => hovered ? options.links.hover(link.text) : options.links.leave(),
          })))),
        });
        detector.invalidateCache();
      }
    },
    dispose() {
      cleanups.splice(0).forEach(cleanup => cleanup());
      inner.dispose();
    },
  };

  const search: GhosttySearch = {
    findNext: (needle, opts) => find(needle, false, opts?.incremental ?? false),
    findPrevious: needle => find(needle, true, false),
  };
  function find(needle: string, backwards: boolean, incremental: boolean) {
    const count = buffer.length;
    // Incremental search may keep the current match; Next moves past it; Previous moves before it.
    const from = searchMatch && { row: searchMatch.row, col: searchMatch.col + (incremental || backwards ? 0 : 1) };
    const match = findInRows(row => buffer.getLine(row)?.translateToString(true), count, needle, from, backwards);
    const selection = internals.selectionManager;
    searchMatch = match ? { row: match.row, col: match.col } : null;
    if (!match || !selection) { inner.clearSelection(); return false; }
    selection.selectionStart = { col: match.col, absoluteRow: match.row };
    selection.selectionEnd = { col: match.col + match.length - 1, absoluteRow: match.row };
    const scrollback = buffer.baseY;
    // viewportY counts lines above the bottom; put the match on the first row.
    inner.scrollToLine(match.row >= scrollback ? 0 : scrollback - match.row);
    selection.requestRender();
    return true;
  }

  return {
    terminal: adapter as unknown as Terminal,
    fit: fit as { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined },
    search,
    inner: inner as GhosttyWebTerminal,
  };
}
