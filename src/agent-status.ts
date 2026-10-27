import { agentKinds } from './agents';
import type { AgentKind, Pane, PaneState, Workspace } from './types';
import { t } from './i18n';

export interface AgentRuntimeStatus {
  key: string;
  paneId: string;
  runtimeId?: string;
  projectId: string | null;
  kind: AgentKind;
  title: string;
  state: PaneState;
}
export interface AgentStatusCounts {
  opened: number;
  live: number;
  exited: number;
  interrupted: number;
  disconnected: number;
  failed: number;
  unstarted: number;
  pending: number;
}
export interface AgentStatusGroup {
  projectId: string | null;
  agents: AgentRuntimeStatus[];
  counts: AgentStatusCounts;
}
const priority: Record<PaneState, number> = {
  placeholder: 0, starting: 1, running: 2, disconnected: 3, failed: 4, interrupted: 5, exited: 6,
};
export const agentLifecycleLabels: Record<PaneState, string> = {
  placeholder: t('Not started'), starting: t('Starting'), running: t('Process alive'),
  exited: t('Ended'), failed: t('Failed'), disconnected: t('Disconnected'), interrupted: t('Process interrupted'),
};
export function agentLifecycleText(state: PaneState): string {
  return state === 'disconnected' ? t('Disconnected · liveness unknown') : agentLifecycleLabels[state];
}
export function isAgentPane(pane: Pane): pane is Pane & { kind: AgentKind } {
  return agentKinds.some((kind) => kind === pane.kind);
}
export function countAgentStatuses(agents: AgentRuntimeStatus[]): AgentStatusCounts {
  const counts: AgentStatusCounts = { opened: agents.length, live: 0, exited: 0, interrupted: 0, disconnected: 0, failed: 0, unstarted: 0, pending: 0 };
  for (const agent of agents) {
    if (agent.runtimeId && (agent.state === 'running' || agent.state === 'starting')) counts.live++;
    else if (agent.state === 'exited') counts.exited++;
    else if (agent.state === 'interrupted') counts.interrupted++;
    else if (agent.state === 'disconnected') counts.disconnected++;
    else if (agent.state === 'failed') counts.failed++;
    else if (agent.state === 'placeholder') counts.unstarted++;
    else counts.pending++;
  }
  return counts;
}

/** Pure projection of the existing broker-backed workspace; no probes or provider enablement filter. */
export function agentStatusGroups(workspace: Workspace): AgentStatusGroup[] {
  const unique = new Map<string, AgentRuntimeStatus>();
  // Stable ownership even if malformed duplicate views disagree about scope.
  for (const pane of Object.values(workspace.panes).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isAgentPane(pane)) continue;
    const key = pane.runtimeId ? `runtime:${pane.runtimeId}` : `pane:${pane.id}`;
    const existing = unique.get(key);
    if (existing) {
      if (priority[pane.state] > priority[existing.state]) existing.state = pane.state;
    } else unique.set(key, { key, paneId: pane.id, runtimeId: pane.runtimeId,
      projectId: pane.projectId, kind: pane.kind, title: pane.title, state: pane.state });
  }
  const groups = new Map<string | null, AgentRuntimeStatus[]>();
  for (const agent of unique.values()) {
    const agents = groups.get(agent.projectId) ?? [];
    agents.push(agent);
    groups.set(agent.projectId, agents);
  }
  return [...groups].map(([projectId, agents]) => ({ projectId, agents, counts: countAgentStatuses(agents) }));
}
export function agentCountText(counts: AgentStatusCounts): string {
  return t('Open {{opened}} · alive {{live}} · ended {{exited}} · interrupted {{interrupted}}', { ...counts })
    + (counts.disconnected ? t(' · disconnected {{count}}', { count: counts.disconnected }) : '')
    + (counts.failed ? t(' · failed {{count}}', { count: counts.failed }) : '')
    + (counts.unstarted ? t(' · not started {{count}}', { count: counts.unstarted }) : '')
    + (counts.pending ? t(' · pending {{count}}', { count: counts.pending }) : '');
}
