import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTING_RECENCY_MS, OUTPUT_RECENCY_MS, RuntimeActivityStore } from './runtime-activity';
import { RuntimeActivityIndicator, RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import { isAgentObservation, MAX_OBSERVATION_TTL_MS, type AgentActivityEvent } from './agent-observation';
import type { Pane, WorkspaceTab } from './types';

const event = (patch: Partial<AgentActivityEvent> = {}): AgentActivityEvent => ({
  type: 'agentActivity', runtimeId: 'r', generation: 'g1', revision: 1,
  observation: 'busy', validForMs: 1000, ...patch,
});
const stores: RuntimeActivityStore[] = [];
function setup() {
  const store = new RuntimeActivityStore();
  stores.push(store);
  store.begin('p', 'lease', 'r', true, false);
  return store;
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }));
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe('structured agent observations are independent from terminal output', () => {
  it('accepts only explicit observation names, never prototype properties', () => {
    expect(isAgentObservation('busy')).toBe(true);
    expect(isAgentObservation('turnStopRequested')).toBe(true);
    for (const value of ['unknown', 'toString', 'constructor', '__proto__', '', null, undefined, 1])
      expect(isAgentObservation(value)).toBe(false);
  });

  it('does not manufacture output, unread, connection or idle from a report', () => {
    const store = setup();
    store.visible('p', false);
    store.setForeground(false);
    store.observe('p', 'lease', event());
    expect(store.snapshot(['p'])).toBe('000');
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    vi.advanceTimersByTime(1001);
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(store.snapshot(['p'])).toBe('000');
  });

  it('does not infer a structured observation from terminal output or connection', () => {
    const store = setup();
    store.output('p', 'lease', 'r', 1);
    store.begin('other', 'other-lease', 'r2', true);
    expect(store.snapshot(['p', 'other'])).toBe('101');
    expect(store.agentSnapshot(['p', 'other'])).toBe('');
    vi.advanceTimersByTime(Math.max(OUTPUT_RECENCY_MS, CONNECTING_RECENCY_MS) + 100);
    expect(store.agentSnapshot(['p', 'other'])).toBe('');
  });

  it('uses remaining lifetime without refreshing duplicates, replay or mismatched identities', () => {
    const store = setup();
    store.observe('p', 'lease', event({ revision: 3, validForMs: 300 }));
    vi.advanceTimersByTime(200);
    store.observe('p', 'lease', event({ revision: 3, validForMs: MAX_OBSERVATION_TTL_MS }));
    store.observe('p', 'lease', event({ revision: 2, observation: 'idle' }));
    store.observe('p', 'old', event({ revision: 4, observation: 'idle' }));
    store.observe('p', 'lease', event({ runtimeId: 'other', revision: 4, observation: 'idle' }));
    store.observe('missing', 'lease', event({ revision: 4, observation: 'idle' }));
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    vi.advanceTimersByTime(101);
    expect(store.agentSnapshot(['p'])).toBe('');
    store.observe('p', 'lease', event({ revision: 3 }));
    expect(store.agentSnapshot(['p'])).toBe('');
  });

  it('requires a matching bound runtime and fences callbacks from a replaced lease', () => {
    const store = setup();
    store.begin('p', 'unbound', undefined, true, false);
    store.observe('p', 'unbound', event());
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(store.bind('p', 'unbound', 'r')).toBe(true);
    expect(store.bind('p', 'unbound', 'other')).toBe(false);
    store.observe('p', 'unbound', event());
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    store.begin('p', 'replacement', 'r', true, false);
    store.observe('p', 'unbound', event({ revision: 99 }));
    store.remove('p', 'unbound');
    expect(store.agentSnapshot(['p'])).toBe('');
    store.observe('p', 'replacement', event({ revision: 2, observation: 'idle' }));
    expect(store.agentSnapshot(['p'])).toBe('閒置');
  });

  it('notifies subscribers at a newer shorter lifetime instead of an older report timer', () => {
    const store = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.observe('p', 'lease', event({ validForMs: MAX_OBSERVATION_TTL_MS }));
    vi.advanceTimersByTime(100);
    store.observe('p', 'lease', event({ revision: 2, observation: 'toolPending', validForMs: 300 }));
    vi.advanceTimersByTime(100);
    listener.mockClear();
    vi.advanceTimersByTime(301);
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('lets a short report expire before an existing output timer without clearing output', () => {
    const store = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.output('p', 'lease', 'r', 1);
    vi.advanceTimersByTime(100);
    store.observe('p', 'lease', event({ validForMs: 300 }));
    vi.advanceTimersByTime(100);
    listener.mockClear();
    vi.advanceTimersByTime(301);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(store.snapshot(['p'])).toBe('100');
  });

  it('does not extend later output or connection indicators to a long report lifetime', () => {
    const store = setup();
    store.observe('p', 'lease', event({ validForMs: MAX_OBSERVATION_TTL_MS }));
    vi.advanceTimersByTime(100);
    store.output('p', 'lease', 'r', 1);
    store.begin('other', 'other-lease', 'r2', true);
    expect(store.snapshot(['p', 'other'])).toBe('101');
    vi.advanceTimersByTime(Math.max(OUTPUT_RECENCY_MS, CONNECTING_RECENCY_MS) + 100);
    expect(store.snapshot(['p', 'other'])).toBe('000');
    expect(store.agentSnapshot(['p'])).toBe('工作中');
  });

  it('fences retired generations and preserves the fence after an explicit unknown report', () => {
    const store = setup();
    store.observe('p', 'lease', event());
    store.observe('p', 'lease', event({ generation: 'g2', revision: 0, observation: null, validForMs: 0 }));
    store.observe('p', 'lease', event({ revision: 100, observation: 'idle' }));
    expect(store.agentSnapshot(['p'])).toBe('');
    store.observe('p', 'lease', event({ generation: 'g2', revision: 1, observation: 'toolPending' }));
    expect(store.agentSnapshot(['p'])).toBe('工具即將執行');
    store.observe('p', 'lease', event({ generation: 'g2', revision: 2, observation: null, validForMs: 0 }));
    store.observe('p', 'lease', event({ generation: 'g2', revision: 1 }));
    expect(store.agentSnapshot(['p'])).toBe('');
  });

  it('clears on end, reattach, removal and disposal and cannot revive an ended lease', () => {
    const store = setup();
    store.observe('p', 'lease', event());
    store.end('p', 'lease');
    store.observe('p', 'lease', event({ generation: 'g2', revision: 99 }));
    expect(store.agentSnapshot(['p'])).toBe('');
    store.begin('p', 'next', 'r', true, false);
    expect(store.agentSnapshot(['p'])).toBe('');
    store.observe('p', 'next', event({ revision: 8, validForMs: 200 }));
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    store.remove('p', 'next');
    store.observe('p', 'next', event({ revision: 9 }));
    expect(store.agentSnapshot(['p'])).toBe('');
    store.dispose();
    store.begin('p', 'disposed', 'r', true, false);
    store.observe('p', 'disposed', event());
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed reports conservatively without forgetting the replay fence', () => {
    const invalid: Partial<AgentActivityEvent>[] = [
      { revision: NaN }, { revision: Infinity }, { revision: -1 }, { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 }, { generation: '' }, { generation: 'g'.repeat(129) },
      { generation: 'bad\nvalue' }, { generation: 'bad\u007fvalue' }, { generation: 'bad\u0085value' },
      { validForMs: MAX_OBSERVATION_TTL_MS + 1 }, { validForMs: -1 }, { validForMs: 0.5 },
      { validForMs: NaN }, { observation: null, validForMs: 1 }, { observation: 'busy', validForMs: 0 },
      { observation: 'madeUp' as 'busy' }, { observation: 'constructor' as 'busy' },
    ];
    for (const patch of invalid) {
      const store = setup();
      store.observe('p', 'lease', event());
      store.observe('p', 'lease', event({ revision: 2, ...patch }));
      expect(store.agentSnapshot(['p'])).toBe('');
      store.observe('p', 'lease', event());
      expect(store.agentSnapshot(['p'])).toBe('');
      store.dispose();
    }
  });

  it('bounds generation memory and stays unknown after overflow until a new attachment', () => {
    const store = setup();
    for (let i = 0; i < 32; i++) store.observe('p', 'lease', event({ generation: `g${i}` }));
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    store.observe('p', 'lease', event({ generation: 'overflow' }));
    store.observe('p', 'lease', event({ generation: 'g31', revision: 99 }));
    store.observe('p', 'lease', event({ generation: 'another' }));
    expect(store.agentSnapshot(['p'])).toBe('');
    store.begin('p', 'new-lease', 'r', true, false);
    store.observe('p', 'new-lease', event({ generation: 'fresh' }));
    expect(store.agentSnapshot(['p'])).toBe('工作中');
  });

  it.each(['2000-01-01', '2099-01-01'])('uses monotonic expiry when the wall clock moves to %s', (date) => {
    const store = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.observe('p', 'lease', event());
    vi.advanceTimersByTime(100);
    listener.mockClear();
    vi.setSystemTime(new Date(date));
    vi.advanceTimersByTime(899);
    expect(store.agentSnapshot(['p'])).toBe('工作中');
    vi.advanceTimersByTime(101);
    expect(store.agentSnapshot(['p'])).toBe('');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('renders recent provider observations, clears the rendered label on expiry and never maps Stop to idle', () => {
    let store: RuntimeActivityStore | null = null;
    const pane: Pane = { id: 'p', kind: 'codex', title: 'Agent', projectId: 'project', cwd: '/synthetic', state: 'running', runtimeId: 'r' };
    const tab: WorkspaceTab = { id: 't', name: 'Work', projectId: 'project', focusedPaneId: 'p', layout: { kind: 'pane', paneId: 'p' } };
    function Producer() {
      store = useRuntimeActivity();
      useEffect(() => { store!.begin('p', 'lease', 'r', true, false); }, []);
      return null;
    }
    const view = render(<RuntimeActivityProvider><Producer /><RuntimeActivityIndicator tab={tab} panes={{ p: pane }} /></RuntimeActivityProvider>);
    expect(screen.queryByRole('img')).toBeNull();
    act(() => {
      store!.observe('p', 'lease', event({ validForMs: MAX_OBSERVATION_TTL_MS }));
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('img')).toHaveAttribute('title', expect.stringContaining('Agent 最近回報：工作中'));
    act(() => {
      store!.observe('p', 'lease', event({ revision: 2, observation: 'turnStopRequested', validForMs: 300 }));
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('img')).toHaveAttribute('title', expect.stringContaining('Agent 最近回報：收到回合停止請求'));
    expect(screen.getByRole('img')).not.toHaveAttribute('title', expect.stringContaining('閒置'));
    expect(view.container.querySelector('.runtime-output-dot, .runtime-connecting')).toBeNull();
    act(() => { vi.advanceTimersByTime(301); });
    expect(screen.queryByRole('img')).toBeNull();
    view.unmount();
    store!.dispose();
  });
});
