import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSidebarPreferences, readSidebarPreferences, reconcileProjectOrder, reorderProject, saveSidebarPreferences, sidebarStorageKey } from './sidebar-preferences';
import config from '../src-tauri/tauri.conf.json';
import type { Project } from './types';
const project = (id: string, pinned = false): Project => ({ id, name: id, pinned, curated: true, exists: true, path: '/synthetic/' + id, launchPath: null, sessionCount: 0, updatedAt: null, agents: [] });
beforeEach(() => localStorage.clear());
describe('sidebar preferences', () => {
  it('enables frontend HTML5 sorting in the native WebView on Windows', () => {
    expect(config.app.windows.find(window => window.label === 'main')?.dragDropEnabled).toBe(false);
  });
  it('migrates legacy pins once, then appends new projects without losing absent positions', () => {
    const order = reconcileProjectOrder([], [project('a'), project('z', true), project('b')]);
    expect(order).toEqual(['z', 'a', 'b']);
    const next = reorderProject(order, 'b', 'z', false);
    expect(reconcileProjectOrder(next, [project('a'), project('z'), project('c', true)])).toEqual(['b', 'z', 'a', 'c']);
    expect(reconcileProjectOrder(next, [project('a')])).toBe(next);
  });
  it('reorders relative to a filtered target while preserving hidden projects', () => {
    expect(reorderProject(['a', 'hidden', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'hidden', 'b']);
    const order = ['a', 'b'];
    expect(reorderProject(order, 'a', 'missing', false)).toBe(order);
    expect(reorderProject(order, 'a', 'a', true)).toBe(order);
  });
  it('round trips independent collapse states and order without touching other storage', () => {
    localStorage.setItem('settings', 'untouched');
    const value = { ...defaultSidebarPreferences(), width: 352, projectsCollapsed: true, workspacesCollapsed: true, projectOrder: ['b', 'a'] };
    saveSidebarPreferences(value); expect(readSidebarPreferences()).toEqual(value);
    expect(localStorage.getItem('settings')).toBe('untouched');
  });
  it('validates stored widths and upgrades older preferences', () => {
    for (const [width, expected] of [[null, 236], ['300', 236], [-2, 160], [900, 480], [311.8, 312]] as const) {
      localStorage.setItem(sidebarStorageKey, JSON.stringify({version: 1, width}));
      expect(readSidebarPreferences().width).toBe(expected);
    }
  });
  it('defensively restores malformed data', () => {
    localStorage.setItem(sidebarStorageKey, '{'); expect(readSidebarPreferences()).toEqual(defaultSidebarPreferences());
    localStorage.setItem(sidebarStorageKey, JSON.stringify({ version: 1, projectOrder: ['a', 2, 'a', ''], projectsCollapsed: 'false' }));
    expect(readSidebarPreferences()).toEqual({ ...defaultSidebarPreferences(), projectOrder: ['a'] });
  });
});
