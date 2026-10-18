import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTING_RECENCY_MS, OUTPUT_RECENCY_MS, RuntimeActivityStore } from './runtime-activity';
import { RuntimeActivityIndicator, RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import type { Pane, WorkspaceTab } from './types';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const pane: Pane = { id: 'p', kind: 'codex', title: 'Agent', projectId: 'project', cwd: '/synthetic', state: 'running', runtimeId: 'r' };
const tab: WorkspaceTab = { id: 't', projectId: 'project', name: 'Work', focusedPaneId: 'p', layout: { kind: 'pane', paneId: 'p' } };
describe('bounded output activity metadata', () => {
  it('throttles burst notifications without storing output and decays without implying idle', () => {
    const store = new RuntimeActivityStore(), listener = vi.fn(); store.subscribe(listener);
    store.begin('p', 'lease', 'r', false); store.ready('p', 'lease');
    for (let sequence = 0; sequence < 10000; sequence++) store.output('p', 'lease', 'r', sequence);
    expect(listener).not.toHaveBeenCalled(); expect(store.snapshot(['p'])).toBe('110');
    vi.advanceTimersByTime(100); expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OUTPUT_RECENCY_MS + 100);
    expect(store.snapshot(['p'])).toBe('010'); expect(listener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0); store.dispose();
  });
  it('ignores wrong runtime, old leases, duplicate sequence, ended and closed panes', () => {
    const store = new RuntimeActivityStore(); store.begin('p', 'old', 'r', false, false);
    store.begin('p', 'new', 'r2', false, false);
    store.output('p', 'old', 'r', 20); store.output('p', 'new', 'r', 21);
    expect(store.snapshot(['p'])).toBe('000');
    store.output('p', 'new', 'r2', 3); store.visible('p', true);
    vi.advanceTimersByTime(OUTPUT_RECENCY_MS + 100);
    store.visible('p', false); store.output('p', 'new', 'r2', 3);
    expect(store.snapshot(['p'])).toBe('000');
    store.end('p', 'new'); store.output('p', 'new', 'r2', 4);
    expect(store.snapshot(['p'])).toBe('000');
    store.remove('p', 'old'); store.begin('p', 'last', 'r3', false, false);
    store.remove('p', 'new'); store.output('p', 'last', 'r3', 1);
    expect(store.snapshot(['p'])).toBe('110');
    store.remove('p', 'last'); store.output('p', 'last', 'r3', 2);
    expect(store.snapshot(['p'])).toBe('000'); store.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('tracks only unseen output: other tabs, history, project selection and background windows', () => {
    const store = new RuntimeActivityStore(); store.begin('p', 'l', 'r', true, false);
    store.output('p', 'l', 'r', 1); expect(store.snapshot(['p'])).toBe('100');
    store.visible('p', false); store.output('p', 'l', 'r', 2); expect(store.snapshot(['p'])).toBe('110');
    store.visible('p', true); expect(store.snapshot(['p'])).toBe('100');
    store.setForeground(false); store.output('p', 'l', 'r', 3); expect(store.snapshot(['p'])).toBe('110');
    store.visible('p', true); expect(store.snapshot(['p'])).toBe('110');
    store.setForeground(true); expect(store.snapshot(['p'])).toBe('100');
    store.begin('other', 'other-lease', 'other-runtime', false, false);
    store.output('other', 'other-lease', 'other-runtime', 1);
    expect(store.snapshot(['p', 'other'])).toBe('110'); store.dispose();
  });
  it('bounds connecting animation and never labels a snapshot as fresh output', () => {
    const store = new RuntimeActivityStore(); store.begin('p', 'l', undefined, false);
    expect(store.snapshot(['p'])).toBe('001');
    expect(store.bind('p', 'l', 'r')).toBe(true); expect(store.bind('p', 'l', 'wrong')).toBe(false);
    store.ready('p', 'l'); expect(store.snapshot(['p'])).toBe('000');
    store.begin('p', 'retry', 'r', false);
    vi.advanceTimersByTime(CONNECTING_RECENCY_MS + 100); expect(store.snapshot(['p'])).toBe('000'); store.dispose();
  });
  it('updates only the subscribed indicator during output bursts and survives Strict Mode', async () => {
    let store: RuntimeActivityStore | null = null;
    const parentRender = vi.fn();
    function Producer() {
      store = useRuntimeActivity();
      useEffect(() => { store!.begin('p', 'l', 'r', false, false); return () => store!.remove('p', 'l'); }, []);
      return null;
    }
    function Harness() { parentRender(); return <RuntimeActivityProvider><Producer /><RuntimeActivityIndicator tab={tab} panes={{ p: pane }} /></RuntimeActivityProvider>; }
    const view = render(<StrictMode><Harness /></StrictMode>);
    const before = parentRender.mock.calls.length;
    await act(async () => { await Promise.resolve(); });
    act(() => { for (let i = 0; i < 1000; i++) store!.output('p', 'l', 'r', i); vi.advanceTimersByTime(100); });
    expect(screen.getByRole('img')).toHaveAttribute('title', expect.stringContaining('有新輸出'));
    expect(parentRender).toHaveBeenCalledTimes(before);
    act(() => { vi.advanceTimersByTime(OUTPUT_RECENCY_MS + 100); });
    expect(screen.getByRole('img')).toHaveAttribute('title', expect.stringContaining('未讀輸出'));
    expect(screen.getByRole('img')).not.toHaveAttribute('title', expect.stringContaining('有新輸出'));
    view.unmount(); await act(async () => { await Promise.resolve(); }); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses real foreground and visibility events without marking hidden windows as read', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let store: RuntimeActivityStore | null = null;
    function Producer() {
      store = useRuntimeActivity();
      useEffect(() => { store!.begin('p', 'l', 'r', true, false); return () => store!.remove('p', 'l'); }, []);
      return null;
    }
    const view = render(<RuntimeActivityProvider><Producer /></RuntimeActivityProvider>);
    store!.output('p', 'l', 'r', 1); expect(store!.snapshot(['p'])).toBe('100');
    fireEvent.blur(window); store!.output('p', 'l', 'r', 2); expect(store!.snapshot(['p'])).toBe('110');
    visibility.mockReturnValue('hidden'); fireEvent.focus(window); expect(store!.snapshot(['p'])).toBe('110');
    visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange'));
    expect(store!.snapshot(['p'])).toBe('100');
    view.unmount(); await act(async () => { await Promise.resolve(); }); expect(vi.getTimerCount()).toBe(0);
  });

});

it('hides unknown activity and dormant output dots but retains accessible lifecycle details', () => {
  const view = render(<RuntimeActivityIndicator id="activity-description" tab={tab} panes={{ p: pane }} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(view.container.querySelector('svg, .runtime-output-dot')).toBeNull();
  expect(document.getElementById('activity-description')).toHaveTextContent('已開啟');
  expect(view.container.textContent).not.toContain('活動未知');
  for (const state of ['failed', 'interrupted', 'disconnected', 'exited'] as const) {
    view.rerender(<RuntimeActivityIndicator tab={tab} panes={{ p: { ...pane, state } }} />);
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(view.container.querySelector('.runtime-output-dot')).toBeNull();
  }
});

it('keeps known status before the workspace tab name and preserves its description', async () => {
  const { WorkspaceTabs } = await import('./components/WorkspaceTabs');
  const view = render(<WorkspaceTabs tabs={[tab]} panes={{ p: { ...pane, state: 'exited' } }} onSelect={vi.fn()} onRename={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Work 1' });
  const indicator = screen.getByRole('img');
  const name = view.container.querySelector('.workspace-tab-name')!;
  expect(indicator.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button).toHaveAccessibleDescription(expect.stringContaining('已結束'));
});


it('unknown descriptions preserve the visible tab name and its accessible name', async () => {
  const { WorkspaceTabs } = await import('./components/WorkspaceTabs');
  render(<WorkspaceTabs tabs={[tab]} panes={{ p: pane }} onSelect={vi.fn()} onRename={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Work 1' });
  expect(button.querySelector('.workspace-tab-name')).toHaveTextContent(/^Work$/);
  expect(button).toHaveAccessibleDescription(expect.stringContaining('已開啟'));
});
