import { beforeEach, describe, expect, it } from 'vitest';
import { hasSeenWelcome, markWelcomeSeen, shouldShowWelcome, welcomeStorageKey } from './welcome';
import { projectCountLabel, projectOpenCount } from './project-runtime';
import type { Pane, WorkspaceTab } from './types';

describe('first-launch welcome flag', () => {
  beforeEach(() => localStorage.removeItem(welcomeStorageKey));
  it('shows the welcome only once, even when onboarding stays incomplete', () => {
    expect(hasSeenWelcome()).toBe(false);
    expect(shouldShowWelcome(false)).toBe(true);
    markWelcomeSeen();
    expect(shouldShowWelcome(false)).toBe(false);
  });
  it('never shows the welcome once onboarding is complete', () => {
    expect(shouldShowWelcome(true)).toBe(false);
  });
});

describe('project card counts', () => {
  it('formats history and open work separately', () => {
    expect(projectCountLabel(0, 1)).toBe('歷史 0 · 開啟中 1');
  });
  it('counts unique starting/running runtimes only', () => {
    const pane = (id: string, state: Pane['state'], runtimeId?: string) => ({ id, state, runtimeId, kind: 'shell' }) as unknown as Pane;
    const panes = { a: pane('a', 'running', 'r1'), b: pane('b', 'running', 'r1'), c: pane('c', 'starting'), d: pane('d', 'exited', 'r2') };
    const tabs = [
      { id: 't1', layout: { kind: 'split', first: { kind: 'pane', paneId: 'a' }, second: { kind: 'pane', paneId: 'b' } } },
      { id: 't2', layout: { kind: 'split', first: { kind: 'pane', paneId: 'c' }, second: { kind: 'pane', paneId: 'd' } } },
    ] as unknown as WorkspaceTab[];
    expect(projectOpenCount(tabs, panes)).toBe(2);
    expect(projectOpenCount([], panes)).toBe(0);
  });
});
