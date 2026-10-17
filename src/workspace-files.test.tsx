import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFiles } from './components/WorkspaceFiles';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { api } from './api';
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
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('p', '', 200, false);
    fireEvent.click(screen.getByText('node_modules'));
    await screen.findByText('nested.txt');
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('p', 'node_modules', 0, false);
    fireEvent.click(screen.getByLabelText('顯示隱藏檔案'));
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
it('preserves live mounts, per-tab selections and focus while toggling or switching', async () => {
  const view = render(<WorkspaceCanvas {...props} activeTabId="a" />);
  const terminal = screen.getByLabelText('terminal a');
  terminal.focus();
  expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '檔案預覽' }));
  fireEvent.click(await screen.findByText('a.txt'));
  await screen.findByText('content a.txt');
  view.rerender(<WorkspaceCanvas {...props} activeTabId="b" />);
  fireEvent.click(screen.getByRole('button', { name: '檔案預覽' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'b.txt', hidden: true })).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByText('content b.txt');
  view.rerender(<WorkspaceCanvas {...props} activeTabId="a" />);
  expect(screen.getByLabelText('唯讀內容：a.txt')).toBeVisible();
  fireEvent.keyDown(screen.getByLabelText('唯讀內容：a.txt'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '檔案預覽' })).toHaveFocus();
  expect(screen.getByLabelText('terminal a')).toBe(terminal);
  expect(mounts.mount).toHaveBeenCalledTimes(2);
  expect(mounts.unmount).not.toHaveBeenCalled();
});
it('offers no implicit HOME browser for temporary or unavailable projects', () => {
  render(<WorkspaceCanvas {...props} workspace={{ ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, projectId: null })) }} activeTabId="a" />);
  expect(screen.queryByRole('button', { name: '檔案預覽' })).not.toBeInTheDocument();
  expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
});

it('places the toggle outside the canvas, hides it off-workspace and returns Escape focus', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const view = render(<WorkspaceCanvas {...props} fileToolbarHost={host} activeTabId="a" />);
  expect(host.querySelector('button')).toBe(screen.getByRole('button', { name: '檔案預覽' }));
  expect(view.container.querySelector('.workspace-files-toolbar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '檔案預覽' }));
  fireEvent.click(await screen.findByText('a.txt'));
  fireEvent.keyDown(await screen.findByLabelText('唯讀內容：a.txt'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '檔案預覽' })).toHaveFocus();
  view.rerender(<WorkspaceCanvas {...props} fileToolbarHost={host} activeTabId="a" visible={false} />);
  expect(host.querySelector('button')).toBeNull();
  expect(mounts.unmount).not.toHaveBeenCalled();
  view.unmount();
  host.remove();
});
