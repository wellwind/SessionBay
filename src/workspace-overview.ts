import { agentNames } from './agents';
import { isAgentObservation, type AgentObservation } from './agent-observation';
import { paneRuntimeStatusText } from './pane-runtime-status';
import type { AgentKind, Pane, PaneState, Project, Workspace } from './types';
import { paneIds } from './workspace';

/** Ordered from most to least in need of the user. */
export const ATTENTION_ORDER = ['input', 'error', 'working', 'idle', 'other', 'ended'] as const;
export type Attention = (typeof ATTENTION_ORDER)[number];
export const ATTENTION_LABELS: Record<Attention, string> = {
  input: '等待輸入', error: '需要處理', working: '工作中', idle: '執行中', other: '準備中', ended: '已結束',
};

export interface OverviewItem {
  paneId: string;
  tabId: string;
  projectId: string | null;
  projectName: string;
  kind: 'shell' | AgentKind;
  kindLabel: string;
  title: string;
  cwd: string;
  state: PaneState;
  statusText: string;
  attention: Attention;
}

const inputObservations = new Set<AgentObservation>([
  'awaitingInput', 'awaitingPermission', 'terminalQuestion', 'terminalPermission', 'terminalAuthentication', 'terminalBlocked',
]);
const workingObservations = new Set<AgentObservation>(['busy', 'retry', 'terminalWorking']);

/** Only lifecycle state and explicit provider/terminal reports; process liveness never implies work. */
export function paneAttention(pane: Pane, observations: string[]): Attention {
  const reported = observations.filter(isAgentObservation);
  if (pane.state === 'running' && reported.some(value => inputObservations.has(value))) return 'input';
  if (['failed', 'interrupted', 'disconnected'].includes(pane.state) ||
    reported.some(value => value === 'terminalError' || value === 'failed')) return 'error';
  if (pane.state === 'exited') return 'ended';
  if (pane.state !== 'running') return 'other';
  return reported.some(value => workingObservations.has(value)) ? 'working' : 'idle';
}

export function overviewItems(
  workspace: Workspace,
  projects: Project[],
  observation: (pane: Pane) => string,
): OverviewItem[] {
  const names = new Map(projects.map(project => [project.id, project.name]));
  const items: OverviewItem[] = [];
  for (const tab of workspace.tabs) {
    for (const id of paneIds(tab.layout)) {
      const pane = workspace.panes[id];
      if (!pane) continue;
      const observed = observation(pane).split('|').filter(Boolean);
      const attention = paneAttention(pane, observed);
      const projectName = pane.projectId === null ? '臨時 Terminal' : names.get(pane.projectId) ?? '僅工作區專案';
      const statusText = observed.map(value => paneRuntimeStatusText(pane, false, value)).find(Boolean) ||
        paneRuntimeStatusText(pane, false, '') || ATTENTION_LABELS[attention];
      items.push({
        paneId: pane.id, tabId: tab.id, projectId: pane.projectId, projectName,
        kind: pane.kind, kindLabel: pane.kind === 'shell' ? 'Shell' : agentNames[pane.kind],
        title: pane.title, cwd: pane.cwd, state: pane.state, statusText, attention,
      });
    }
  }
  return items;
}

export interface OverviewFilter {
  attention: 'all' | 'attention' | 'active' | 'ended';
  projectId: string | null | 'all';
  kind: 'shell' | AgentKind | 'all';
}
export const defaultOverviewFilter: OverviewFilter = { attention: 'all', projectId: 'all', kind: 'all' };

export function filterOverview(items: OverviewItem[], filter: OverviewFilter): OverviewItem[] {
  return items.filter(item =>
    (filter.projectId === 'all' || item.projectId === filter.projectId) &&
    (filter.kind === 'all' || item.kind === filter.kind) &&
    (filter.attention === 'all' ||
      (filter.attention === 'attention' && (item.attention === 'input' || item.attention === 'error')) ||
      (filter.attention === 'active' && item.attention !== 'ended') ||
      (filter.attention === 'ended' && item.attention === 'ended')));
}

export type OverviewSort = 'attention' | 'project';
export function sortOverview(items: OverviewItem[], sort: OverviewSort): OverviewItem[] {
  const rank = (item: OverviewItem) => ATTENTION_ORDER.indexOf(item.attention);
  // Temporary terminals belong to no project and follow every project.
  const byProject = (a: OverviewItem, b: OverviewItem) =>
    Number(a.projectId === null) - Number(b.projectId === null) || a.projectName.localeCompare(b.projectName, 'zh-Hant');
  // Stable sort keeps the workspace tab order within equal keys.
  return [...items].sort((a, b) => sort === 'attention'
    ? rank(a) - rank(b) || byProject(a, b)
    : byProject(a, b) || rank(a) - rank(b));
}
