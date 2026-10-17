import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import type { Pane, Settings, Workspace } from './types';
vi.mock('./components/TerminalPane', () => ({ TerminalPane: ({ pane, visible, activityVisible }: { pane: Pane; visible: boolean; activityVisible: boolean }) =>
  <span data-testid={pane.id} data-visible={visible} data-activity-visible={activityVisible} /> }));
it('reads all panes in the viewed tab, including maximized siblings, but not other tabs or history', () => {
  const pane = (id: string): Pane => ({ id, kind: 'codex', title: id, projectId: 'project', cwd: '/synthetic', state: 'running' });
  const workspace: Workspace = { version: 1, panes: { a: pane('a'), b: pane('b'), c: pane('c') }, activeTabByProject: {}, tabs: [
    { id: 'one', projectId: 'project', name: 'One', focusedPaneId: 'a', layout: { kind: 'split', id: 'split', axis: 'horizontal', ratio: .5, first: { kind: 'pane', paneId: 'a' }, second: { kind: 'pane', paneId: 'b' } } },
    { id: 'two', projectId: 'project', name: 'Two', focusedPaneId: 'c', layout: { kind: 'pane', paneId: 'c' } },
  ] };
  const props = { workspace, knownProjectIds: ['project'], activeTabId: 'one', settings: {} as Settings, visible: true, maximizedId: 'a',
    onPatch: vi.fn(), onFocus: vi.fn(), onStart: vi.fn(), onClose: vi.fn(), onMaximize: vi.fn(), onSplit: vi.fn(), onRatio: vi.fn(), onAlreadyOpen: vi.fn() };
  const view = render(<WorkspaceCanvas {...props} />);
  expect(screen.getByTestId('a')).toHaveAttribute('data-activity-visible', 'true');
  expect(screen.getByTestId('b')).toHaveAttribute('data-visible', 'false');
  expect(screen.getByTestId('b')).toHaveAttribute('data-activity-visible', 'true');
  expect(screen.getByTestId('c')).toHaveAttribute('data-activity-visible', 'false');
  view.rerender(<WorkspaceCanvas {...props} visible={false} />);
  for (const id of ['a', 'b', 'c']) expect(screen.getByTestId(id)).toHaveAttribute('data-activity-visible', 'false');
  view.rerender(<WorkspaceCanvas {...props} activeTabId="two" maximizedId={null} />);
  expect(screen.getByTestId('a')).toHaveAttribute('data-activity-visible', 'false');
  expect(screen.getByTestId('b')).toHaveAttribute('data-activity-visible', 'false');
  expect(screen.getByTestId('c')).toHaveAttribute('data-activity-visible', 'true');
});
