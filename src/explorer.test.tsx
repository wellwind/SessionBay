import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesTestHost as WorkspaceFiles } from './test/FilesTestHost';
import { ExplorerEditor } from './components/ExplorerEditor';
import { emptyFileTabs, fileTabsReducer, monacoLanguage } from './components/explorer-model';
import { api } from './api';
import { clearFileCache } from './components/file-reader';
import type { WorkspaceFileInfo } from './types';
import { monaco, models, widgets, onPreviewError } from './test/monaco-preview-mock';
vi.mock('./components/monaco-preview', () => ({ monaco, onPreviewError }));
vi.mock('./api', () => ({ api: { listWorkspaceFiles: vi.fn(), inspectWorkspaceFile: vi.fn(), readWorkspaceFileChunk: vi.fn() }, errorMessage: String }));
const files = ['a.ts', 'b.txt', 'c.json'];
const fileBytes = (path: string) => new TextEncoder().encode(`content ${path}`);
const fileInfo = (path: string): WorkspaceFileInfo => ({ path, sizeBytes: fileBytes(path).length, version: `fixture:${path}`, kind: 'text' });
beforeEach(() => {
  vi.clearAllMocks();
  clearFileCache();
  vi.mocked(api.listWorkspaceFiles).mockImplementation(async (_project, path) => ({ entries: path ? [{ name: 'nested.txt', path: 'src/nested.txt', kind: 'file' }] : [{ name: 'src', path: 'src', kind: 'directory' }, ...files.map(name => ({ name, path: name, kind: 'file' as const }))], nextOffset: null }));
  vi.mocked(api.inspectWorkspaceFile).mockImplementation(async (_project, path) => fileInfo(path));
  vi.mocked(api.readWorkspaceFileChunk).mockImplementation(async (_project, path, version, offset, maxBytes) => {
    expect(version).toBe(fileInfo(path).version);
    const bytes = fileBytes(path);
    const chunk = bytes.slice(offset, offset + maxBytes);
    return { bytes: Array.from(chunk), eof: offset + chunk.length === bytes.length };
  });
});
describe('bounded file tab state', () => {
  it('replaces preview, preserves pinned tabs, caps memory and reorders without changing active', () => {
    let state = fileTabsReducer(emptyFileTabs, { type: 'open', path: 'first' });
    state = fileTabsReducer(state, { type: 'open', path: 'second' });
    expect(state.tabs.map(tab => tab.path)).toEqual(['second']);
    state = fileTabsReducer(state, { type: 'open', path: 'second', pinned: true });
    for (let i = 0; i < 19; i++) state = fileTabsReducer(state, { type: 'open', path: String(i), pinned: true });
    state = fileTabsReducer(state, { type: 'open', path: 'overflow' });
    expect(state.tabs).toHaveLength(20); expect(state.notice).toContain('20'); expect(state.active).toBe('18');
    state = fileTabsReducer(state, { type: 'move', path: 'second', target: '18' });
    expect(state.tabs.at(-1)?.path).toBe('second'); expect(state.active).toBe('18');
    state = fileTabsReducer(state, { type: 'close', path: '18' });
    expect(state.active).toBe('second');
  });
  it('maps language extensions and unknown content safely', () => {
    expect(monacoLanguage('src/Page.tsx')).toBe('typescript');
    expect(monacoLanguage('Windows\\SCRIPT.PS1')).toBe('powershell');
    expect(monacoLanguage('Dockerfile')).toBe('dockerfile');
    expect(monacoLanguage('unknown.data')).toBe('plaintext');
  });
});
it('pins on double click, keeps tabs separate, closes through focused native route', async () => {
  const view = render(<WorkspaceFiles projectId="one" />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  const tab = screen.getByRole('tab', { name: /b.txt/ }); tab.focus();
  act(() => { document.querySelector('[data-file-explorer]')!.dispatchEvent(new Event('explorer-close-file')); });
  expect(screen.queryByRole('tab', { name: /b.txt/ })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText('唯讀內容：a.ts')).toHaveTextContent('content a.ts'));
  view.rerender(<WorkspaceFiles projectId="two" />);
  await screen.findByRole('button', { name: 'a.ts' });
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith('two', '', 0, true);
});
it('late responses cannot resurrect a closed preview and refresh failure clears cached text', async () => {
  let resolve!: (value: WorkspaceFileInfo) => void;
  vi.mocked(api.inspectWorkspaceFile).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<WorkspaceFiles projectId="one" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.click(screen.getByRole('button', { name: '關閉檔案 a.ts' }));
  await act(async () => resolve(fileInfo('a.ts')));
  expect(api.readWorkspaceFileChunk).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('唯讀內容：a.ts')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  vi.mocked(api.inspectWorkspaceFile).mockRejectedValueOnce(new Error('reparse denied'));
  fireEvent.click(screen.getByRole('button', { name: '重新整理檔案' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('reparse denied');
  expect(screen.queryByText('content b.txt')).not.toBeInTheDocument();
});
it('navigates lazy tree and exposes keyboard context-copy with failure feedback', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  render(<WorkspaceFiles projectId="one" />);
  const folder = await screen.findByRole('button', { name: 'src' }); folder.focus();
  fireEvent.keyDown(folder, { key: 'ArrowRight' });
  const child = await screen.findByRole('button', { name: 'nested.txt' });
  fireEvent.keyDown(folder, { key: 'ArrowRight' }); expect(child).toHaveFocus();
  fireEvent.keyDown(child, { key: 'ArrowLeft' }); expect(folder).toHaveFocus();
  fireEvent.keyDown(folder, { key: 'ArrowRight' });
  fireEvent.keyDown(child, { key: 'F10', shiftKey: true });
  fireEvent.click(await screen.findByRole('menuitem', { name: '複製相對路徑' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('無法存取剪貼簿'));
  expect(screen.getByLabelText('專案相對路徑')).toHaveValue('src/nested.txt');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); expect(child).toHaveFocus();
  expect(api.inspectWorkspaceFile).not.toHaveBeenCalled();
  expect(api.readWorkspaceFileChunk).not.toHaveBeenCalled();
});
it('creates a read-only model, copies exact text and releases editor/model on close', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const text = '<script>never()</script>\n中文';
  const save = vi.fn();
  const view = render(<ExplorerEditor path="large.ts" text={text} sizeBytes={new TextEncoder().encode(text).length} position={{ top: 60, left: 10 }} onScroll={save} searchRequest={0} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());
  expect(monaco.editor.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ readOnly: true, domReadOnly: true, links: false }));
  expect(view.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '複製檔案全文' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  const model = models.at(-1)!; const widget = widgets.at(-1)!;
  view.unmount();
  expect(model.dispose).toHaveBeenCalledOnce(); expect(widget.dispose).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ top: 60, left: 10, viewState: expect.any(Object) }));
});
it('keeps tree focus, preserves the visible document, and restores a disposed hidden editor from cache', async () => {
  const activate = vi.fn();
  const view = render(<WorkspaceFiles projectId="one" onActivate={activate} />);
  const row = await screen.findByRole('button', { name: 'a.ts' });
  row.focus(); fireEvent.keyDown(row, { key: 'Enter' });
  const content = await screen.findByLabelText('唯讀內容：a.ts');
  expect(row).toHaveFocus(); expect(activate).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());
  const widget = vi.mocked(monaco.editor.create).mock.results.at(-1)!.value;
  const model = models.at(-1)!;
  widget.setScrollPosition({ scrollTop: 160, scrollLeft: 10 });
  fireEvent.click(screen.getByRole('button', { name: '檔案內搜尋' }));
  fireEvent.change(screen.getByRole('textbox', { name: /搜尋文字/ }), { target: { value: 'content' } });
  view.rerender(<WorkspaceFiles projectId="one" sidebarVisible={false} />);
  expect(content).toBeVisible(); expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  view.rerender(<WorkspaceFiles projectId="one" active={false} />);
  expect(content).not.toBeInTheDocument(); expect(screen.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
  expect(widget.dispose).toHaveBeenCalledOnce(); expect(model.dispose).toHaveBeenCalledOnce();
  view.rerender(<WorkspaceFiles projectId="one" />);
  const restored = await screen.findByLabelText('唯讀內容：a.ts');
  await waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());
  expect(restored).not.toBe(content);
  const nextWidget = vi.mocked(monaco.editor.create).mock.results.at(-1)!.value;
  expect(nextWidget.restoreViewState).toHaveBeenCalledWith({ viewState: { scrollTop: 160 } });
  expect(api.inspectWorkspaceFile).toHaveBeenCalledTimes(2);
  expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(1);
});
it('does not activate runtime-hidden file tabs on close or consume runtime Cmd+W', async () => {
  const activate = vi.fn(); const empty = vi.fn();
  const view = render(<WorkspaceFiles projectId="one" onActivate={activate} onEmpty={empty} />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
  await screen.findByLabelText('唯讀內容：a.ts'); activate.mockClear();
  view.rerender(<WorkspaceFiles projectId="one" active={false} onActivate={activate} onEmpty={empty} />);
  expect(fireEvent.keyDown(window, { key: 'w', metaKey: true })).toBe(true);
  expect(screen.getByRole('tab')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '關閉檔案 a.ts' }));
  expect(activate).not.toHaveBeenCalled(); expect(empty).not.toHaveBeenCalled();
});
it('closes active last file only, scopes shortcuts, and supports keyboard resizing/reordering', async () => {
  const empty = vi.fn();
  render(<WorkspaceFiles projectId="one" onEmpty={empty} />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.doubleClick(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  const tab = screen.getByRole('tab', { name: /b.txt/ }); tab.focus();
  fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true });
  expect(screen.getAllByRole('tab')[0]).toBe(tab); expect(tab).toHaveFocus();
  // Shared ActivityShell owns resizing; the Files contribution must not duplicate it.
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  fireEvent.keyDown(document.querySelector('[data-file-explorer]')!, { key: 'w', ctrlKey: true });
  expect(screen.getAllByRole('tab')).toHaveLength(1); expect(empty).not.toHaveBeenCalled();
  fireEvent.keyDown(document.querySelector('[data-file-explorer]')!, { key: 'w', metaKey: true });
  expect(empty).toHaveBeenCalledOnce(); expect(screen.queryByRole('tab')).not.toBeInTheDocument();
});
it('retains independent visited project tabs and ignores native close on hidden projects', async () => {
  const view = render(<><WorkspaceFiles projectId="one" /><WorkspaceFiles projectId="two" visible={false} /></>);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  const first = await screen.findByLabelText('唯讀內容：a.ts');
  view.rerender(<><WorkspaceFiles projectId="one" visible={false} /><WorkspaceFiles projectId="two" /></>);
  fireEvent.click(await screen.findByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  expect(first).not.toBeInTheDocument();
  view.rerender(<><WorkspaceFiles projectId="one" /><WorkspaceFiles projectId="two" visible={false} /></>);
  expect(await screen.findByLabelText('唯讀內容：a.ts')).toBeVisible();
  expect(screen.getByRole('tab', { name: /a.ts/ })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /b.txt/ })).not.toBeInTheDocument();
  expect(api.inspectWorkspaceFile).toHaveBeenCalledTimes(3);
  expect(api.readWorkspaceFileChunk).toHaveBeenCalledTimes(2);
});
it('drags only an opaque internal tab marker, never source or paths', async () => {
  render(<WorkspaceFiles projectId="one" />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.doubleClick(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  const dataTransfer = { clearData: vi.fn(), setData: vi.fn(), effectAllowed: '' };
  fireEvent.dragStart(screen.getByRole('tab', { name: /a.ts/ }).parentElement!, { dataTransfer });
  expect(dataTransfer.clearData).toHaveBeenCalledOnce();
  expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith('application/x-sessionbay-file-tab', 'internal');
  fireEvent.drop(screen.getByRole('tab', { name: /b.txt/ }).parentElement!, { dataTransfer });
  expect(screen.getAllByRole('tab')[1]).toHaveTextContent('a.ts');
});
it('leaves composing and modified tab navigation or deletion untouched', async () => {
  render(<WorkspaceFiles projectId="one" />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.doubleClick(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  const tab = screen.getByRole('tab', { name: /b.txt/ }); tab.focus();
  for (const keys of [
    { key: 'ArrowLeft', isComposing: true }, { key: 'ArrowLeft', keyCode: 229 },
    { key: 'ArrowLeft', ctrlKey: true }, { key: 'Home', metaKey: true },
    { key: 'End', shiftKey: true }, { key: 'ArrowLeft', altKey: true, shiftKey: true },
    { key: 'ArrowLeft', altKey: true, ctrlKey: true }, { key: 'ArrowLeft', altKey: true, metaKey: true },
    { key: 'Delete', altKey: true }, { key: 'Delete', shiftKey: true }, { key: 'Delete', ctrlKey: true },
  ]) expect(fireEvent.keyDown(tab, keys)).toBe(true);
  const prevented = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  prevented.preventDefault(); fireEvent(tab, prevented);
  expect(screen.getAllByRole('tab')[1]).toBe(tab);
  expect(tab).toHaveFocus(); expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getAllByRole('tab')).toHaveLength(2);
});
it('returns final-file focus to the tree after onEmpty changes the active view', async () => {
  function StatefulHost() {
    const [active, setActive] = useState(true);
    return <WorkspaceFiles projectId="one" active={active} onActivate={() => setActive(true)} onEmpty={() => setActive(false)} />;
  }
  render(<StatefulHost />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
  const editor = await screen.findByLabelText('唯讀內容：a.ts'); editor.focus();
  fireEvent.keyDown(editor, { key: 'w', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'src' })).toHaveFocus());
  expect(screen.queryByRole('region', { name: '工作區檔案預覽' })).not.toBeInTheDocument();
});
it.each(['dialog', 'focus'])('does not steal focus after a queued close when a newer %s owns interaction', async kind => {
  let frame: FrameRequestCallback | undefined;
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1; });
  const view = render(<WorkspaceFiles projectId="one" />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.doubleClick(screen.getByRole('button', { name: 'b.txt' }));
  const editor = await screen.findByLabelText('唯讀內容：b.txt'); editor.focus();
  fireEvent.keyDown(editor, { key: 'w', ctrlKey: true });
  const newer = document.createElement('button'); newer.textContent = 'newer owner';
  if (kind === 'dialog') newer.setAttribute('role', 'dialog');
  document.body.append(newer);
  if (kind === 'focus') newer.focus();
  const before = document.activeElement;
  act(() => frame?.(0));
  expect(document.activeElement).toBe(before);
  newer.remove(); view.unmount(); raf.mockRestore();
});

it('does not navigate or close file tabs behind a dialog', async () => {
  render(<WorkspaceFiles projectId="one" />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.doubleClick(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  const tab = screen.getByRole('tab', { name: /b.txt/ });
  const dialog = document.createElement('dialog'); dialog.setAttribute('open', ''); document.body.append(dialog);
  for (const key of ['Delete', 'ArrowLeft']) expect(fireEvent.keyDown(tab, { key })).toBe(true);
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(tab).toHaveAttribute('aria-selected', 'true');
  dialog.remove();
});

it('updates palette and mode in place, restores preview colors and disconnects on unmount', async () => {
  const root = document.documentElement;
  const oldTheme = root.dataset.theme, oldPalette = root.dataset.themePalette;
  root.dataset.theme = 'dark'; root.dataset.themePalette = 'bay';
  const view = render(<ExplorerEditor path="a.ts" text="const value = 42;" sizeBytes={17}
    position={{ top: 80, left: 12 }} onScroll={vi.fn()} searchRequest={0} />);
  try {
    await waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());
    const widget = vi.mocked(monaco.editor.create).mock.results.at(-1)!.value;
    const model = models.at(-1)!;
    const original = monaco.editor.defineTheme.mock.calls.at(-1);
    // Initial layout is unrelated to appearance and may still have one queued frame.
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    widget.setScrollPosition({ scrollTop: 120, scrollLeft: 15 });
    widget.restoreViewState.mockClear(); widget.setScrollPosition.mockClear(); widget.focus.mockClear();
    const creates = monaco.editor.create.mock.calls.length;
    await act(async () => { root.dataset.themePalette = 'ocean'; });
    expect(monaco.editor.defineTheme.mock.calls.at(-1)).not.toEqual(original);
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('sessionbay-preview');
    await act(async () => { root.dataset.theme = 'light'; root.dataset.themePalette = 'code-2026'; });
    expect(monaco.editor.defineTheme.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ base: 'vs', colors: expect.objectContaining({ 'editor.background': '#ffffff' }) }));
    await act(async () => { root.dataset.theme = 'dark'; root.dataset.themePalette = 'bay'; });
    expect(monaco.editor.defineTheme.mock.calls.at(-1)).toEqual(original);
    expect(monaco.editor.create).toHaveBeenCalledTimes(creates);
    expect(widget.restoreViewState).not.toHaveBeenCalled();
    expect(widget.setScrollPosition).not.toHaveBeenCalled();
    expect(widget.focus).not.toHaveBeenCalled();
    expect(widget.getScrollTop()).toBe(120); expect(widget.getScrollLeft()).toBe(15);
    expect(widget.dispose).not.toHaveBeenCalled(); expect(model.dispose).not.toHaveBeenCalled();
    view.unmount();
    const calls = monaco.editor.defineTheme.mock.calls.length;
    await act(async () => { root.dataset.themePalette = 'rose'; });
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(calls);
  } finally {
    view.unmount();
    if (oldTheme === undefined) delete root.dataset.theme; else root.dataset.theme = oldTheme;
    if (oldPalette === undefined) delete root.dataset.themePalette; else root.dataset.themePalette = oldPalette;
  }
});
