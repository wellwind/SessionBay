import { describe, expect, it } from 'vitest';
import { displayNameError, resumedTabName } from './display-name';
import { emptyWorkspace, restoreWorkspace, serializeWorkspace } from './workspace';

describe('default tab names from preview titles', () => {
  it.each([undefined, null, '', ' \n\t ', '\u0000\u007f\u009f'])('falls back for empty title %j', title => {
    expect(resumedTabName(title)).toBeUndefined();
  });
  it('preserves literal display text while replacing forbidden controls', () => {
    const name = resumedTabName('  Fix <script> $(literal)\nnext\u0000line  ');
    expect(name).toBe('Fix <script> $(literal) next line');
    expect(displayNameError(name!)).toBeUndefined();
  });
  it('truncates by Unicode characters and survives workspace serialization/restoration', () => {
    const name = resumedTabName('😀'.repeat(201))!;
    expect(Array.from(name)).toHaveLength(200);
    expect(displayNameError(name)).toBeUndefined();
    const workspace = emptyWorkspace();
    workspace.panes.pane = { id: 'pane', kind: 'codex', title: 'Pane', projectId: 'project', cwd: '/synthetic', state: 'placeholder' };
    workspace.tabs.push({ id: 'tab', name, projectId: 'project', focusedPaneId: 'pane', layout: { kind: 'pane', paneId: 'pane' } });
    workspace.activeTabByProject.project = 'tab';
    expect(restoreWorkspace(serializeWorkspace(workspace)).tabs[0].name).toBe(name);
  });
});
