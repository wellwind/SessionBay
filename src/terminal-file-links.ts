import type { ILinkProvider, Terminal } from '@xterm/xterm';

export interface TerminalFileTarget { path: string; line?: number; column?: number }
export interface TerminalFileOpen { text: string; autoResolve: boolean; confirmAbsolute?: boolean }
const LIMIT = 4096;
const MAX_POSITION = 2147483647;
const hasControl = (text: string) => Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(char));
const namedFiles = /^(?:readme|license|makefile|dockerfile|containerfile|justfile)$/i;
function unwrap(value: string): string {
  let text = value.trim();
  while ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('[') && text.endsWith(']')) ||
    (text.startsWith('<') && text.endsWith('>'))) text = text.slice(1, -1);
  while (/[.,]$/.test(text)) text = text.slice(0, -1);
  // Diagnostic punctuation is not part of an unbalanced filename.
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1);
  }
  return text;
}
export function parseTerminalFileTarget(value: string): TerminalFileTarget {
  if (!value || value.length > LIMIT || hasControl(value)) throw new Error('請輸入單一檔案路徑，最多 4,096 字元。');
  let text = unwrap(value);
  const quoted = /^(["'`])([^\r\n]+)\1((?::\d+){0,2})$/.exec(text);
  if (quoted) text = quoted[2] + quoted[3];
  if (/["`$;|&<>]/.test(text) || /^[a-z]:(?![\\/])/i.test(text))
    throw new Error('只接受檔案路徑，不開啟命令或磁碟相對路徑。');
  const position = /:(\d+)(?::(\d+))?$/.exec(text);
  let line: number | undefined, column: number | undefined;
  if (position) {
    line = Number(position[1]); column = position[2] === undefined ? undefined : Number(position[2]);
    if (![line, column ?? 1].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_POSITION))
      throw new Error('行與欄必須是 1 到 2,147,483,647 的整數。');
    text = text.slice(0, position.index);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text))
    throw new Error('不開啟網址或任意協定。');
  if (!text || text.includes(':') && !/^[a-z]:[\\/][^:]+$/i.test(text) || text.startsWith('~') ||
    /^(?:\\|\/\/)/.test(text) || text.split(/[\\/]/).includes('..'))
    throw new Error('不支援網址、上層目錄、家目錄縮寫、UNC 或裝置路徑。');
  return { path: text, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}
export interface TerminalFileMatch { start: number; end: number; text: string }
/** Bounded lexical detection, never a shell parser or filesystem probe. */
export function terminalFileMatches(text: string): TerminalFileMatch[] {
  if (text.length > LIMIT) return [];
  const result: TerminalFileMatch[] = [];
  let index = 0;
  while (index < text.length && result.length < 32) {
    while (index < text.length && /\s/.test(text[index])) index++;
    const start = index;
    // Permit diagnostic wrappers before a quoted path.
    while (['(', '['].includes(text[index])) index++;
    const quote = text[index];
    if (['"', "'", '`'].includes(quote)) {
      const end = text.indexOf(quote, index + 1);
      if (end < 0) break;
      index = end + 1;
      while (index < text.length && !/\s/.test(text[index])) index++;
    } else {
      while (index < text.length && !/\s/.test(text[index])) index++;
    }
    if (index === start) break;
    const raw = text.slice(start, index);
    try {
      const target = parseTerminalFileTarget(raw);
      const name = target.path.replaceAll('\\', '/').split('/').pop() ?? '';
      if (!/[\\/]/.test(target.path) && !name.includes('.') && !namedFiles.test(name)) continue;
      if (/^(?:www\.)/i.test(target.path) || !name || name === '.') continue;
      result.push({ start, end: index, text: raw });
    } catch { /* Ambiguous tokens remain ordinary selectable text. */ }
  }
  return result;
}
export function fileLinkModifier(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac = /Mac|iPhone|iPad/.test(navigator.platform)): boolean {
  return !event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
export function embeddedLinkLabel(target: string): string {
  const label = Array.from(target.slice(0, LIMIT)).map(char => hasControl(char) ? '�' : char).join('');
  return target.length > LIMIT ? label.slice(0, LIMIT - 24) + '…（目標過長，已截斷）' : label;
}
export function terminalFileLinkProvider(terminal: Terminal, context: () => string, open: (request: TerminalFileOpen) => void,
  tooltip: (text: string) => void, active: () => boolean): ILinkProvider {
  return { provideLinks(y, done) {
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(y - 1);
    // Do not guess partial/wrapped names, or depend on private OSC8 attributes.
    if (!line || line.length > 320 || line.isWrapped || buffer.getLine(y)?.isWrapped) { done(undefined); return; }
    let text = '';
    const cells: { start: number; end: number; blocked: boolean }[] = [];
    for (let x = 0; x < Math.min(line.length, 320); x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let offset = 0; offset < chars.length; offset++) cells.push({ start: x + 1, end: x + cell.getWidth(), blocked: !!cell.isUnderline() || !!cell.isInvisible() });
      text += chars;
    }
    const captured = context();
    const original = line.translateToString(false);
    // OSC8 cells are underlined in xterm 6. Skip any intersecting candidate,
    // even a partial/single-cell embedded link that the built-in provider omits.
    // Plain SGR underline is conservatively reserved for manual path input too.
    done(terminalFileMatches(text).filter(match => !cells.slice(match.start, match.end).some(cell => cell.blocked)).map(match => ({
      text: match.text,
      range: { start: { x: cells[match.start].start, y }, end: { x: cells[match.end - 1].end, y } },
      activate: event => {
        if (event.button !== 0 || !fileLinkModifier(event) || !active() || context() !== captured) return;
        const current = terminal.buffer.active.getLine(y - 1);
        if (!current || current.isWrapped || terminal.buffer.active.getLine(y)?.isWrapped || current.translateToString(false) !== original) return;
        for (let x = cells[match.start].start - 1; x < cells[match.end - 1].end; x++) {
          const cell = current.getCell(x);
          if (!cell || cell.isUnderline() || cell.isInvisible()) return;
        }
        event.preventDefault();
        const target = parseTerminalFileTarget(match.text);
        const quoted = /^[([]?["'`]/.test(match.text);
        const literal = target.path + (target.line === undefined ? '' : `:${target.line}`) + (target.column === undefined ? '' : `:${target.column}`);
        const uncertainBoundary = !quoted && (target.line === undefined && text.trim() !== match.text || literal !== match.text);
        open({ text: match.text, autoResolve: true, ...(uncertainBoundary ? { confirmAbsolute: true } : {}) });
      },
      hover: () => tooltip(`${/Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+點選開啟專案檔案：${match.text}`),
      leave: () => tooltip(''),
    })));
  } };
}
