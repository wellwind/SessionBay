import type { LayoutNode, Pane, Project, Workspace, WorkspaceTab } from './types';
export const emptyWorkspace = (): Workspace => ({
  version: 1,
  tabs: [],
  panes: {},
  activeTabByProject: {},
});
export const uid = () => crypto.randomUUID();
export const paneIds = (node: LayoutNode): string[] =>
  node.kind === 'pane' ? [node.paneId] : [...paneIds(node.first), ...paneIds(node.second)];
export function splitNode(
  node: LayoutNode,
  target: string,
  newId: string,
  axis: 'horizontal' | 'vertical',
  splitId: string = uid(),
): LayoutNode {
  if (node.kind === 'pane')
    return node.paneId === target
      ? {
          kind: 'split',
          id: splitId,
          axis,
          ratio: 0.5,
          first: node,
          second: { kind: 'pane', paneId: newId },
        }
      : node;
  return {
    ...node,
    first: splitNode(node.first, target, newId, axis, splitId),
    second: splitNode(node.second, target, newId, axis, splitId),
  };
}
export function removeNode(node: LayoutNode, target: string): LayoutNode | null {
  if (node.kind === 'pane') return node.paneId === target ? null : node;
  const first = removeNode(node.first, target);
  const second = removeNode(node.second, target);
  return first && second ? { ...node, first, second } : (first ?? second);
}
export function setRatio(node: LayoutNode, id: string, ratio: number): LayoutNode {
  if (node.kind === 'pane') return node;
  return node.id === id
    ? { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) }
    : { ...node, first: setRatio(node.first, id, ratio), second: setRatio(node.second, id, ratio) };
}
export interface Rectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Divider extends Rectangle {
  id: string;
  axis: 'horizontal' | 'vertical';
  bounds: Rectangle;
  ratio: number;
}
export function layoutRects(
  node: LayoutNode,
  bounds: Rectangle = { left: 0, top: 0, width: 100, height: 100 },
): { panes: Record<string, Rectangle>; dividers: Divider[] } {
  if (node.kind === 'pane') return { panes: { [node.paneId]: bounds }, dividers: [] };
  const horizontal = node.axis === 'horizontal';
  const first = {
    ...bounds,
    [horizontal ? 'width' : 'height']: (horizontal ? bounds.width : bounds.height) * node.ratio,
  };
  const second = horizontal
    ? { ...bounds, left: bounds.left + first.width, width: bounds.width - first.width }
    : { ...bounds, top: bounds.top + first.height, height: bounds.height - first.height };
  const a = layoutRects(node.first, first);
  const b = layoutRects(node.second, second);
  return {
    panes: { ...a.panes, ...b.panes },
    dividers: [
      {
        ...bounds,
        id: node.id,
        axis: node.axis,
        ratio: node.ratio,
        bounds,
        ...(horizontal ? { left: second.left, width: 0 } : { top: second.top, height: 0 }),
      },
      ...a.dividers,
      ...b.dividers,
    ],
  };
}
export function closePane(workspace: Workspace, id: string): Workspace {
  const panes = { ...workspace.panes };
  delete panes[id];
  const tabs: WorkspaceTab[] = [];
  for (const tab of workspace.tabs) {
    const layout = removeNode(tab.layout, id);
    if (layout)
      tabs.push({
        ...tab,
        layout,
        focusedPaneId: tab.focusedPaneId === id ? paneIds(layout)[0] : tab.focusedPaneId,
      });
  }
  const activeTabByProject = { ...workspace.activeTabByProject };
  for (const [project, tabId] of Object.entries(activeTabByProject))
    if (!tabs.some((t) => t.id === tabId)) {
      const replacement = tabs.find((t) => t.projectId === project);
      if (replacement) activeTabByProject[project] = replacement.id;
      else delete activeTabByProject[project];
    }
  return { ...workspace, panes, tabs, activeTabByProject };
}
/** A successful shell exit closes only its pane; errors and Agent transcripts stay inspectable. */
export function patchWorkspacePane(workspace: Workspace, id: string, patch: Partial<Pane>): Workspace {
  const pane = workspace.panes[id];
  if (!pane) return workspace;
  if (pane.kind === 'shell' && ['starting', 'running'].includes(pane.state) &&
      patch.state === 'exited' && patch.exitCode === 0 && !pane.error) {
    return closePane(workspace, id);
  }
  return { ...workspace, panes: { ...workspace.panes, [id]: { ...pane, ...patch } } };
}

export function serializeWorkspace(workspace: Workspace): unknown {
  return {
    ...workspace,
    panes: Object.fromEntries(
      Object.entries(workspace.panes).map(([id, pane]) => [
        id,
        {
          id,
          kind: pane.kind,
          title: pane.title,
          projectId: pane.projectId,
          cwd: pane.cwd,
          sessionId: pane.sessionId,
          resumeId: pane.resumeId,
          profileId: pane.profileId,
          state: 'placeholder',
        },
      ]),
    ),
  };
}
/** Restore only trusted shape, never runtime identity, commands, or an auto-start token. */
export function restoreWorkspace(value: unknown): Workspace {
  if (!value || typeof value !== 'object') return emptyWorkspace();
  const source = value as Partial<Workspace>;
  if (
    source.version !== 1 ||
    !Array.isArray(source.tabs) ||
    !source.panes ||
    typeof source.panes !== 'object' ||
    source.tabs.length > 80 ||
    Object.keys(source.panes).length > 160
  )
    return emptyWorkspace();
  const panes: Record<string, Pane> = {};
  const used = new Set<string>();
  const safeString = (v: unknown, max = 4096): v is string =>
    typeof v === 'string' && v.length <= max;
  for (const [id, p] of Object.entries(source.panes))
    if (
      p &&
      safeString(id, 128) &&
      !['__proto__', 'constructor', 'prototype'].includes(id) &&
      p.id === id &&
      ['shell', 'codex', 'claude', 'grok', 'antigravity', 'opencode'].includes(p.kind) &&
      safeString(p.projectId, 256) &&
      safeString(p.cwd) &&
      safeString(p.title, 512)
    ) {
      panes[id] = {
        id,
        kind: p.kind,
        title: p.title,
        projectId: p.projectId,
        cwd: p.cwd,
        ...(safeString(p.sessionId, 1024) ? { sessionId: p.sessionId } : {}),
        ...(safeString(p.resumeId, 1024) ? { resumeId: p.resumeId } : {}),
        ...(safeString(p.profileId, 128) ? { profileId: p.profileId } : {}),
        state: 'placeholder',
      };
    }
  function parseNode(raw: unknown, projectId: string, depth = 0): LayoutNode | null {
    if (!raw || typeof raw !== 'object' || depth > 12) return null;
    const n = raw as LayoutNode;
    if (n.kind === 'pane') {
      if (!panes[n.paneId] || panes[n.paneId].projectId !== projectId || used.has(n.paneId))
        return null;
      used.add(n.paneId);
      return { kind: 'pane', paneId: n.paneId };
    }
    if (
      n.kind !== 'split' ||
      !safeString(n.id, 128) ||
      !['horizontal', 'vertical'].includes(n.axis) ||
      !Number.isFinite(n.ratio)
    )
      return null;
    const first = parseNode(n.first, projectId, depth + 1);
    const second = parseNode(n.second, projectId, depth + 1);
    return first && second
      ? {
          kind: 'split',
          id: n.id,
          axis: n.axis,
          ratio: Math.max(0.15, Math.min(0.85, n.ratio)),
          first,
          second,
        }
      : (first ?? second);
  }
  const tabs: WorkspaceTab[] = [];
  const tabIds = new Set<string>();
  for (const t of source.tabs)
    if (
      t &&
      safeString(t.id, 128) &&
      !tabIds.has(t.id) &&
      safeString(t.projectId, 256) &&
      safeString(t.name, 512)
    ) {
      const layout = parseNode(t.layout, t.projectId);
      if (layout) {
        tabIds.add(t.id);
        const ids = paneIds(layout);
        tabs.push({
          id: t.id,
          projectId: t.projectId,
          name: t.name,
          layout,
          focusedPaneId: ids.includes(t.focusedPaneId) ? t.focusedPaneId : ids[0],
        });
      }
    }
  for (const id of Object.keys(panes)) if (!used.has(id)) delete panes[id];
  const activeTabByProject: Record<string, string> = {};
  for (const t of tabs)
    if (!activeTabByProject[t.projectId] || source.activeTabByProject?.[t.projectId] === t.id)
      activeTabByProject[t.projectId] = t.id;
  return { version: 1, tabs, panes, activeTabByProject };
}
export function localDayBound(value: string, end = false): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (end) {
    date.setDate(date.getDate() + 1);
    date.setMilliseconds(-1);
  }
  return date.toISOString();
}

/** Keep local workspace tabs reachable after their searchable source is removed. */
export function mergeWorkspaceProjects(
  projects: Project[],
  workspace: Workspace,
  known: Record<string, Project> = {},
): Project[] {
  const result = [...projects];
  const present = new Set(projects.map((project) => project.id));
  for (const tab of workspace.tabs) {
    if (present.has(tab.projectId)) continue;
    const panes = paneIds(tab.layout)
      .map((id) => workspace.panes[id])
      .filter(Boolean);
    const previous = known[tab.projectId];
    const cwd = panes.find((pane) => pane.cwd)?.cwd || '';
    result.push({
      id: tab.projectId,
      name: previous?.name || cwd.split(/[\\/]/).filter(Boolean).at(-1) || '已還原工作區',
      path: previous?.path || cwd || null,
      launchPath: previous?.launchPath || null,
      exists: previous?.exists ?? Boolean(cwd),
      pinned: false,
      curated: false,
      sessionCount: 0,
      updatedAt: null,
      agents: [...new Set(panes.flatMap((pane) => (pane.kind === 'shell' ? [] : [pane.kind])))],
      workspaceOnly: true,
    });
    present.add(tab.projectId);
  }
  return result;
}
