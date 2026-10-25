import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeActivityStore } from './runtime-activity';
import type { AgentObservation } from './agent-observation';
import { AttentionNotifier, attentionNotification } from './components/AttentionNotifier';
import { RuntimeActivityProvider, useRuntimeActivity } from './components/RuntimeActivity';
import type { Pane, Workspace } from './types';

vi.mock('./api', () => ({ isDesktop: () => true, api: { notify: vi.fn(() => Promise.resolve()) } }));
const { api } = await import('./api');

let revision = 0;
const observe = (store: RuntimeActivityStore, observation: AgentObservation | null) =>
  store.observe('p', 'lease', { type: 'agentActivity', runtimeId: 'r', generation: 'g', revision: ++revision,
    observation, validForMs: observation ? 30000 : 0 });

const pane: Pane = { id: 'p', kind: 'claude', title: 'Synthetic task', projectId: 'project', cwd: '/synthetic', state: 'running', runtimeId: 'r' };
const workspace = { version: 1, tabs: [], panes: { p: pane }, activeTabByProject: {} } as Workspace;
const projects = [{ id: 'project', name: 'Synthetic project' }] as never[];

beforeEach(() => { revision = 0; vi.mocked(api.notify).mockClear(); });
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
    observe(store!, 'terminalDone');
    expect(api.notify).toHaveBeenCalledExactlyOnceWith('Claude Code 正在等待你的輸入或確認', 'Synthetic task · Synthetic project');
    view.rerender(<RuntimeActivityProvider><AttentionNotifier enabled={false} workspace={workspace} projects={projects} /><Probe /></RuntimeActivityProvider>);
    expect(store!.onAttention).toBeUndefined();
  });
});
