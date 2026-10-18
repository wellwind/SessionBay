import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesTestHost as WorkspaceFiles } from './test/FilesTestHost';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { api } from './api';
import { monaco, onPreviewError } from './test/monaco-preview-mock';
vi.mock('./components/monaco-preview', () => ({ monaco, onPreviewError }));
import type { Settings, Workspace } from './types';
const mounts = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('./components/TerminalPane', () => ({ TerminalPane: ({ pane }: { pane: { id: string } }) => {
  useEffect(() => { mounts.mount(pane.id); return () => mounts.unmount(pane.id); }, [pane.id]);
  return <textarea aria-label={`terminal ${pane.id}`} />;
} }));
vi.mock('./api', () => ({ api: { listWorkspaceFiles: vi.fn(), readWorkspaceFile: vi.fn() }, errorMessage: (error: unknown) => String(error) }));
const entry = (name: string, kind: 'file' | 'directory' | 'blocked' = 'file') => ({ name, path: name, kind });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listWorkspaceFiles).mockResolvedValue({ entries: [entry('a.txt'), entry('b.txt')], nextOffset: null });
  vi.mocked(api.readWorkspaceFile).mockImplementation(async (_id, path) => ({ path, text: `content ${path}`, sizeBytes: 12 }));
});
describe('workspace file browser', () => {
  it('loads only requested folders, pages explicitly, and hides links', async () => {
    vi.mocked(api.listWorkspaceFiles).mockImplementation(async (_id, path, offset) => ({
      entries: path ? [entry('nested.txt')] : offset ? [entry('last.txt')] : [entry('node_modules', 'directory'), entry('outside', 'blocked')],
      nextOffset: !path && !offset ? 200 : null,
    }));
    render(<WorkspaceFiles projectId="p" />);
    expect(await screen.findByText('node_modules')).toBeInTheDocument();
    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /outside/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '載入更多檔案' }));
    await screen.findByText('last.txt');
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('p', '', 200, true);
    fireEvent.click(screen.getByText('node_modules'));
    await screen.findByText('nested.txt');
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('p', 'node_modules', 0, true);
    expect(screen.queryByLabelText('顯示隱藏檔案')).not.toBeInTheDocument();
    await waitFor(() => expect(api.listWorkspaceFiles).toHaveBeenCalledWith('p', '', 0, true));
  });
  it('renders source as text and ignores stale responses', async () => {
    let first!: (value: { path: string; text: string; sizeBytes: number }) => void;
    vi.mocked(api.readWorkspaceFile).mockImplementation((_id, path) => path === 'a.txt' ? new Promise((resolve) => { first = resolve; })
      : Promise.resolve({ path, text: '<script>alert(1)</script>', sizeBytes: 25 }));
    const view = render(<WorkspaceFiles projectId="p" />);
    fireEvent.click(await screen.findByText('a.txt'));
    fireEvent.click(screen.getByText('b.txt'));
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    await act(async () => first({ path: 'a.txt', text: 'stale secret', sizeBytes: 12 }));
    expect(screen.queryByText('stale secret')).not.toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
  });
  it('shows errors and retries a directory without automatically opening files', async () => {
    vi.mocked(api.listWorkspaceFiles).mockRejectedValueOnce(new Error('Permission denied'));
    render(<WorkspaceFiles projectId="p" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    fireEvent.click(screen.getByText('重試目錄'));
    fireEvent.click(await screen.findByText('a.txt'));
    expect(await screen.findByText('content a.txt')).toBeInTheDocument();
    vi.mocked(api.readWorkspaceFile).mockRejectedValueOnce(new Error('File exceeds 256 KiB'));
    fireEvent.click(screen.getByText('b.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('256 KiB');
    expect(screen.queryByText('content a.txt')).not.toBeInTheDocument();
  });
});
const workspace: Workspace = { version: 1, tabs: ['a', 'b'].map((id) => ({ id, name: id, projectId: 'p', focusedPaneId: id, layout: { kind: 'pane', paneId: id } })),
  panes: Object.fromEntries(['a', 'b'].map((id) => [id, { id, title: id, kind: 'shell', projectId: 'p', cwd: '/synthetic', state: 'running' }])), activeTabByProject: { p: 'a' } };
const props = { workspace, knownProjectIds: ['p'], settings: {} as Settings, visible: true, maximizedId: null,
  onPatch: vi.fn(), onFocus: vi.fn(), onStart: vi.fn(), onClose: vi.fn(), onMaximize: vi.fn(), onSplit: vi.fn(), onRatio: vi.fn(), onAlreadyOpen: vi.fn() };
it('keeps live terminals mounted while the project shows a file or history', () => {
  const view = render(<WorkspaceCanvas {...props} activeTabId="a" />);
  const terminal = screen.getByLabelText('terminal a');
  view.rerender(<WorkspaceCanvas {...props} activeTabId="a" visible={false} />);
  expect(screen.getByLabelText('terminal a')).toBe(terminal);
  expect(terminal).not.toBeVisible();
  view.rerender(<WorkspaceCanvas {...props} activeTabId="b" />);
  expect(screen.getByLabelText('terminal a')).toBe(terminal);
  expect(mounts.mount).toHaveBeenCalledTimes(2);
  expect(mounts.unmount).not.toHaveBeenCalled();
  expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
});
it('does not attach a browser to runtime tabs or temporary HOME terminals', () => {
  render(<WorkspaceCanvas {...props} workspace={{ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, projectId: null })) }} activeTabId="a" />);
  expect(screen.queryByRole('button', { name: '檔案預覽' })).not.toBeInTheDocument();
  expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
});
