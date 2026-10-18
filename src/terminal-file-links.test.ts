import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import { embeddedLinkLabel, fileLinkModifier, parseTerminalFileTarget, terminalFileLinkProvider, terminalFileMatches } from './terminal-file-links';

beforeEach(() => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64'); });
describe('literal terminal file references', () => {
  it.each([
    ['src/file.ts:12:3', { path: 'src/file.ts', line: 12, column: 3 }],
    ['file.ts:12', { path: 'file.ts', line: 12 }],
    ['README:2', { path: 'README', line: 2 }],
    ['("src/中文 (test).ts":9:4)', { path: 'src/中文 (test).ts', line: 9, column: 4 }],
    ["'my file.ts':2", { path: 'my file.ts', line: 2 }],
    ['`src/a.ts:3:2`', { path: 'src/a.ts', line: 3, column: 2 }],
    ['(/workspace/src/file.ts:12:3)', { path: '/workspace/src/file.ts', line: 12, column: 3 }],
    ['C:\\work\\file.ts:4:2', { path: 'C:\\work\\file.ts', line: 4, column: 2 }],
    ['file(test).ts:3,', { path: 'file(test).ts', line: 3 }],
    ['.env', { path: '.env' }],
    ['my file.ts', { path: 'my file.ts' }],
  ])('parses %s without shell evaluation', (text, expected) => { expect(parseTerminalFileTarget(text)).toEqual(expected); });
  it.each(['https://host/path.ts:3', 'file:///etc/passwd', 'javascript:alert.ts', 'mailto:file.ts', '../secret.ts',
    'src/../secret.ts', '~/file.ts', 'C:12', '\\\\server\\file.ts', '\\\\?\\C:\\file.ts', '$(touch marker).ts',
    'file.ts;touch marker', 'file.ts|sh', 'file.ts:0', 'file.ts:1:0', 'file.ts:2147483648', 'file.ts:1e3', 'file\n.ts', 'evil\u202efile.ts'])('rejects %s', text => {
    expect(() => parseTerminalFileTarget(text)).toThrow();
  });
  it('detects bounded whole tokens and does not mine file substrings from URLs or broken quotes', () => {
    const text = 'error src/a.ts:2:3 "my file.ts":4 https://host/a.ts:8 file:///tmp/a.ts www.example.com tail';
    expect(terminalFileMatches(text).map(match => match.text)).toEqual(['src/a.ts:2:3', '"my file.ts":4']);
    expect(terminalFileMatches('"unfinished path file.ts')).toEqual([]);
    expect(terminalFileMatches('x'.repeat(4097))).toEqual([]);
    expect(terminalFileMatches(Array(100).fill('a.ts').join(' '))).toHaveLength(32);
  });
  it('requires only the platform modifier and sanitizes embedded targets for plain display', () => {
    const keys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(fileLinkModifier(keys)).toBe(false);
    expect(fileLinkModifier({ ...keys, ctrlKey: true })).toBe(true);
    expect(fileLinkModifier({ ...keys, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(fileLinkModifier({ ...keys, metaKey: true }, true)).toBe(true);
    expect(fileLinkModifier({ ...keys, ctrlKey: true }, true)).toBe(false);
    expect(embeddedLinkLabel('file://\u001b[31m<script>')).toBe('file://�[31m<script>');
  });
});
function line(text: string, wrapped = false) {
  const cells: { getWidth: () => number; getChars: () => string; isUnderline: () => number; isInvisible: () => number }[] = [];
  for (const char of text) {
    const width = /[中😀]/u.test(char) ? 2 : 1;
    cells.push({ getWidth: () => width, getChars: () => char, isUnderline: () => 0, isInvisible: () => 0 });
    if (width === 2) cells.push({ getWidth: () => 0, getChars: () => '', isUnderline: () => 0, isInvisible: () => 0 });
  }
  return { isWrapped: wrapped, length: cells.length, getCell: (x: number) => cells[x], translateToString: () => text };
}
it('maps CJK and surrogate cells, preserves selection clicks and rejects stale context/output', () => {
  let current = line('中😀 src/a.ts:2:3');
  let context = 'pane/runtime/1', active = true;
  const terminal = { buffer: { active: { getLine: (y: number) => y === 0 ? current : undefined } } } as unknown as Terminal;
  const open = vi.fn(), tooltip = vi.fn();
  const provider = terminalFileLinkProvider(terminal, () => context, open, tooltip, () => active);
  let links: ILink[] = [];
  provider.provideLinks(1, result => { links = result ?? []; });
  expect(links).toHaveLength(1);
  expect(links[0].range.start).toEqual({ x: 6, y: 1 });
  links[0].activate(new MouseEvent('click'), links[0].text);
  expect(open).not.toHaveBeenCalled();
  links[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
  expect(open).toHaveBeenCalledExactlyOnceWith({ text: 'src/a.ts:2:3', autoResolve: true });
  open.mockClear(); context = 'other';
  links[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
  context = 'pane/runtime/1'; current = line('changed.ts');
  links[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
  current = line('中😀 src/a.ts:2:3'); active = false;
  links[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
  expect(open).not.toHaveBeenCalled();
});
it('does not guess wrapped or truncated path lines', () => {
  const terminal = { buffer: { active: { getLine: (y: number) => y === 0 ? line('src/file.ts') : line('more', true) } } } as unknown as Terminal;
  const provider = terminalFileLinkProvider(terminal, () => '', vi.fn(), vi.fn(), () => true);
  provider.provideLinks(1, result => expect(result).toBeUndefined());
  provider.provideLinks(2, result => expect(result).toBeUndefined());
});

it('requires confirmation for unquoted absolute text whose boundary is ambiguous', () => {
  const current = line('at /project/file.ts trailing words');
  const terminal = { buffer: { active: { getLine: (y: number) => y === 0 ? current : undefined } } } as unknown as Terminal;
  const open = vi.fn(); const provider = terminalFileLinkProvider(terminal, () => '', open, vi.fn(), () => true);
  provider.provideLinks(1, links => { links![0].activate(new MouseEvent('click', { ctrlKey: true }), links![0].text); });
  expect(open).toHaveBeenCalledExactlyOnceWith({ text: '/project/file.ts', autoResolve: true, confirmAbsolute: true });
  expect(embeddedLinkLabel('x'.repeat(100000)).length).toBeLessThanOrEqual(4096);
  expect(embeddedLinkLabel('x'.repeat(100000))).toContain('目標過長');
});

it('never provides a file candidate that intersects underlined OSC8 or invisible cells', () => {
  for (const attribute of ['isUnderline', 'isInvisible'] as const) {
    const current = line('/project/file.ts');
    current.getCell(current.length - 1)[attribute] = () => 1;
    const terminal = { buffer: { active: { getLine: (y: number) => y === 0 ? current : undefined } } } as unknown as Terminal;
    terminalFileLinkProvider(terminal, () => '', vi.fn(), vi.fn(), () => true).provideLinks(1, links => expect(links).toEqual([]));
  }
});

it('does not expose a path truncated by the provider cell budget', () => {
  const current = line('/project/file.ts' + ' '.repeat(320));
  const terminal = { buffer: { active: { getLine: (y: number) => y === 0 ? current : undefined } } } as unknown as Terminal;
  terminalFileLinkProvider(terminal, () => '', vi.fn(), vi.fn(), () => true).provideLinks(1, result => expect(result).toBeUndefined());
});
