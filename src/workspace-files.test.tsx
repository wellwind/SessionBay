import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesTestHost as WorkspaceFiles } from './test/FilesTestHost';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { api } from './api';
import { clearFileCache } from './components/file-reader';
import { monaco, onPreviewError } from './test/monaco-preview-mock';
vi.mock('./components/monaco-preview', () => ({ monaco, onPreviewError }));
import type { Settings, Workspace, WorkspaceFileInfo, WorkspaceFileChunk } from './types';
const mounts = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('./components/TerminalPane', () => ({ TerminalPane: ({ pane }: { pane: { id: string } }) => {
  useEffect(() => { mounts.mount(pane.id); return () => mounts.unmount(pane.id); }, [pane.id]);
  return <textarea aria-label={`terminal ${pane.id}`} />;
} }));
vi.mock('./api', () => ({ api: { listWorkspaceFiles: vi.fn(), inspectWorkspaceFile: vi.fn(), readWorkspaceFileChunk: vi.fn() }, errorMessage: (error: unknown) => String(error) }));
const fileBytes = (text: string) => new TextEncoder().encode(text);
const fileInfo = (path: string, text = `content ${path}`): WorkspaceFileInfo => ({ path, sizeBytes: fileBytes(text).length, version: `fixture:${path}`, kind: 'text' });
const entry = (name: string, kind: 'file' | 'directory' | 'blocked' = 'file') => ({ name, path: name, kind });
beforeEach(() => {
  vi.clearAllMocks();
  clearFileCache();
  vi.mocked(api.listWorkspaceFiles).mockResolvedValue({ entries: [entry('a.txt'), entry('b.txt')], nextOffset: null });
  vi.mocked(api.inspectWorkspaceFile).mockImplementation(async (_id, path) => fileInfo(path));
  vi.mocked(api.readWorkspaceFileChunk).mockImplementation(async (_id, path, version, offset, maxBytes) => {
    expect(version).toBe(fileInfo(path).version);
    const bytes = fileBytes(`content ${path}`);
    const chunk = bytes.slice(offset, offset + maxBytes);
    return { bytes: Array.from(chunk), eof: offset + chunk.length === bytes.length };
  });
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
    let first!: (value: WorkspaceFileInfo) => void;
    const source = '<script>alert(1)</script>中文';
    vi.mocked(api.inspectWorkspaceFile).mockImplementation((_id, path) => path === 'a.txt' ? new Promise((resolve) => { first = resolve; })
      : Promise.resolve(fileInfo(path, source)));
    vi.mocked(api.readWorkspaceFileChunk).mockResolvedValue({ bytes: Array.from(fileBytes(source)), eof: true });
    const view = render(<WorkspaceFiles projectId="p" />);
    fireEvent.click(await screen.findByText('a.txt'));
    fireEvent.click(screen.getByText('b.txt'));
    expect(await screen.findByText(source)).toBeInTheDocument();
    await act(async () => first(fileInfo('a.txt')));
    expect(screen.queryByText('content a.txt')).not.toBeInTheDocument();
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledExactlyOnceWith('p', 'b.txt', 'fixture:b.txt', 0, fileBytes(source).length);
    expect(view.container.querySelector('script')).toBeNull();
  });
  it('reads beyond the former preview cap and decodes a UTF-8 character split across chunks', async () => {
    const source = 'x'.repeat(256 * 1024 - 1) + '中文\r\n';
    const bytes = fileBytes(source);
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue(fileInfo('a.txt', source));
    vi.mocked(api.readWorkspaceFileChunk).mockImplementation(async (_id, _path, _version, offset, maxBytes) => {
      const chunk = bytes.slice(offset, offset + maxBytes);
      return { bytes: Array.from(chunk), eof: offset + chunk.length === bytes.length };
    });
    render(<WorkspaceFiles projectId="p" />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    await waitFor(() => expect(monaco.editor.createModel).toHaveBeenCalled());
    expect(vi.mocked(monaco.editor.createModel).mock.calls.at(-1)?.[0]).toBe(source);
    expect(api.readWorkspaceFileChunk).toHaveBeenNthCalledWith(1, 'p', 'a.txt', 'fixture:a.txt', 0, 256 * 1024);
    expect(api.readWorkspaceFileChunk).toHaveBeenNthCalledWith(2, 'p', 'a.txt', 'fixture:a.txt', 256 * 1024, bytes.length - 256 * 1024);
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2);
  });
  it.each(['cancel', 'hide', 'close'])('stops after the in-flight chunk when the document is %s', async action => {
    let finish!: (value: WorkspaceFileChunk) => void;
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...fileInfo('a.txt'), sizeBytes: 512 * 1024 });
    vi.mocked(api.readWorkspaceFileChunk).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<WorkspaceFiles projectId="p" />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    await waitFor(() => expect(api.readWorkspaceFileChunk).toHaveBeenCalledOnce());
    if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: '取消讀取' }));
    else if (action === 'hide') view.rerender(<WorkspaceFiles projectId="p" active={false} />);
    else fireEvent.click(screen.getByRole('button', { name: '關閉檔案 a.txt' }));
    await act(async () => finish({ bytes: new Array<number>(256 * 1024).fill(120), eof: false }));
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledOnce();
    expect(monaco.editor.createModel).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('唯讀內容：a.txt')).not.toBeInTheDocument();
    if (action === 'cancel') expect(screen.getByText('已取消讀取')).toBeVisible();
  });
  it('rechecks versions on revisit and invalidates a same-version cache on refresh', async () => {
    let revision = 1;
    const source = () => `revision ${revision} 中文`;
    vi.mocked(api.inspectWorkspaceFile).mockImplementation(async (_id, path) => ({ ...fileInfo(path, source()), version: `v${revision}` }));
    vi.mocked(api.readWorkspaceFileChunk).mockImplementation(async (_id, _path, version, offset, maxBytes) => {
      expect(version).toBe(`v${revision}`);
      const bytes = fileBytes(source()), chunk = bytes.slice(offset, offset + maxBytes);
      return { bytes: Array.from(chunk), eof: offset + chunk.length === bytes.length };
    });
    const view = render(<WorkspaceFiles projectId="p" />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    await screen.findByText('revision 1 中文');
    view.rerender(<WorkspaceFiles projectId="p" active={false} />);
    revision = 2;
    view.rerender(<WorkspaceFiles projectId="p" />);
    await screen.findByText('revision 2 中文');
    expect(api.inspectWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '重新整理檔案' }));
    await screen.findByText('revision 2 中文');
    expect(api.inspectWorkspaceFile).toHaveBeenCalledTimes(3);
    expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(3);
  });
  it('shows errors and retries a directory without automatically opening files', async () => {
    vi.mocked(api.listWorkspaceFiles).mockRejectedValueOnce(new Error('Permission denied'));
    render(<WorkspaceFiles projectId="p" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    fireEvent.click(screen.getByText('重試目錄'));
    fireEvent.click(await screen.findByText('a.txt'));
    expect(await screen.findByText('content a.txt')).toBeInTheDocument();
    vi.mocked(api.inspectWorkspaceFile).mockRejectedValueOnce(new Error('Permission denied while reading file'));
    fireEvent.click(screen.getByText('b.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied while reading file');
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
