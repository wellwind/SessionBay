import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_OBSERVATION_LABELS, type AgentObservation } from './agent-observation';
import { paneRuntimeStatusText } from './pane-runtime-status';
import { RuntimeActivityStore } from './runtime-activity';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import { PaneRuntimeStatus } from './components/PaneRuntimeStatus';
import type { Pane } from './types';

const pane: Pane = { id: 'p', kind: 'codex', title: 'Agent', projectId: null, cwd: '/synthetic', state: 'running', runtimeId: 'r' };
const supported = ['busy', 'idle', 'retry', 'awaitingInput', 'awaitingPermission', 'terminalIdle', 'terminalWorking', 'terminalDone', 'terminalBlocked', 'terminalPermission', 'terminalQuestion', 'terminalAuthentication', 'terminalError'] as const;
describe('pane status text', () => {
  it.each(supported)('labels explicit %s without changing its meaning', observation => {
    expect(paneRuntimeStatusText(pane, false, observation)).toBe(AGENT_OBSERVATION_LABELS[observation]);
  });
  it('hides absent, unknown and event-only observations even with a saved Session', () => {
    const hidden = Object.keys(AGENT_OBSERVATION_LABELS).filter(value => !(supported as readonly string[]).includes(value));
    for (const observation of ['', 'unknown', 'busy|idle', ...hidden]) {
      expect(paneRuntimeStatusText(pane, false, observation)).toBe('');
      expect(paneRuntimeStatusText({ ...pane, sessionId: 'saved' }, false, observation)).toBe('');
    }
    expect(paneRuntimeStatusText({ ...pane, kind: 'shell' }, false, 'busy')).toBe('執行中');
  });
  it.each([
    ['starting', '啟動中…'], ['disconnected', '連線中斷 · 程序狀態待確認'],
    ['interrupted', '背景程序已中斷'], ['failed', '啟動／執行失敗'],
    ['exited', '已退出 · 未知結束碼'], ['placeholder', '已還原布局'],
  ] as const)('prioritizes %s over reported activity', (state, label) => {
    for (const observation of supported) expect(paneRuntimeStatusText({ ...pane, state }, false, observation)).toBe(label);
  });
  it('preserves connecting precedence and actual exit code', () => {
    expect(paneRuntimeStatusText({ ...pane, state: 'starting' }, true, 'busy')).toBe('正在啟動終端…');
    expect(paneRuntimeStatusText({ ...pane, state: 'disconnected' }, true, 'idle')).toBe('正在重新附接終端…');
    expect(paneRuntimeStatusText({ ...pane, state: 'exited', exitCode: 0 }, false, 'terminalDone')).toBe('已退出 · 0');
  });
});

describe('subscribed pane activity', () => {
  let store: RuntimeActivityStore;
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }));
  afterEach(() => vi.useRealTimers());
  function Capture() { store = useRuntimeActivity()!; return null; }
  function Harness({ current = pane }: { current?: Pane }) {
    return <RuntimeActivityProvider><Capture /><PaneRuntimeStatus pane={current} connecting={false} /></RuntimeActivityProvider>;
  }
  const flush = () => vi.advanceTimersByTime(100);
  const observe = (observation: AgentObservation | null, revision: number, validForMs = 1000) => store.observe('p', 'l', {
    type: 'agentActivity', runtimeId: 'r', generation: 'g', revision, observation, validForMs: observation ? validForMs : 0,
  });
  it('renders busy/idle transitions, expires to empty, never infers work from output', () => {
    const view = render(<Harness />);
    act(() => { store.begin('p', 'l', 'r', true, false); store.output('p', 'l', 'r', 1); flush(); });
    expect(view.container).toBeEmptyDOMElement();
    act(() => { observe('busy', 1); flush(); }); expect(view.container).toHaveTextContent(/^工作中$/);
    act(() => { observe('idle', 2); flush(); }); expect(view.container).toHaveTextContent(/^閒置$/);
    act(() => { vi.advanceTimersByTime(1100); }); expect(view.container).toBeEmptyDOMElement();
    act(() => { observe('busy', 3); flush(); }); expect(view.container).toHaveTextContent(/^工作中$/);
    act(() => { observe(null, 4); flush(); }); expect(view.container).toBeEmptyDOMElement();
  });
  it('scopes the label to the exact pane/runtime and clears it on lease changes and revocation', () => {
    const view = render(<Harness />);
    act(() => {
      store.begin('p', 'l', 'r', true, false); observe('busy', 1);
      store.begin('other', 'o', 'other-runtime', false, false);
      store.observe('other', 'o', { type: 'agentActivity', runtimeId: 'other-runtime', generation: 'g', revision: 1, observation: 'idle', validForMs: 1000 });
      flush();
    });
    expect(view.container).toHaveTextContent(/^工作中$/);
    view.rerender(<Harness current={{ ...pane, runtimeId: 'next' }} />); expect(view.container).toBeEmptyDOMElement();
    view.rerender(<Harness />); expect(view.container).toHaveTextContent(/^工作中$/);
    act(() => { store.begin('p', 'new', 'r', true, false); observe('idle', 2); flush(); });
    expect(view.container).toBeEmptyDOMElement();
    act(() => {
      store.observe('p', 'new', { type: 'agentActivity', runtimeId: 'r', generation: 'new', revision: 1, observation: 'busy', validForMs: 1000 }); flush();
    });
    expect(view.container).toHaveTextContent(/^工作中$/);
    act(() => { store.revokeAgent('p'); flush(); }); expect(view.container).toBeEmptyDOMElement();
  });
  it('uses native status lifetime and clears on reset/disconnect, with lifecycle text taking precedence', () => {
    const view = render(<Harness />);
    act(() => {
      store.begin('p', 'l', 'r', true, false);
      store.observeTerminal('p', 'l', { type: 'terminalStatus', runtimeId: 'r', generation: 'native', revision: 1, status: 'authentication' }); flush();
    });
    expect(view.container).toHaveTextContent('等待登入（終端回報）');
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(view.container).toHaveTextContent('等待登入（終端回報）');
    act(() => { store.observeTerminal('p', 'l', { type: 'terminalStatus', runtimeId: 'r', generation: 'native', revision: 2, status: null }); flush(); });
    expect(view.container).toBeEmptyDOMElement();
    act(() => { store.observeTerminal('p', 'l', { type: 'terminalStatus', runtimeId: 'r', generation: 'native', revision: 3, status: 'working' }); flush(); });
    view.rerender(<Harness current={{ ...pane, state: 'disconnected' }} />);
    expect(view.container).toHaveTextContent('連線中斷 · 程序狀態待確認');
    act(() => { store.end('p', 'l'); flush(); });
    view.rerender(<Harness />); expect(view.container).toBeEmptyDOMElement();
  });
  it('survives Strict Mode and releases provider timers after unmount', async () => {
    const view = render(<StrictMode><Harness /></StrictMode>);
    await act(async () => { await Promise.resolve(); });
    act(() => { store.begin('p', 'l', 'r', true, false); observe('busy', 1); flush(); });
    expect(view.container).toHaveTextContent(/^工作中$/);
    view.unmount(); await act(async () => { await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
  });
});
