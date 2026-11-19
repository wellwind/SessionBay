import { describe, expect, it, vi } from 'vitest';
import type { ILinkProvider } from '@xterm/xterm';
import { adaptLinkProvider, findInRows, holdViewport, normalizeTerminalEngine } from './ghostty-terminal';

describe('normalizeTerminalEngine', () => {
  it('defaults anything unknown to xterm', () => {
    expect(normalizeTerminalEngine(undefined)).toBe('xterm');
    expect(normalizeTerminalEngine('webgl')).toBe('xterm');
    expect(normalizeTerminalEngine('ghostty')).toBe('ghostty');
  });
});

describe('holdViewport', () => {
  it('keeps a scrolled-back reader on the same text while scrollback grows', () => {
    const term = { viewportY: 5, scrollback: 100, getScrollbackLength() { return this.scrollback; } };
    holdViewport(term, () => { term.scrollback = 103; term.viewportY = 0; });
    expect(term.viewportY).toBe(8);
  });

  it('leaves a reader at the bottom following new output', () => {
    const term = { viewportY: 0, scrollback: 100, getScrollbackLength() { return this.scrollback; } };
    holdViewport(term, () => { term.scrollback = 120; });
    expect(term.viewportY).toBe(0);
  });

  it('clamps to the available scrollback after a reset', () => {
    const term = { viewportY: 50, scrollback: 100, getScrollbackLength() { return this.scrollback; } };
    holdViewport(term, () => { term.scrollback = 10; term.viewportY = 0; });
    expect(term.viewportY).toBe(10);
  });
});

describe('adaptLinkProvider', () => {
  it('converts xterm 1-based ranges to ghostty 0-based ones and forwards hover', () => {
    const activate = vi.fn();
    const hover = vi.fn();
    const leave = vi.fn();
    const provider: ILinkProvider = {
      provideLinks: (y, done) => done([{ text: 'src/a.ts', range: { start: { x: 3, y }, end: { x: 10, y } }, activate, hover, leave }]),
    };
    let links: Parameters<Parameters<ReturnType<typeof adaptLinkProvider>['provideLinks']>[1]>[0];
    adaptLinkProvider(provider).provideLinks(4, result => { links = result; });
    expect(links![0].range).toEqual({ start: { x: 2, y: 4 }, end: { x: 9, y: 4 } });
    links![0].hover!(true);
    links![0].hover!(false);
    links![0].activate(new MouseEvent('click'));
    expect(hover).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), 'src/a.ts');
  });
});

describe('findInRows', () => {
  const rows = ['alpha beta', 'gamma', 'beta beta'];
  const read = (index: number) => rows[index];

  it('finds forward from the start, case-insensitively', () => {
    expect(findInRows(read, rows.length, 'BETA', null, false)).toEqual({ row: 0, col: 6, length: 4 });
  });

  it('moves to the next match and wraps around', () => {
    expect(findInRows(read, rows.length, 'beta', { row: 0, col: 7 }, false)).toEqual({ row: 2, col: 0, length: 4 });
    expect(findInRows(read, rows.length, 'beta', { row: 2, col: 6 }, false)).toEqual({ row: 0, col: 6, length: 4 });
  });

  it('searches backwards before the current match', () => {
    expect(findInRows(read, rows.length, 'beta', { row: 2, col: 5 }, true)).toEqual({ row: 2, col: 0, length: 4 });
    expect(findInRows(read, rows.length, 'beta', { row: 2, col: 0 }, true)).toEqual({ row: 0, col: 6, length: 4 });
  });

  it('returns null without a match or a needle', () => {
    expect(findInRows(read, rows.length, 'delta', null, false)).toBeNull();
    expect(findInRows(read, rows.length, '', null, false)).toBeNull();
  });
});
