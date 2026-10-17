import { agentKinds } from './agents';
import type { AgentKind, Pane, PaneState, Workspace } from './types';

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
  placeholder: '尚未啟動', starting: '啟動中', running: '程序存活',
  exited: '已結束', failed: '失敗', disconnected: '連線中斷', interrupted: '程序中斷',
};
export function agentLifecycleText(state: PaneState): string {
  return state === 'running' ? '程序存活 · 活動未知'
    : state === 'disconnected' ? '連線中斷 · 存活未知' : agentLifecycleLabels[state];
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
  return `已開啟 ${counts.opened} · 存活 ${counts.live} · 已結束 ${counts.exited} · 中斷 ${counts.interrupted}`
    + (counts.disconnected ? ` · 斷線 ${counts.disconnected}` : '')
    + (counts.failed ? ` · 失敗 ${counts.failed}` : '')
    + (counts.unstarted ? ` · 未啟動 ${counts.unstarted}` : '')
    + (counts.pending ? ` · 待確認 ${counts.pending}` : '');
}
