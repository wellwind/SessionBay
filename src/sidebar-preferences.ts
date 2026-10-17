import type { Project } from './types';

export const sidebarStorageKey = 'sessionbay.sidebar.v1';
export interface SidebarPreferences {
  projectOrder: string[];
  projectsCollapsed: boolean;
  directoriesCollapsed: boolean;
  workspacesCollapsed: boolean;
}
export const defaultSidebarPreferences = (): SidebarPreferences => ({ projectOrder: [], projectsCollapsed: false, directoriesCollapsed: false, workspacesCollapsed: false });
export function readSidebarPreferences(): SidebarPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(sidebarStorageKey) || 'null');
    if (!value || value.version !== 1) return defaultSidebarPreferences();
    return {
      projectOrder: Array.isArray(value.projectOrder) ? [...new Set<string>(value.projectOrder.filter((id: unknown) => typeof id === 'string' && id.length > 0))] : [],
      projectsCollapsed: value.projectsCollapsed === true,
      directoriesCollapsed: value.directoriesCollapsed === true,
      workspacesCollapsed: value.workspacesCollapsed === true,
    };
  } catch { return defaultSidebarPreferences(); }
}
export function saveSidebarPreferences(value: SidebarPreferences): void {
  localStorage.setItem(sidebarStorageKey, JSON.stringify({ version: 1, ...value }));
}
export function legacyProjectOrder(a: Project, b: Project): number {
  return Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
/** Retain absent IDs so removal, index refresh, and rejoining never lose a manual position. */
export function reconcileProjectOrder(order: string[], projects: Project[]): string[] {
  const known = new Set(order);
  const added = projects.filter(p => p.curated && !known.has(p.id)).sort(legacyProjectOrder).map(p => p.id);
  return added.length ? [...order, ...added] : order;
}
export function reorderProject(order: string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const next = order.filter(value => value !== id);
  next.splice(next.indexOf(target) + Number(after), 0, id);
  return next.every((value, index) => value === order[index]) ? order : next;
}
