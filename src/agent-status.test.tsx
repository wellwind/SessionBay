import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { agentKinds } from './agents';
import { agentCountText, agentStatusGroups, countAgentStatuses } from './agent-status';
import { AgentStatusOverview } from './components/AgentStatusOverview';
import { closePane, emptyWorkspace, patchWorkspacePane, reconcileRuntimes, restoreWorkspace, serializeWorkspace } from './workspace';
import type { Pane, Project, RuntimeRecord, Workspace } from './types';
const pane = (id: string, patch: Partial<Pane> = {}): Pane => ({
  id, kind: 'codex', title: `Agent ${id}`, projectId: 'p', cwd: '/synthetic',
  runtimeId: `r-${id}`, state: 'running', ...patch,
});
const workspace = (...panes: Pane[]): Workspace => ({ ...emptyWorkspace(),
  panes: Object.fromEntries(panes.map((p) => [p.id, p])),
  tabs: panes.map((p) => ({ id: `t-${p.id}`, projectId: p.projectId, name: p.title,
    focusedPaneId: p.id, layout: { kind: 'pane', paneId: p.id } })),
});
const project = (id: string, name: string): Project => ({
  id, name, path: '/synthetic', launchPath: null, exists: true, curated: true, pinned: false,
  agents: ['codex'], sessionCount: 99, updatedAt: null,
});

describe('Agent lifecycle projection', () => {
  it('counts registered Agents, including providers with no enabled sources, never shells or historical sessions', () => {
    const ws = workspace(...agentKinds.map((kind) => pane(kind, { kind })), pane('shell', { kind: 'shell' }));
    const group = agentStatusGroups(ws)[0];
    expect(group.counts).toMatchObject({ opened: agentKinds.length, live: agentKinds.length });
    // Availability, login, provider enablement and history are deliberately not aggregation inputs.
    expect(group.agents.map((agent) => agent.kind)).toEqual([...agentKinds].sort());
  });
  it('deduplicates shared runtime IDs across panes and prefers terminal evidence to a stale live view', () => {
    const a = pane('a');
    const b = pane('b', { runtimeId: a.runtimeId, state: 'exited' });
    const groups = agentStatusGroups(workspace(b, a));
    expect(groups[0].counts).toMatchObject({ opened: 1, live: 0, exited: 1 });
    expect(groups[0].agents[0].paneId).toBe('a');
    expect(agentStatusGroups(workspace(a, b))).toEqual(groups);
  });
  it('keeps placeholders distinct and does not count an unconfirmed launch as live', () => {
    const group = agentStatusGroups(workspace(pane('a', { runtimeId: undefined, state: 'placeholder' }),
      pane('b', { runtimeId: undefined, state: 'placeholder' }), pane('c', { runtimeId: undefined, state: 'starting' })))[0];
    expect(group.counts).toMatchObject({ opened: 3, live: 0, unstarted: 2, pending: 1 });
  });
  it('keeps disconnected, interrupted, failed, and exited distinct; output silence is not an input', () => {
    const group = agentStatusGroups(workspace(pane('a', { state: 'disconnected' }), pane('b', { state: 'interrupted' }),
      pane('c', { state: 'exited' }), pane('d', { state: 'failed' }), pane('e')))[0];
    expect(group.counts).toMatchObject({ opened: 5, live: 1, disconnected: 1, interrupted: 1, exited: 1, failed: 1 });
    expect(agentCountText(group.counts)).toContain('斷線 1');
  });
  it('counts inactive projects and global sessions separately without selection filters', () => {
    const ws = workspace(pane('a'), pane('b', { projectId: 'other' }), pane('c', { projectId: null }),
      pane('shell', { kind: 'shell', projectId: null }));
    expect(agentStatusGroups(ws).map((group) => [group.projectId, group.counts.opened])).toEqual([['p', 1], ['other', 1], [null, 1]]);
  });
  it('projects duplicate lifecycle patches idempotently and changes counts on reconnect, exit and close', () => {
    let ws = workspace(pane('a'));
    for (let i = 0; i < 2; i++) ws = patchWorkspacePane(ws, 'a', { state: 'disconnected' });
    expect(agentStatusGroups(ws)[0].counts).toMatchObject({ opened: 1, live: 0, disconnected: 1, exited: 0 });
    ws = patchWorkspacePane(ws, 'a', { state: 'running' });
    expect(agentStatusGroups(ws)[0].counts.live).toBe(1);
    for (let i = 0; i < 2; i++) ws = patchWorkspacePane(ws, 'a', { state: 'exited', exitCode: 0 });
    expect(agentStatusGroups(ws)[0].counts).toMatchObject({ live: 0, exited: 1 });
    expect(agentStatusGroups(closePane(ws, 'a'))).toEqual([]);
  });
  it('takes bootstrap lifecycle from broker records and never trusts persisted runtime IDs', () => {
    const ws = workspace(pane('a'));
    const saved = restoreWorkspace(serializeWorkspace(ws));
    expect(agentStatusGroups(saved)[0].counts).toMatchObject({ live: 0, unstarted: 1 });
    const record: RuntimeRecord = { id: 'broker-id', paneId: 'a', kind: 'codex', projectId: 'p',
      sessionId: null, resumeId: null, profileId: null, cwd: '/synthetic', state: 'interrupted', exitCode: null };
    const restored = reconcileRuntimes(saved, [record, record]);
    expect(agentStatusGroups(restored)[0].counts).toMatchObject({ opened: 1, live: 0, interrupted: 1 });
  });
  it('uses a deterministic single scope if duplicate runtime views disagree', () => {
    const groups = agentStatusGroups(workspace(pane('b', { projectId: 'other', runtimeId: 'shared' }),
      pane('a', { runtimeId: 'shared' })));
    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe('p');
  });
});

describe('Agent status overview display', () => {
  it('shows project and global summaries and explicit lifecycle rows with focus actions', () => {
    const focus = vi.fn();
    const ws = workspace(pane('a'), pane('b', { projectId: null, state: 'disconnected' }),
      pane('c', { state: 'interrupted' }), pane('shell', { kind: 'shell' }));
    const view = render(<AgentStatusOverview workspace={ws} projects={[project('p', 'Project A'), project('empty', 'Empty project')]} onFocus={focus} />);
    expect(screen.getByText('1 存活 / 3 已開啟')).toBeInTheDocument();
    const p = screen.getByText('Project A').closest('details')!;
    fireEvent.click(within(p).getByText('Project A'));
    expect(within(p).getByText('已開啟 2 · 存活 1 · 已結束 0 · 中斷 1')).toBeInTheDocument();
    expect(within(p).getByText('程序存活')).toBeInTheDocument();
    fireEvent.click(within(p).getByRole('button', { name: /Agent a/ }));
    expect(focus).toHaveBeenCalledWith('a');
    expect(screen.getByText('全域工作階段')).toBeInTheDocument();
    expect(screen.getByText('連線中斷 · 存活未知')).toBeInTheDocument();
    expect(screen.getByText('已開啟 0 · 存活 0 · 已結束 0 · 中斷 0')).toBeInTheDocument();
    expect(view.container.textContent).not.toContain('活動未知');
    expect(view.container.textContent).not.toContain('Agent shell');
    expect(view.container.textContent).not.toContain('99');
    const next = patchWorkspacePane(ws, 'a', { state: 'exited' });
    view.rerender(<AgentStatusOverview workspace={next} projects={[project('p', 'Project A')]} onFocus={focus} />);
    expect(screen.getByText('0 存活 / 3 已開啟')).toBeInTheDocument();
    expect(within(p).getByText('已開啟 2 · 存活 0 · 已結束 1 · 中斷 1')).toBeInTheDocument();
  });
  it('shows unlisted workspace-only project and never merges it into global sessions', () => {
    render(<AgentStatusOverview workspace={workspace(pane('a'))} projects={[]} onFocus={vi.fn()} />);
    expect(screen.getByText('僅工作區專案')).toBeInTheDocument();
    expect(screen.getByText('全域工作階段')).toBeInTheDocument();
    expect(countAgentStatuses([]).opened).toBe(0);
  });
});
