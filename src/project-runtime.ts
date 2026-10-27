import { agentLifecycleText, isAgentPane } from './agent-status';
import type { Pane, PaneState, Workspace, WorkspaceTab } from './types';
import { paneIds } from './workspace';
import { t } from './i18n';

/** Lifecycle only: PTY output and process liveness cannot establish busy or idle. */
export function runtimePaneLabel(pane: Pane): string {
  if (pane.state === 'running') return t('Open');
  return agentLifecycleText(pane.state);
}
export function tabRuntimeSummary(tab: WorkspaceTab, panes: Workspace['panes']): string {
  const counts = new Map<string, number>();
  const unique = new Map<string, Pane>();
  const priority: Record<PaneState, number> = { placeholder: 0, starting: 1, running: 2, disconnected: 3, failed: 4, interrupted: 5, exited: 6 };
  for (const id of paneIds(tab.layout)) {
    const pane = panes[id];
    if (!pane) continue;
    const key = pane.runtimeId ? `runtime:${pane.runtimeId}` : `pane:${id}`;
    const previous = unique.get(key);
    if (!previous || priority[pane.state] > priority[previous.state]) unique.set(key, pane);
  }
  for (const pane of unique.values()) {
    const label = runtimePaneLabel(pane);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}${count > 1 ? ` ×${count}` : ''}`).join(t('; ')) || t('Status unknown');
}
export function projectRuntimeSummary(tabs: WorkspaceTab[], panes: Workspace['panes']): string {
  const agents = new Set(tabs.flatMap(tab => paneIds(tab.layout)).flatMap(id => {
    const pane = panes[id];
    return pane && isAgentPane(pane) ? [pane.runtimeId ? `runtime:${pane.runtimeId}` : `pane:${id}`] : [];
  }));
  const attention = new Set(tabs.flatMap(tab => paneIds(tab.layout)).filter(id => panes[id] && ['failed', 'interrupted', 'disconnected'].includes(panes[id].state)).map(id => panes[id].runtimeId ? `runtime:${panes[id].runtimeId}` : `pane:${id}`)).size;
  return t('{{tabs}} tabs · {{agents}} agents', { tabs: tabs.length, agents: agents.size }) + (attention ? t(' · {{count}} need attention', { count: attention }) : '');
}
/** Live work for a project: unique runtimes (split panes share one) that are starting or running. */
export function projectOpenCount(tabs: WorkspaceTab[], panes: Workspace['panes']): number {
  const open = new Set<string>();
  for (const id of tabs.flatMap(tab => paneIds(tab.layout))) {
    const pane = panes[id];
    if (pane && (pane.state === 'running' || pane.state === 'starting')) open.add(pane.runtimeId ? `runtime:${pane.runtimeId}` : `pane:${id}`);
  }
  return open.size;
}
/** Project card count label: history and live work are separate facts. */
export function projectCountLabel(historyCount: number, openCount: number): string {
  return t('History {{history}} · Open {{open}}', { history: historyCount, open: openCount });
}
