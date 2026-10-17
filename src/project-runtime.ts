import { agentLifecycleText, isAgentPane } from './agent-status';
import type { Pane, PaneState, Workspace, WorkspaceTab } from './types';
import { paneIds } from './workspace';

/** Lifecycle only: PTY output and process liveness cannot establish busy or idle. */
export function runtimePaneLabel(pane: Pane): string {
  if (pane.state === 'running') return pane.kind === 'shell' ? '已開啟' : '已開啟 · 活動未知';
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
  return [...counts].map(([label, count]) => `${label}${count > 1 ? ` ×${count}` : ''}`).join('；') || '狀態未知';
}
export function projectRuntimeSummary(tabs: WorkspaceTab[], panes: Workspace['panes']): string {
  const agents = new Set(tabs.flatMap(tab => paneIds(tab.layout)).flatMap(id => {
    const pane = panes[id];
    return pane && isAgentPane(pane) ? [pane.runtimeId ? `runtime:${pane.runtimeId}` : `pane:${id}`] : [];
  }));
  const attention = new Set(tabs.flatMap(tab => paneIds(tab.layout)).filter(id => panes[id] && ['failed', 'interrupted', 'disconnected'].includes(panes[id].state)).map(id => panes[id].runtimeId ? `runtime:${panes[id].runtimeId}` : `pane:${id}`)).size;
  return `${tabs.length} 分頁 · ${agents.size} Agent${attention ? ` · ${attention} 需注意` : ''}`;
}
