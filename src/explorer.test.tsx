import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesTestHost as WorkspaceFiles } from './test/FilesTestHost';
import { ExplorerEditor } from './components/ExplorerEditor';
import { emptyFileTabs, fileTabsReducer, highlightLine, literalMatches } from './components/explorer-model';
import { api } from './api';
vi.mock('./api', () => ({ api: { listWorkspaceFiles: vi.fn(), readWorkspaceFile: vi.fn() }, errorMessage: String }));
const files = ['a.ts', 'b.txt', 'c.json'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listWorkspaceFiles).mockImplementation(async (_project, path) => ({ entries: path ? [{ name: 'nested.txt', path: 'src/nested.txt', kind: 'file' }] : [{ name: 'src', path: 'src', kind: 'directory' }, ...files.map(name => ({ name, path: name, kind: 'file' as const }))], nextOffset: null }));
  vi.mocked(api.readWorkspaceFile).mockImplementation(async (_project, path) => ({ path, text: `content ${path}`, sizeBytes: 12 }));
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
  it('never interprets markup/regex and bounds highlighting/search work', () => {
    const source = '<script>"<&"</script> // comment';
    expect(highlightLine(source, 'HTML').map(token => token.text).join('')).toBe(source);
    expect(highlightLine('x'.repeat(10000), 'TypeScript')).toHaveLength(1);
    expect(literalMatches('a.*\na.*', '.*')).toEqual([1, 5]);
    expect(literalMatches('x'.repeat(250000), 'x')).toHaveLength(10000);
    expect(literalMatches('a\nb', 'a\nb')).toEqual([0]);
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
  expect(await screen.findByLabelText('唯讀內容：a.ts')).toHaveTextContent('content a.ts');
  view.rerender(<WorkspaceFiles projectId="two" />);
  await screen.findByRole('button', { name: 'a.ts' });
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith('two', '', 0, true);
});
it('late responses cannot resurrect a closed preview and refresh failure clears cached text', async () => {
  let resolve!: (value: { path: string; text: string; sizeBytes: number }) => void;
  vi.mocked(api.readWorkspaceFile).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<WorkspaceFiles projectId="one" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
  fireEvent.click(screen.getByRole('button', { name: '關閉檔案 a.ts' }));
  await act(async () => resolve({ path: 'a.ts', text: 'closed secret', sizeBytes: 13 }));
  expect(screen.queryByText('closed secret')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' }));
  await screen.findByLabelText('唯讀內容：b.txt');
  vi.mocked(api.readWorkspaceFile).mockRejectedValueOnce(new Error('reparse denied'));
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
  expect(api.readWorkspaceFile).not.toHaveBeenCalled();
});
it('virtualizes large text, searches all lines and copies exact full text safely', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const text = Array.from({ length: 10000 }, (_, index) => `const value = ${index};`).join('\n') + '\n<script>never()</script>';
  const view = render(<ExplorerEditor path="large.ts" text={text} sizeBytes={text.length} position={{ top: 0, left: 0 }} onScroll={vi.fn()} searchRequest={0} />);
  expect(view.container.querySelectorAll('[data-line]').length).toBeLessThan(100);
  fireEvent.click(screen.getByRole('button', { name: '檔案內搜尋' }));
  fireEvent.change(screen.getByRole('textbox', { name: /搜尋文字/ }), { target: { value: '9999' } });
  expect(await screen.findByText('9999', { selector: 'mark' })).toHaveClass('current-match');
  expect(view.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '複製檔案全文' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  fireEvent.keyDown(screen.getByRole('textbox', { name: /搜尋文字/ }), { key: 'Escape' });
  expect(screen.getByLabelText('唯讀內容：large.ts')).toHaveFocus();
  expect(within(view.container).queryByRole('search')).not.toBeInTheDocument();
});
it('keeps tree focus, preserves document when sidebar collapses, and restores it across views', async () => {
  const activate = vi.fn();
  const view = render(<WorkspaceFiles projectId="one" onActivate={activate} />);
  const row = await screen.findByRole('button', { name: 'a.ts' });
  row.focus(); fireEvent.keyDown(row, { key: 'Enter' });
  const content = await screen.findByLabelText('唯讀內容：a.ts');
  expect(row).toHaveFocus(); expect(activate).toHaveBeenCalledOnce();
  content.scrollTop = 160; fireEvent.scroll(content);
  fireEvent.click(screen.getByRole('button', { name: '檔案內搜尋' }));
  fireEvent.change(screen.getByRole('textbox', { name: /搜尋文字/ }), { target: { value: 'content' } });
  view.rerender(<WorkspaceFiles projectId="one" sidebarVisible={false} />);
  expect(content).toBeVisible(); expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  view.rerender(<WorkspaceFiles projectId="one" active={false} />);
  expect(content).not.toBeVisible(); expect(screen.getByRole('tab')).toHaveAttribute('aria-selected', 'false');
  view.rerender(<WorkspaceFiles projectId="one" />);
  expect(screen.getByLabelText('唯讀內容：a.ts')).toBe(content);
  expect(screen.getByRole('textbox', { name: /搜尋文字/ })).toHaveValue('content');
  expect(api.readWorkspaceFile).toHaveBeenCalledTimes(1);
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
  expect(first).not.toBeVisible();
  view.rerender(<><WorkspaceFiles projectId="one" /><WorkspaceFiles projectId="two" visible={false} /></>);
  expect(first).toBeVisible(); expect(screen.getByRole('tab', { name: /a.ts/ })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /b.txt/ })).not.toBeInTheDocument();
  expect(api.readWorkspaceFile).toHaveBeenCalledTimes(2);
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
