import type { LayoutNode, Pane, Project, RuntimeRecord, Workspace, WorkspaceTab } from './types';
import { displayNameError } from './display-name';
import { t } from './i18n';

/** Display-only edits never change IDs, layout, runtime identity or start tokens. */
export function renameWorkspaceTab(workspace: Workspace, id: string, value: string): Workspace {
  if (displayNameError(value)) return workspace;
  const name = value.trim();
  if (!workspace.tabs.some((tab) => tab.id === id && tab.name !== name)) return workspace;
  return { ...workspace, tabs: workspace.tabs.map((tab) => tab.id === id ? { ...tab, name } : tab) };
}

/** Reorder within one project, preserving other projects' slots and active/focused IDs. */
export function reorderWorkspaceTab(workspace: Workspace, id: string, targetId: string, after = false): Workspace {
  const source = workspace.tabs.find((tab) => tab.id === id);
  const target = workspace.tabs.find((tab) => tab.id === targetId);
  if (!source || !target || source === target || source.projectId !== target.projectId) return workspace;
  const ordered = workspace.tabs.filter((tab) => tab.projectId === source.projectId && tab.id !== id);
  const position = ordered.findIndex((tab) => tab.id === targetId) + Number(after);
  ordered.splice(position, 0, source);
  let index = 0;
  const tabs = workspace.tabs.map((tab) => tab.projectId === source.projectId ? ordered[index++] : tab);
  return tabs.every((tab, i) => tab === workspace.tabs[i]) ? workspace : { ...workspace, tabs };
}
export const emptyWorkspace = (): Workspace => ({
  version: 1,
  tabs: [],
  panes: {},
  activeTabByProject: {},
});
/** Global tabs have no project identity, including in persisted layouts. */
export function activeWorkspaceTabId(workspace: Workspace, projectId: string | null | undefined): string | undefined {
  return projectId === null ? workspace.activeTemporaryTabId
    : projectId === undefined ? undefined : workspace.activeTabByProject[projectId];
}
export function selectWorkspaceTab(workspace: Workspace, tab: WorkspaceTab): Workspace {
  return tab.projectId === null ? { ...workspace, activeTemporaryTabId: tab.id }
    : { ...workspace, activeTabByProject: { ...workspace.activeTabByProject, [tab.projectId]: tab.id } };
}
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
  return { ...detachPane(workspace, id), panes };
}
/** Remove a pane from every layout but keep its runtime record, so it can be placed elsewhere. */
function detachPane(workspace: Workspace, id: string): Workspace {
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
  const temporaryTabs = tabs.filter((tab) => tab.projectId === null);
  const activeTemporaryTabId = temporaryTabs.some((tab) => tab.id === workspace.activeTemporaryTabId)
    ? workspace.activeTemporaryTabId : temporaryTabs[0]?.id;
  return { ...workspace, tabs, activeTabByProject, activeTemporaryTabId };
}

export const MAX_SPLIT_PANES = 3;
/** Distinct projects shown in a tab, in layout order. */
export function tabProjectIds(tab: WorkspaceTab, panes: Workspace['panes']): (string | null)[] {
  return [...new Set(paneIds(tab.layout).flatMap((id) => panes[id] ? [panes[id].projectId] : []))];
}
function evenRow(ids: string[]): LayoutNode {
  const [first, ...rest] = ids;
  return rest.length === 0 ? { kind: 'pane', paneId: first } : {
    kind: 'split', id: uid(), axis: 'horizontal', ratio: 1 / ids.length,
    first: { kind: 'pane', paneId: first }, second: evenRow(rest),
  };
}
/**
 * Move 2–3 existing panes side by side into a new tab owned by the first pane's
 * project. Runtimes are untouched: panes only change layout position.
 */
export function createSplitTab(workspace: Workspace, ids: string[], name: string): Workspace {
  const unique = [...new Set(ids)];
  if (unique.length < 2 || unique.length > MAX_SPLIT_PANES || unique.some((id) => !workspace.panes[id])) return workspace;
  const detached = unique.reduce(detachPane, workspace);
  const projectIds = new Set(unique.map((id) => workspace.panes[id].projectId));
  const tab: WorkspaceTab = {
    id: uid(), projectId: workspace.panes[unique[0]].projectId, name, layout: evenRow(unique), focusedPaneId: unique[0],
    ...(projectIds.size > 1 ? { mixed: true } : {}),
  };
  return selectWorkspaceTab({ ...detached, tabs: [...detached.tabs, tab] }, tab);
}
/**
 * Move an open pane (any project) beside `targetId`, splitting along `axis`.
 * The runtime is untouched; the tab becomes mixed when projects differ.
 */
export function movePaneIntoSplit(workspace: Workspace, movingId: string, targetId: string, axis: 'horizontal' | 'vertical'): Workspace {
  const moving = workspace.panes[movingId];
  const owner = workspace.tabs.find((tab) => paneIds(tab.layout).includes(targetId));
  if (!moving || movingId === targetId || !owner || paneIds(owner.layout).includes(movingId)) return workspace;
  const detached = detachPane(workspace, movingId);
  const tab = detached.tabs.find((t) => t.id === owner.id);
  if (!tab) return workspace;
  const layout = splitNode(tab.layout, targetId, movingId, axis);
  const projects = new Set([...tabProjectIds(tab, workspace.panes), moving.projectId]);
  const placed: WorkspaceTab = { ...tab, layout, focusedPaneId: movingId, ...(projects.size > 1 || tab.mixed ? { mixed: true } : {}) };
  return selectWorkspaceTab({ ...detached, tabs: detached.tabs.map((t) => t.id === tab.id ? placed : t) }, placed);
}
/** Return a pane from a mixed tab to its own project as a new tab; the mixed tab keeps its place. */
export function movePaneHome(workspace: Workspace, id: string): Workspace {
  const pane = workspace.panes[id];
  const source = workspace.tabs.find((tab) => tab.mixed && paneIds(tab.layout).includes(id));
  if (!pane || !source) return workspace;
  const detached = detachPane(workspace, id);
  const home: WorkspaceTab = { id: uid(), projectId: pane.projectId, name: pane.title, layout: { kind: 'pane', paneId: id }, focusedPaneId: id };
  const tabs = detached.tabs.map((tab) => tab.id === source.id && tab.mixed &&
    tabProjectIds(tab, workspace.panes).every((projectId) => projectId === tab.projectId)
    ? { id: tab.id, projectId: tab.projectId, name: tab.name, layout: tab.layout, focusedPaneId: tab.focusedPaneId } : tab);
  const placed = { ...detached, tabs: [...tabs, home] };
  // Keep the owner's current tab; only adopt the new tab where its project has none.
  return home.projectId === null
    ? (placed.activeTemporaryTabId ? placed : { ...placed, activeTemporaryTabId: home.id })
    : placed.activeTabByProject[home.projectId] ? placed : selectWorkspaceTab(placed, home);
}
/** Apply runtime metadata before asynchronous broker cleanup. */
export function patchWorkspacePane(workspace: Workspace, id: string, patch: Partial<Pane>): Workspace {
  const pane = workspace.panes[id];
  if (!pane) return workspace;
  return { ...workspace, panes: { ...workspace.panes, [id]: { ...pane, ...patch } } };
}

/** Confirmed close completion cannot remove a newer launch in the same pane. */
export function closeConfirmedPane(workspace: Workspace, target: Pane): Workspace {
  const current = workspace.panes[target.id];
  if (!current || current.startToken !== target.startToken ||
    (target.runtimeId && current.runtimeId !== target.runtimeId)) return workspace;
  return closePane(workspace, target.id);
}

/** A successful managed process exit closes its pane, never a nested Shell command. */
export function isSuccessfulAutoCloseExit(pane: Pane): boolean {
  return pane.state === 'exited' && pane.exitCode === 0 &&
    !!pane.runtimeId && !pane.error;
}

/** A delayed forget response must not remove a restarted/replaced pane. */
export function closeSuccessfulExit(workspace: Workspace, exited: Pane): Workspace {
  const current = workspace.panes[exited.id];
  if (!current || !isSuccessfulAutoCloseExit(current) || current.runtimeId !== exited.runtimeId ||
    current.startToken !== exited.startToken) return workspace;
  return closePane(workspace, exited.id);
}

/** Runtime identities come only from the broker, never the saved layout. */
export function reconcileRuntimes(workspace: Workspace, records: RuntimeRecord[]): Workspace {
  let next = workspace;
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.paneId)) continue; // The broker returns the current generation first.
    seen.add(record.paneId);
    const existing = next.panes[record.paneId];
    const projectId = record.projectId ?? null;
    const state = ['starting', 'running', 'exited', 'failed', 'interrupted'].includes(record.state)
      ? record.state as Pane['state'] : 'disconnected';
    const pane: Pane = {
      id: record.paneId, kind: record.kind, projectId, cwd: record.cwd,
      title: existing?.title || (record.kind === 'shell' ? t('Preserved shell') : t('Preserved {{kind}}', { kind: record.kind })),
      sessionId: record.sessionId ?? undefined, providerSessionId: record.providerSessionId, resumeId: record.resumeId ?? undefined,
      profileId: record.profileId ?? undefined,
      homeDirectory: record.kind === 'shell' && projectId === null && !record.sessionId && !record.resumeId &&
        (record.homeDirectory === true || (record.homeDirectory === undefined &&
          existing?.kind === 'shell' && existing.projectId === null && existing.homeDirectory === true &&
          !existing.sessionId && !existing.resumeId &&
          (existing.runtimeId ?? existing.homePolicyRuntimeId) === record.id)),
      runtimeId: record.id, state, exitCode: record.exitCode,
      ...(state === 'interrupted' ? { error: t('The background process was interrupted. Check it, then restart it explicitly.') } : {}),
    };
    if (existing && existing.projectId !== projectId) next = closePane(next, record.paneId);
    const hasTab = next.tabs.some((tab) => paneIds(tab.layout).includes(record.paneId));
    next = { ...next, panes: { ...next.panes, [pane.id]: pane } };
    if (!hasTab) {
      let tabId = `recovered-${record.id}`;
      while (next.tabs.some((tab) => tab.id === tabId)) tabId += '-tab';
      const tab: WorkspaceTab = { id: tabId, projectId, name: pane.title,
        layout: { kind: 'pane', paneId: pane.id }, focusedPaneId: pane.id };
      next = { ...next, tabs: [...next.tabs, tab] };
      if (!activeWorkspaceTabId(next, projectId)) next = selectWorkspaceTab(next, tab);
    }
  }
  return next;
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
          homeDirectory: pane.homeDirectory,
          homePolicyRuntimeId: pane.homeDirectory === true ? pane.runtimeId ?? pane.homePolicyRuntimeId : undefined,
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
      (p.projectId === null || safeString(p.projectId, 256)) &&
      safeString(p.cwd) &&
      safeString(p.title, 512)
    ) {
      panes[id] = {
        id,
        kind: p.kind,
        title: p.title,
        projectId: p.projectId,
        cwd: p.cwd,
        homeDirectory: p.kind === 'shell' && p.projectId === null && p.homeDirectory === true,
        ...(p.kind === 'shell' && p.projectId === null && p.homeDirectory === true && safeString(p.homePolicyRuntimeId, 128)
          ? { homePolicyRuntimeId: p.homePolicyRuntimeId } : {}),
        ...(safeString(p.sessionId, 1024) ? { sessionId: p.sessionId } : {}),
        ...(safeString(p.resumeId, 1024) ? { resumeId: p.resumeId } : {}),
        ...(safeString(p.profileId, 128) ? { profileId: p.profileId } : {}),
        state: 'placeholder',
      };
    }
  // `undefined` accepts panes of any project (mixed tabs only).
  function parseNode(raw: unknown, projectId: string | null | undefined, depth = 0): LayoutNode | null {
    if (!raw || typeof raw !== 'object' || depth > 12) return null;
    const n = raw as LayoutNode;
    if (n.kind === 'pane') {
      if (!panes[n.paneId] || (projectId !== undefined && panes[n.paneId].projectId !== projectId) || used.has(n.paneId))
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
      (t.projectId === null || safeString(t.projectId, 256)) &&
      safeString(t.name, 512)
    ) {
      const mixed = t.mixed === true;
      const layout = parseNode(t.layout, mixed ? undefined : t.projectId);
      if (layout) {
        tabIds.add(t.id);
        const ids = paneIds(layout);
        tabs.push({
          id: t.id,
          projectId: t.projectId,
          name: t.name,
          layout,
          focusedPaneId: ids.includes(t.focusedPaneId) ? t.focusedPaneId : ids[0],
          ...(mixed ? { mixed: true } : {}),
        });
      }
    }
  for (const id of Object.keys(panes)) if (!used.has(id)) delete panes[id];
  const activeTabByProject: Record<string, string> = {};
  for (const t of tabs)
    if (t.projectId !== null && (!activeTabByProject[t.projectId] || source.activeTabByProject?.[t.projectId] === t.id))
      activeTabByProject[t.projectId] = t.id;
  const temporaryTabs = tabs.filter((tab) => tab.projectId === null);
  const activeTemporaryTabId = temporaryTabs.some((tab) => tab.id === source.activeTemporaryTabId)
    ? source.activeTemporaryTabId : temporaryTabs[0]?.id;
  return { version: 1, tabs, panes, activeTabByProject,
    ...(activeTemporaryTabId ? { activeTemporaryTabId } : {}) };
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
    if (tab.projectId === null || present.has(tab.projectId)) continue;
    const panes = paneIds(tab.layout)
      .map((id) => workspace.panes[id])
      .filter(Boolean);
    const previous = known[tab.projectId];
    const cwd = panes.find((pane) => pane.cwd)?.cwd || '';
    result.push({
      id: tab.projectId,
      name: previous?.name || cwd.split(/[\\/]/).filter(Boolean).at(-1) || t('Restored workspace'),
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
