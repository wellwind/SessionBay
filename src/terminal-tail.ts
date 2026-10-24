// Bounded, read-only text previews of mounted terminals for the overview grid.
// Readers consult the live xterm buffer on demand; no output is copied or stored.
export const TAIL_LINES = 6;
export const TAIL_LINE_CHARS = 160;

type TailReader = (lines: number) => string[];
const readers = new Map<string, TailReader>();

export function registerTerminalTail(paneId: string, reader: TailReader): () => void {
  readers.set(paneId, reader);
  return () => { if (readers.get(paneId) === reader) readers.delete(paneId); };
}

export function readTerminalTail(paneId: string, lines = TAIL_LINES): string[] {
  try { return readers.get(paneId)?.(lines) ?? []; } catch { return []; }
}

/** Minimal view of xterm's buffer API, so the reader is testable without a DOM terminal. */
export interface TailBuffer {
  baseY: number;
  cursorY: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/** Last non-empty lines up to the cursor row, each capped to TAIL_LINE_CHARS. */
export function bufferTail(buffer: TailBuffer, lines: number): string[] {
  const tail: string[] = [];
  // Stop after a bounded number of rows even when the screen is mostly blank.
  const last = buffer.baseY + buffer.cursorY;
  for (let y = last; y >= 0 && y > last - lines * 4 && tail.length < lines; y -= 1) {
    const text = buffer.getLine(y)?.translateToString(true) ?? '';
    if (!text.trim() && tail.length === 0) continue;
    tail.unshift(text.length > TAIL_LINE_CHARS ? `${text.slice(0, TAIL_LINE_CHARS - 1)}…` : text);
  }
  while (tail.length && !tail[0].trim()) tail.shift();
  return tail;
}
