import { describe, expect, it } from 'vitest';
import {
  closePane,
  emptyWorkspace,
  layoutRects,
  localDayBound,
  paneIds,
  restoreWorkspace,
  serializeWorkspace,
  setRatio,
  splitNode,
} from './workspace';
import {
  matchesShortcut,
  normalizedShortcut,
  shortcutConflicts,
  shortcutDefaults,
} from './commands';
import { TerminalInputQueue } from './terminal-queue';
import type { Pane, Workspace } from './types';
const pane = (id: string): Pane => ({
  id,
  kind: 'shell',
  title: 'Terminal',
  cwd: '/tmp',
  projectId: 'project',
  state: 'running',
  runtimeId: 'live-id',
  startToken: 12,
});
const workspace = (): Workspace => ({
  version: 1,
  panes: { a: pane('a'), b: pane('b'), c: pane('c') },
  tabs: [
    {
      id: 'tab',
      projectId: 'project',
      name: 'Work',
      focusedPaneId: 'a',
      layout: {
        kind: 'split',
        id: 'split',
        axis: 'horizontal',
        ratio: 0.4,
        first: { kind: 'pane', paneId: 'a' },
        second: { kind: 'pane', paneId: 'b' },
      },
    },
    {
      id: 'second',
      projectId: 'project',
      name: 'Other',
      focusedPaneId: 'c',
      layout: { kind: 'pane', paneId: 'c' },
    },
  ],
  activeTabByProject: { project: 'tab' },
});
describe('workspace layout', () => {
  it('keeps independent pane leaves when adding nested splits', () => {
    const node = splitNode(workspace().tabs[0].layout, 'b', 'c', 'vertical', 'nested');
    expect(paneIds(node)).toEqual(['a', 'b', 'c']);
    const geometry = layoutRects(node);
    expect(geometry.panes.a).toEqual({ left: 0, top: 0, width: 40, height: 100 });
    expect(geometry.panes.c).toEqual({ left: 40, top: 50, width: 60, height: 50 });
    expect(geometry.dividers).toHaveLength(2);
  });
  it('clamps split ratios and preserves descendants', () => {
    const node = setRatio(workspace().tabs[0].layout, 'split', 10);
    expect(node.kind === 'split' && node.ratio).toBe(0.85);
    expect(paneIds(node)).toEqual(['a', 'b']);
  });
  it('closing a pane collapses its split and chooses remaining focus', () => {
    const next = closePane(workspace(), 'a');
    expect(next.tabs[0].layout).toEqual({ kind: 'pane', paneId: 'b' });
    expect(next.tabs[0].focusedPaneId).toBe('b');
    expect(next.panes.a).toBeUndefined();
    expect(next.panes.c.runtimeId).toBe('live-id');
  });
  it('closing the last tab pane falls back to another tab and then clears active map', () => {
    let w = closePane(closePane(workspace(), 'a'), 'b');
    expect(w.activeTabByProject.project).toBe('second');
    w = closePane(w, 'c');
    expect(w.tabs).toHaveLength(0);
    expect(w.activeTabByProject.project).toBeUndefined();
  });
  it('serialization drops all runtime identities and start tokens', () => {
    const text = JSON.stringify(serializeWorkspace(workspace()));
    expect(text).not.toContain('runtimeId');
    expect(text).not.toContain('startToken');
    expect(text).not.toContain('live-id');
    expect(text).toContain('placeholder');
  });
  it('restoration always requires explicit start and never restores runtime fields', () => {
    const result = restoreWorkspace(workspace());
    expect(result.panes.a).toMatchObject({ state: 'placeholder', cwd: '/tmp' });
    expect(result.panes.a.runtimeId).toBeUndefined();
    expect(result.panes.a.startToken).toBeUndefined();
    expect(result.tabs).toHaveLength(2);
  });
  it.each([null, 'bad', { version: 2 }, { version: 1, tabs: [], panes: null }])(
    'rejects malformed or unsupported saved workspace %j',
    (value) => {
      expect(restoreWorkspace(value)).toEqual(emptyWorkspace());
    },
  );
  it('rejects unbounded workspaces', () => {
    const value = workspace();
    value.tabs = Array.from({ length: 81 }, () => value.tabs[0]);
    expect(restoreWorkspace(value)).toEqual(emptyWorkspace());
  });
  it('repairs duplicate leaves, lost focus and out-of-range ratios', () => {
    const value = workspace();
    value.tabs[0].focusedPaneId = 'missing';
    value.tabs[0].layout = {
      kind: 'split',
      id: 'split',
      axis: 'horizontal',
      ratio: -7,
      first: { kind: 'pane', paneId: 'a' },
      second: { kind: 'pane', paneId: 'a' },
    };
    const result = restoreWorkspace(value);
    expect(result.tabs[0].focusedPaneId).toBe('a');
    expect(paneIds(result.tabs[0].layout)).toEqual(['a']);
    expect(result.panes.b).toBeUndefined();
  });
  it('does not allow a project to restore another project pane', () => {
    const value = workspace();
    value.panes.a.projectId = 'foreign';
    expect(restoreWorkspace(value).panes.a).toBeUndefined();
  });
  it('builds local day date boundaries and rejects empty or invalid input', () => {
    expect(localDayBound('')).toBeUndefined();
    expect(localDayBound('not-date')).toBeUndefined();
    expect(new Date(localDayBound('2026-10-15')!).getHours()).toBe(0);
    expect(new Date(localDayBound('2026-10-15', true)!).getHours()).toBe(23);
    expect(new Date(localDayBound('2026-10-15', true)!).getMilliseconds()).toBe(999);
  });
});
describe('shared command registry', () => {
  it('has no default shortcut conflicts', () =>
    expect(shortcutConflicts(shortcutDefaults).size).toBe(0));
  it('matches Mod on the correct OS and does not consume plain terminal keys', () => {
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true }),
        'Mod+Shift+T',
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'T', metaKey: true, shiftKey: true }),
        'Mod+Shift+T',
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 't', ctrlKey: true }),
        'Mod+Shift+T',
        false,
      ),
    ).toBe(false);
  });
  it('supports aliases and US shifted punctuation', () => {
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', {
          key: '}',
          code: 'BracketRight',
          ctrlKey: true,
          shiftKey: true,
        }),
        'Mod+Shift+]',
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'Escape', altKey: true }),
        'Option+Esc',
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }),
        'Command+Return',
        true,
      ),
    ).toBe(true);
  });
  it('canonicalizes platform specific aliases without conflating Ctrl and Cmd', () => {
    expect(normalizedShortcut('Mod+Shift+T', false)).toBe(
      normalizedShortcut('Control+T+Shift', false),
    );
    expect(normalizedShortcut('Mod+Shift+T', true)).toBe(
      normalizedShortcut('Command+Shift+T', true),
    );
    expect(normalizedShortcut('Ctrl+T', true)).not.toBe(normalizedShortcut('Cmd+T', true));
  });
});
describe('bounded terminal input queue', () => {
  it('serializes calls and preserves runtime identity across a restart', async () => {
    const calls: string[] = [];
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const queue = new TerminalInputQueue(
      async (id, data) => {
        calls.push(`${id}:${data}`);
        if (data === 'a') await first;
      },
      () => {},
    );
    queue.enqueue('old', 'a');
    queue.enqueue('old', 'b');
    queue.enqueue('new', 'c');
    await Promise.resolve();
    expect(calls).toEqual(['old:a']);
    resolveFirst();
    await queue.drained();
    expect(calls).toEqual(['old:a', 'old:b', 'new:c']);
    expect(queue.pending).toBe(0);
  });
  it('bounds UTF-8 bytes and recovers after a rejected write', async () => {
    const errors: unknown[] = [];
    const queue = new TerminalInputQueue(
      async () => {
        throw new Error('closed');
      },
      (error) => errors.push(error),
      5,
    );
    expect(queue.enqueue('r', '中')).toBe(true);
    expect(queue.enqueue('r', '文')).toBe(false);
    expect(queue.pending).toBe(3);
    await queue.drained();
    expect(queue.pending).toBe(0);
    expect(errors).toHaveLength(2);
    expect(queue.enqueue('r', 'ok')).toBe(true);
    await queue.drained();
    expect(queue.pending).toBe(0);
  });
});
