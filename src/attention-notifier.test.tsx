import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeActivityStore } from './runtime-activity';
import type { AgentObservation } from './agent-observation';
import { AttentionNotifier, attentionNotification } from './components/AttentionNotifier';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import type { Pane, Workspace } from './types';
import { playAttentionSound } from './attention-sound';

vi.mock('./attention-sound', async importOriginal => ({
  ...await importOriginal<typeof import('./attention-sound')>(),
  playAttentionSound: vi.fn(), unlockAttentionAudio: vi.fn(),
}));

vi.mock('./api', () => ({ isDesktop: () => true, api: { notify: vi.fn(() => Promise.resolve()) } }));
const { api } = await import('./api');

let revision = 0;
const observe = (store: RuntimeActivityStore, observation: AgentObservation | null) =>
  store.observe('p', 'lease', { type: 'agentActivity', runtimeId: 'r', generation: 'g', revision: ++revision,
    observation, validForMs: observation ? 30000 : 0 });

const pane: Pane = { id: 'p', kind: 'claude', title: 'Synthetic task', projectId: 'project', cwd: '/synthetic', state: 'running', runtimeId: 'r' };
const workspace = { version: 1, tabs: [], panes: { p: pane }, activeTabByProject: {} } as Workspace;
const projects = [{ id: 'project', name: 'Synthetic project' }] as never[];

beforeEach(() => { revision = 0; vi.mocked(api.notify).mockClear(); vi.mocked(playAttentionSound).mockClear(); });
afterEach(() => vi.useRealTimers());

describe('attention transitions', () => {
  it('fires once per entry into an attention kind while the pane is out of view', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', false);
    observe(store, 'busy');
    observe(store, 'awaitingInput');
    observe(store, 'waitingInput');
    observe(store, null);
    observe(store, 'idle');
    expect(seen.mock.calls).toEqual([['p', 'waiting']]);
    observe(store, 'promptSubmitted');
    observe(store, 'terminalDone');
    observe(store, 'failed');
    expect(seen.mock.calls.slice(1)).toEqual([['p', 'done'], ['p', 'failed']]);
    store.dispose();
  });
  it('raises done once per busy to idle turn, including provider heartbeats', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', false);
    observe(store, 'busy'); observe(store, 'busy');
    observe(store, 'idle'); observe(store, 'idle');
    expect(seen.mock.calls).toEqual([['p', 'done']]);
    observe(store, 'busy'); observe(store, 'idle');
    expect(seen.mock.calls).toEqual([['p', 'done'], ['p', 'done']]);
    expect(store.agentStates(['p'])).toBe('idle');
    store.dispose();
  });
  it('does not infer completion from initial idle, reattachment or terminalIdle', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', false);
    observe(store, 'idle'); observe(store, 'idle');
    observe(store, 'busy'); observe(store, 'terminalIdle');
    observe(store, 'busy');
    store.end('p', 'lease');
    store.begin('p', 'lease', 'r', false);
    observe(store, 'idle');
    store.begin('p', 'lease', 'replacement-runtime', false);
    observe(store, 'busy'); observe(store, 'idle');
    expect(seen).not.toHaveBeenCalled();
    store.dispose();
  });
  it('does not carry a busy turn across provider generations', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', false);
    observe(store, 'busy');
    store.observe('p', 'lease', { type: 'agentActivity', runtimeId: 'r', generation: 'new-session',
      revision: 1, observation: 'idle', validForMs: 30000 });
    expect(seen).not.toHaveBeenCalled();
    store.dispose();
  });
  it.each(['waitingInput', 'waitingPermission', 'permissionRequested'] as const)(
    'raises waiting from the %s hook observation and re-arms after busy', observation => {
      const store = new RuntimeActivityStore(), seen = vi.fn();
      store.onAttention = seen;
      store.begin('p', 'lease', 'r', false);
      observe(store, observation); observe(store, observation);
      expect(seen.mock.calls).toEqual([['p', 'waiting']]);
      observe(store, 'busy'); observe(store, observation);
      expect(seen.mock.calls).toEqual([['p', 'waiting'], ['p', 'waiting']]);
      store.dispose();
    });
  it('gates provider completion by pane visibility and window foreground', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', true);
    observe(store, 'busy'); observe(store, 'idle');
    store.setForeground(false);
    observe(store, 'idle');
    expect(seen).not.toHaveBeenCalled();
    observe(store, 'busy'); observe(store, 'idle');
    store.setForeground(true); store.visible('p', false);
    observe(store, 'busy'); observe(store, 'idle');
    expect(seen.mock.calls).toEqual([['p', 'done'], ['p', 'done']]);
    store.dispose();
  });
  it('stays quiet for a visible pane in a foreground window', () => {
    const store = new RuntimeActivityStore(), seen = vi.fn();
    store.onAttention = seen;
    store.begin('p', 'lease', 'r', true);
    observe(store, 'awaitingPermission');
    expect(seen).not.toHaveBeenCalled();
    store.setForeground(false);
    observe(store, 'busy');
    observe(store, 'awaitingPermission');
    expect(seen).toHaveBeenCalledOnce();
    store.dispose();
  });
});

describe('AttentionNotifier', () => {
  it('names the agent, pane and project', () => {
    expect(attentionNotification('waiting', pane, projects)).toEqual({
      title: 'Claude Code 正在等待你的輸入或確認', body: 'Synthetic task · Synthetic project' });
  });
  it('sends through the desktop API, rate limits a pane and honors the setting', () => {
    let store: RuntimeActivityStore | null = null;
    const Probe = () => { store = useRuntimeActivity(); return null; };
    const view = render(<RuntimeActivityProvider><AttentionNotifier enabled workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>);
    store!.begin('p', 'lease', 'r', false);
    observe(store!, 'awaitingInput');
    observe(store!, 'busy');
    observe(store!, 'idle');
    expect(api.notify).toHaveBeenCalledExactlyOnceWith('Claude Code 正在等待你的輸入或確認', 'Synthetic task · Synthetic project', 'p', false);
    view.rerender(<RuntimeActivityProvider><AttentionNotifier enabled={false} workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>);
    expect(store!.onAttention).toBeUndefined();
  });
  it('delivers provider completion notifications and sounds with the shared cooldown', () => {
    vi.useFakeTimers();
    let store: RuntimeActivityStore | null = null;
    const Probe = () => { store = useRuntimeActivity(); return null; };
    render(<RuntimeActivityProvider><AttentionNotifier enabled soundEnabled workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>);
    store!.begin('p', 'lease', 'r', false);
    observe(store!, 'busy'); observe(store!, 'idle'); observe(store!, 'idle');
    act(() => vi.advanceTimersByTime(1500));
    expect(api.notify).toHaveBeenCalledExactlyOnceWith('Claude Code 已完成', 'Synthetic task · Synthetic project', 'p', true);
    expect(playAttentionSound).toHaveBeenCalledExactlyOnceWith('done', 70, expect.any(Function));
    observe(store!, 'busy'); observe(store!, 'idle');
    act(() => vi.advanceTimersByTime(3500));
    expect(api.notify).toHaveBeenCalledTimes(1);
    observe(store!, 'busy'); observe(store!, 'idle');
    act(() => vi.advanceTimersByTime(1500));
    expect(api.notify).toHaveBeenCalledTimes(2);
    expect(playAttentionSound).toHaveBeenCalledTimes(2);
  });
  it('coalesces different panes by priority and shares the notification cooldown', () => {
    vi.useFakeTimers();
    let store: RuntimeActivityStore | null = null;
    const Probe = () => { store = useRuntimeActivity(); return null; };
    const panes = { ...workspace.panes, q: { ...pane, id: 'q' }, s: { ...pane, id: 's' } };
    render(<RuntimeActivityProvider><AttentionNotifier enabled soundEnabled soundVolume={42} workspace={{ ...workspace, panes }} projects={projects} /><Probe /></RuntimeActivityProvider>);
    act(() => {
      store!.onAttention!('p', 'done');
      store!.onAttention!('q', 'failed');
      store!.onAttention!('s', 'waiting');
      store!.onAttention!('missing', 'waiting');
      vi.advanceTimersByTime(1499);
    });
    expect(api.notify).toHaveBeenCalledTimes(3);
    expect(api.notify).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 's', true);
    expect(playAttentionSound).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(playAttentionSound).toHaveBeenCalledExactlyOnceWith('waiting', 42, expect.any(Function));
    act(() => { store!.onAttention!('p', 'waiting'); vi.advanceTimersByTime(3499); });
    expect(api.notify).toHaveBeenCalledTimes(3);
    act(() => { vi.advanceTimersByTime(1); store!.onAttention!('p', 'failed'); vi.advanceTimersByTime(1500); });
    expect(api.notify).toHaveBeenCalledTimes(4);
    expect(playAttentionSound).toHaveBeenLastCalledWith('failed', 42, expect.any(Function));
  });
  it('plays with notifications off, gates visible foreground work and cancels on disable', () => {
    vi.useFakeTimers();
    let store: RuntimeActivityStore | null = null;
    const Probe = () => { store = useRuntimeActivity(); return null; };
    const contents = (soundEnabled: boolean) => <RuntimeActivityProvider><AttentionNotifier enabled={false} soundEnabled={soundEnabled} workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>;
    const view = render(contents(true));
    store!.setForeground(true);
    store!.begin('p', 'lease', 'r', true);
    observe(store!, 'awaitingInput');
    act(() => vi.advanceTimersByTime(1500));
    expect(playAttentionSound).not.toHaveBeenCalled();
    store!.setForeground(false);
    observe(store!, 'busy'); observe(store!, 'failed');
    act(() => vi.advanceTimersByTime(1500));
    expect(playAttentionSound).toHaveBeenCalledExactlyOnceWith('failed', 70, expect.any(Function));
    expect(api.notify).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5000));
    observe(store!, 'busy'); observe(store!, 'idle');
    view.rerender(contents(false));
    act(() => vi.advanceTimersByTime(1500));
    expect(playAttentionSound).toHaveBeenCalledTimes(1);
    expect(store!.onAttention).toBeUndefined();
  });
  it('cancels queued and in-flight playback on unmount', () => {
    vi.useFakeTimers();
    let store: RuntimeActivityStore | null = null;
    const Probe = () => { store = useRuntimeActivity(); return null; };
    const view = render(<RuntimeActivityProvider><AttentionNotifier enabled={false} soundEnabled workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>);
    store!.onAttention!('p', 'done');
    act(() => vi.advanceTimersByTime(1500));
    const current = vi.mocked(playAttentionSound).mock.calls[0][2]!;
    expect(current()).toBe(true);
    act(() => { vi.advanceTimersByTime(5000); store!.onAttention!('p', 'waiting'); });
    view.unmount();
    act(() => vi.advanceTimersByTime(1500));
    expect(current()).toBe(false);
    expect(playAttentionSound).toHaveBeenCalledTimes(1);
  });
});
