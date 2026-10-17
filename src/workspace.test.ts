import { describe, expect, it } from 'vitest';
import {
  activeWorkspaceTabId,
  selectWorkspaceTab,
  mergeWorkspaceProjects,
  closePane,
  closeSuccessfulExit,
  isSuccessfulAutoCloseExit,
  emptyWorkspace,
  layoutRects,
  localDayBound,
  paneIds,
  patchWorkspacePane,
  restoreWorkspace,
  reconcileRuntimes,
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
import type { Pane, RuntimeRecord, Workspace } from './types';
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
describe('retained shell exits', () => {
  it.each(['starting', 'running'] as const)('retains a completed %s shell pane and preserves its split sibling', (state) => {
    const previous = workspace();
    previous.panes.a.state = state;
    const next = patchWorkspacePane(previous, 'a', { state: 'exited', exitCode: 0 });
    expect(next.panes.a).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(next.tabs[0]).toEqual(previous.tabs[0]);
    expect(next.panes.b).toEqual(previous.panes.b);
    expect(next.panes.c).toEqual(previous.panes.c);
    expect(next.tabs[1]).toEqual(previous.tabs[1]);
    expect(next.activeTabByProject).toEqual(previous.activeTabByProject);
    expect(previous.panes.a).toBeDefined();
  });
  it('retains the last pane and tab after exit', () => {
    const previous = closePane(workspace(), 'a');
    const next = patchWorkspacePane(previous, 'b', { state: 'exited', exitCode: 0 });
    expect(next.tabs).toEqual(previous.tabs);
    expect(next.activeTabByProject).toEqual(previous.activeTabByProject);
    expect(next.panes.b).toMatchObject({ state: 'exited', exitCode: 0 });
  });
  it('keeps the active tab and another project unchanged when a background shell exits', () => {
    const previous = workspace();
    previous.panes.d = { ...pane('d'), projectId: 'other-project' };
    previous.tabs.push({ id: 'foreign-tab', projectId: 'other-project', name: 'Elsewhere', focusedPaneId: 'd', layout: { kind: 'pane', paneId: 'd' } });
    previous.activeTabByProject['other-project'] = 'foreign-tab';
    const next = patchWorkspacePane(previous, 'c', { state: 'exited', exitCode: 0 });
    expect(next.tabs.map((tab) => tab.id)).toEqual(['tab', 'second', 'foreign-tab']);
    expect(next.activeTabByProject).toEqual(previous.activeTabByProject);
    expect(next.panes.a).toEqual(previous.panes.a);
    expect(next.panes.d).toEqual(previous.panes.d);
  });
  it.each([
    { name: 'Codex', pane: { kind: 'codex' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'Claude', pane: { kind: 'claude' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'Grok', pane: { kind: 'grok' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'Antigravity', pane: { kind: 'antigravity' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'nonzero exit', pane: {}, patch: { state: 'exited', exitCode: 7 } },
    { name: 'unknown exit', pane: {}, patch: { state: 'exited', exitCode: null } },
    { name: 'missing exit code', pane: {}, patch: { state: 'exited' } },
    { name: 'restored placeholder', pane: { state: 'placeholder' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'failed shell', pane: { state: 'failed' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'shell with an error', pane: { error: 'PTY failed' }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'previous unsuccessful exit', pane: { state: 'exited', exitCode: 1 }, patch: { state: 'exited', exitCode: 0 } },
    { name: 'failure event', pane: {}, patch: { state: 'failed', error: 'PTY failed' } },
  ] satisfies { name: string; pane: Partial<Pane>; patch: Partial<Pane> }[])('retains $name for inspection', ({ pane: overrides, patch }) => {
    const previous = workspace();
    previous.panes.a = { ...previous.panes.a, ...overrides };
    const next = patchWorkspacePane(previous, 'a', patch);
    expect(next.panes.a).toEqual({ ...previous.panes.a, ...patch });
    expect(next.tabs).toEqual(previous.tabs);
    expect(next.activeTabByProject).toEqual(previous.activeTabByProject);
  });
  it('does not resurrect an already removed pane after duplicate exits or late runtime responses', () => {
    const closed = closePane(workspace(), 'a');
    expect(patchWorkspacePane(closed, 'a', { state: 'exited', exitCode: 0 })).toBe(closed);
    expect(patchWorkspacePane(closed, 'a', { runtimeId: 'late-runtime' })).toBe(closed);
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


describe('additional agent workspace persistence', () => {
  it.each(['grok', 'antigravity', 'opencode'] as const)('round-trips a %s conversation ID without its runtime or automatic start token', (kind) => {
    const saved = workspace();
    saved.panes.a = { ...saved.panes.a, kind, resumeId: 'synthetic-conversation' };
    const serialized = serializeWorkspace(saved) as Workspace;
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(serialized)));
    expect(serialized.panes.a).toMatchObject({ kind, resumeId: 'synthetic-conversation', state: 'placeholder' });
    expect(restored.panes.a).toMatchObject({ kind, resumeId: 'synthetic-conversation', state: 'placeholder' });
    expect(restored.panes.a.runtimeId).toBeUndefined();
    expect(restored.panes.a.startToken).toBeUndefined();
    expect(restored.panes.a.sessionId).toBeUndefined();
    expect(restored.tabs).toEqual(saved.tabs);
  });
  it.each([42, {}, ['synthetic'], 'x'.repeat(1025)])('discards malformed or oversized resume metadata without losing the pane: %j', (resumeId) => {
    const saved = workspace();
    saved.panes.a = { ...saved.panes.a, kind: 'grok', resumeId: resumeId as string };
    const restored = restoreWorkspace(saved);
    expect(restored.panes.a).toMatchObject({ kind: 'grok', state: 'placeholder' });
    expect(restored.panes.a.resumeId).toBeUndefined();
  });
});

describe('authoritative broker reconciliation', () => {
  const record = (patch: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
    id: 'broker-id', paneId: 'a', kind: 'shell', projectId: 'project', profileId: null,
    resumeId: null, sessionId: null, cwd: '/broker/path', state: 'running', exitCode: null, ...patch,
  });
  it('uses broker identities and metadata while preserving saved split geometry', () => {
    const saved = restoreWorkspace(workspace());
    const next = reconcileRuntimes(saved, [record()]);
    expect(next.tabs).toEqual(saved.tabs);
    expect(next.panes.a).toMatchObject({ runtimeId: 'broker-id', state: 'running', cwd: '/broker/path' });
    expect(next.panes.a.startToken).toBeUndefined();
    expect(next.panes.b.runtimeId).toBeUndefined();
    expect(next.panes.b.state).toBe('placeholder');
    expect(JSON.stringify(serializeWorkspace(next))).not.toMatch(/broker-id|runtimeId|startToken/);
  });
  it('recovers orphan panes with no saved workspace or catalog project', () => {
    const next = reconcileRuntimes(emptyWorkspace(), [record({ projectId: null })]);
    expect(next.panes.a).toMatchObject({ projectId: null, runtimeId: 'broker-id' });
    expect(next.tabs).toHaveLength(1);
    expect(paneIds(next.tabs[0].layout)).toEqual(['a']);
    expect(next.activeTemporaryTabId).toBe(next.tabs[0].id);
    expect(next.activeTabByProject).toEqual({});
    expect(mergeWorkspaceProjects([], next)).toEqual([]);
  });
  it('moves a mismatched saved pane to the authoritative project without removing its siblings', () => {
    const next = reconcileRuntimes(restoreWorkspace(workspace()), [record({ projectId: 'correct-project' })]);
    expect(next.panes.a.projectId).toBe('correct-project');
    expect(paneIds(next.tabs[0].layout)).toEqual(['b']);
    expect(next.tabs.find((tab) => tab.projectId === 'correct-project')?.focusedPaneId).toBe('a');
  });
  it.each(['exited', 'failed', 'interrupted'])('keeps %s records for inspection without a start token', (state) => {
    const next = reconcileRuntimes(emptyWorkspace(), [record({ state, exitCode: state === 'exited' ? 0 : null })]);
    expect(next.panes.a.state).toBe(state);
    expect(next.panes.a.startToken).toBeUndefined();
    if (state === 'interrupted') expect(next.panes.a.error).toContain('背景程序已中斷');
  });
  it('does not duplicate tabs when reapplying the same authoritative records', () => {
    const first = reconcileRuntimes(emptyWorkspace(), [record()]);
    expect(reconcileRuntimes(first, [record(), record()])).toEqual(first);
  });
});

it('discards unsent input when its attachment is cancelled, including reuse of the same runtime ID', async () => {
  const sent: string[] = [];
  let finish!: () => void;
  const queue = new TerminalInputQueue(async (_id, data) => {
    sent.push(data);
    if (data === 'sent') await new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  queue.enqueue('runtime', 'sent');
  queue.enqueue('runtime', 'stale');
  await Promise.resolve();
  queue.cancel();
  queue.enqueue('runtime', 'new attachment');
  finish();
  await queue.drained();
  expect(sent).toEqual(['sent', 'new attachment']);
  expect(queue.pending).toBe(0);
});


describe('global temporary terminal workspace', () => {
  const temporary = (): Workspace => {
    const w = workspace();
    w.panes.a.projectId = null;
    w.panes.a.homeDirectory = true;
    w.panes.b.projectId = null;
    w.tabs[0].projectId = null;
    w.activeTemporaryTabId = w.tabs[0].id;
    w.activeTabByProject.project = 'second';
    return w;
  };
  it('round-trips null scope without manufacturing catalog or workspace-only projects', () => {
    const restored = restoreWorkspace(serializeWorkspace(temporary()));
    expect(restored.tabs[0].projectId).toBeNull();
    expect(restored.panes.a.projectId).toBeNull();
    expect(restored.panes.a.homeDirectory).toBe(true);
    expect(restored.activeTemporaryTabId).toBe('tab');
    expect(restored.activeTabByProject).toEqual({ project: 'second' });
    expect(mergeWorkspaceProjects([], { ...restored, tabs: [restored.tabs[0]] })).toEqual([]);
    expect(JSON.stringify(restored)).not.toContain('recovered-');
  });
  it('keeps global and project selection independent, and closes only requested panes', () => {
    const w = temporary();
    w.tabs.push({ id: 'temporary-two', projectId: null, name: 'Terminal 2', focusedPaneId: 'd', layout: { kind: 'pane', paneId: 'd' } });
    w.panes.d = { ...pane('d'), projectId: null };
    const selected = selectWorkspaceTab(w, w.tabs[2]);
    expect(activeWorkspaceTabId(selected, null)).toBe('temporary-two');
    expect(activeWorkspaceTabId(selected, 'project')).toBe('second');
    expect(activeWorkspaceTabId(selected, undefined)).toBeUndefined();
    const closed = closePane(selected, 'd');
    expect(closed.activeTemporaryTabId).toBe('tab');
    expect(closed.panes.c.runtimeId).toBe('live-id');
    expect(closed.activeTabByProject).toEqual({ project: 'second' });
    expect(closePane(closePane(closed, 'a'), 'b').activeTemporaryTabId).toBeUndefined();
  });
  it('does not accept a saved global tab that embeds project-owned panes', () => {
    const w = temporary();
    w.tabs[0].layout = { kind: 'pane', paneId: 'c' };
    const restored = restoreWorkspace(w);
    expect(restored.tabs.some((tab) => tab.projectId === null)).toBe(false);
    expect(restored.panes.c.projectId).toBe('project');
  });
  it('uses authoritative null identity even when a saved pane claims a project', () => {
    const next = reconcileRuntimes(workspace(), [{ id: 'runtime-global', paneId: 'a', kind: 'shell',
      projectId: null, profileId: 'default', resumeId: null, sessionId: null,
      cwd: '/trusted/home', state: 'running', exitCode: null }]);
    expect(next.panes.a).toMatchObject({ projectId: null, cwd: '/trusted/home', runtimeId: 'runtime-global' });
    expect(next.panes.b.projectId).toBe('project');
    expect(next.tabs.find((tab) => tab.projectId === null)?.focusedPaneId).toBe('a');
    expect(next.panes.a.startToken).toBeUndefined();
    expect(mergeWorkspaceProjects([], { ...next, tabs: next.tabs.filter((tab) => tab.projectId === null) })).toEqual([]);
  });
});

it('takes home launch policy only from the broker when restoring a live global runtime', () => {
  const next = reconcileRuntimes(emptyWorkspace(), [{ id: 'home-runtime', paneId: 'home-pane', kind: 'shell',
    projectId: null, profileId: null, sessionId: null, resumeId: null, cwd: '/trusted/home',
    state: 'running', exitCode: null, homeDirectory: true }]);
  expect(next.panes['home-pane'].homeDirectory).toBe(true);
  expect(restoreWorkspace(serializeWorkspace(next)).panes['home-pane'].homeDirectory).toBe(true);
});

describe('completed Shell cleanup identity', () => {
  const exited = (): Pane => ({ ...pane('a'), runtimeId: 'old', state: 'exited', exitCode: 0 });
  it('closes the split pane and transfers focus after broker cleanup', () => {
    const value = workspace();
    value.panes.a = exited();
    const next = closeSuccessfulExit(value, value.panes.a);
    expect(paneIds(next.tabs[0].layout)).toEqual(['b']);
    expect(next.tabs[0].focusedPaneId).toBe('b');
    expect(next.panes.b).toEqual(value.panes.b);
    expect(next.tabs[1]).toEqual(value.tabs[1]);
  });
  it.each([
    { runtimeId: 'replacement' }, { startToken: 2 }, { state: 'running' },
    { state: 'disconnected' }, { state: 'failed' }, { error: 'PTY error' },
    { exitCode: null }, { kind: 'codex' },
  ] satisfies Partial<Pane>[])('ignores stale cleanup after $state $runtimeId $startToken', patch => {
    const value = workspace();
    value.panes.a = { ...exited(), ...patch };
    expect(closeSuccessfulExit(value, exited())).toBe(value);
  });
  it('ignores missing runtime IDs and saved placeholders', () => {
    expect(isSuccessfulAutoCloseExit({ ...exited(), runtimeId: undefined })).toBe(false);
    expect(isSuccessfulAutoCloseExit({ ...exited(), state: 'placeholder' })).toBe(false);
    expect(closeSuccessfulExit(closePane(workspace(), 'a'), exited()).panes.a).toBeUndefined();
  });
});

it('preserves legacy home policy only for the same broker-confirmed runtime identity', () => {
  const record: RuntimeRecord = { id: 'home-runtime', paneId: 'home-pane', kind: 'shell',
    projectId: null, profileId: 'chosen', sessionId: null, resumeId: null, cwd: '/trusted/home',
    state: 'running', exitCode: null };
  const live = reconcileRuntimes(emptyWorkspace(), [{ ...record, homeDirectory: true }]);
  const saved = restoreWorkspace(serializeWorkspace(live));
  expect(saved.panes['home-pane'].runtimeId).toBeUndefined();
  expect(saved.panes['home-pane'].startToken).toBeUndefined();
  expect(saved.panes['home-pane'].homePolicyRuntimeId).toBe(record.id);
  const recovered = reconcileRuntimes(saved, [record]);
  expect(recovered.panes['home-pane'].homeDirectory).toBe(true);
  expect(recovered.panes['home-pane'].runtimeId).toBe(record.id);
  expect(reconcileRuntimes(saved, [{ ...record, id: 'replacement' }]).panes['home-pane'].homeDirectory).toBe(false);
  expect(reconcileRuntimes(saved, [{ ...record, homeDirectory: false }]).panes['home-pane'].homeDirectory).toBe(false);
  expect(reconcileRuntimes(saved, [{ ...record, projectId: 'other-project' }]).panes['home-pane'].homeDirectory).toBe(false);
  expect(reconcileRuntimes(saved, [{ ...record, sessionId: 'other-session' }]).panes['home-pane'].homeDirectory).toBe(false);
  expect(reconcileRuntimes(saved, [{ ...record, resumeId: 'other-resume' }]).panes['home-pane'].homeDirectory).toBe(false);
  expect(reconcileRuntimes(emptyWorkspace(), [record]).panes['home-pane'].homeDirectory).toBe(false);
  // A saved comparison token alone never adopts or starts a process.
  expect(reconcileRuntimes(saved, []).panes['home-pane'].runtimeId).toBeUndefined();
  expect(reconcileRuntimes(saved, []).panes['home-pane'].state).toBe('placeholder');
});


it('uses only current broker launch provenance and does not persist auto-close authority', () => {
  const record: RuntimeRecord = { id: 'resume-runtime', paneId: 'resume-pane', kind: 'codex',
    projectId: null, profileId: null, sessionId: 'indexed-id', resumeId: null, cwd: '/synthetic',
    state: 'exited', exitCode: 0, resumedLaunch: true };
  const next = reconcileRuntimes(emptyWorkspace(), [record]);
  expect(isSuccessfulAutoCloseExit(next.panes['resume-pane'])).toBe(true);
  const saved = restoreWorkspace(serializeWorkspace(next));
  expect(saved.panes['resume-pane'].resumedLaunch).toBeUndefined();
  expect(isSuccessfulAutoCloseExit(saved.panes['resume-pane'])).toBe(false);
  const legacy = reconcileRuntimes(next, [{ ...record, resumedLaunch: undefined }]);
  expect(isSuccessfulAutoCloseExit(legacy.panes['resume-pane'])).toBe(false);
});

it.each([{ runtimeId: 'replacement' }, { startToken: 2 }, { resumedLaunch: false }])('does not close a replaced resumed launch: %j', patch => {
  const value = workspace();
  const exited: Pane = { ...value.panes.a, kind: 'codex', resumedLaunch: true, runtimeId: 'old', state: 'exited', exitCode: 0 };
  value.panes.a = { ...exited, ...patch };
  expect(closeSuccessfulExit(value, exited)).toBe(value);
});
