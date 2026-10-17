import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import type { Pane, Settings, Workspace } from './types';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: ({ pane, visible }: { pane: Pane; visible: boolean }) => (
    <section className="terminal-pane" data-testid={pane.id} data-visible={visible} />
  ),
}));
afterEach(cleanup);

it('derives edge-to-edge layout from the active tab while preserving all pane instances', () => {
  const pane = (id: string): Pane => ({ id, title: id, kind: 'shell', projectId: null, cwd: '', state: 'placeholder' });
  const workspace: Workspace = {
    version: 1,
    panes: { a: pane('a'), b: pane('b'), hidden: pane('hidden') },
    tabs: [
      { id: 'single', projectId: null, name: 'Single', focusedPaneId: 'a', layout: { kind: 'pane', paneId: 'a' } },
      { id: 'split', projectId: null, name: 'Split', focusedPaneId: 'b', layout: {
        kind: 'split', id: 'divider', axis: 'horizontal', ratio: 0.5,
        first: { kind: 'pane', paneId: 'b' }, second: { kind: 'pane', paneId: 'hidden' },
      } },
    ], activeTabByProject: {},
  };
  const props = { workspace, knownProjectIds: [], settings: {} as Settings, visible: true,
    maximizedId: null, onPatch: vi.fn(), onFocus: vi.fn(), onStart: vi.fn(), onClose: vi.fn(),
    onMaximize: vi.fn(), onSplit: vi.fn(), onRatio: vi.fn(), onAlreadyOpen: vi.fn() };
  const { rerender } = render(<WorkspaceCanvas {...props} activeTabId="single" />);
  const canvas = screen.getByLabelText('開發工作區');
  const original = screen.getByTestId('a');
  const hidden = screen.getByTestId('hidden');
  expect(canvas).toHaveClass('single-pane');
  expect(original).toHaveAttribute('data-visible', 'true');
  expect(hidden).toHaveAttribute('data-visible', 'false');
  rerender(<WorkspaceCanvas {...props} activeTabId="split" />);
  expect(canvas).not.toHaveClass('single-pane');
  expect(screen.getByRole('separator')).toBeInTheDocument();
  expect(screen.getByTestId('a')).toBe(original);
  expect(screen.getByTestId('hidden')).toBe(hidden);
  rerender(<WorkspaceCanvas {...props} activeTabId="split" maximizedId="b" />);
  expect(canvas).not.toHaveClass('single-pane');
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  rerender(<WorkspaceCanvas {...props} activeTabId="single" />);
  expect(canvas).toHaveClass('single-pane');
  expect(screen.getByTestId('a')).toBe(original);
  const splitWorkspace: Workspace = { ...workspace,
    panes: { ...workspace.panes, added: pane('added') },
    tabs: workspace.tabs.map(tab => tab.id === 'single' ? { ...tab, layout: {
      kind: 'split' as const, id: 'new-divider', axis: 'vertical' as const, ratio: 0.5,
      first: { kind: 'pane' as const, paneId: 'a' }, second: { kind: 'pane' as const, paneId: 'added' },
    } } : tab),
  };
  rerender(<WorkspaceCanvas {...props} workspace={splitWorkspace} activeTabId="single" />);
  expect(canvas).not.toHaveClass('single-pane');
  expect(screen.getByTestId('a')).toBe(original);
  expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
  rerender(<WorkspaceCanvas {...props} activeTabId="single" />);
  expect(canvas).toHaveClass('single-pane');
  expect(screen.getByTestId('a')).toBe(original);
  expect(screen.queryByTestId('added')).not.toBeInTheDocument();
  rerender(<WorkspaceCanvas {...props} activeTabId="missing" />);
  expect(canvas).not.toHaveClass('single-pane');
});
