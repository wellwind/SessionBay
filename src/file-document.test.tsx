import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { FileDocument } from './components/FileDocument';
import { readWorkspaceText, FULL_FILE_BYTES, NORMAL_FILE_BYTES, RangeRequired } from './components/file-reader';
vi.mock('./api', () => ({ api: { inspectWorkspaceFile: vi.fn(), readWorkspaceImage: vi.fn() }, errorMessage: String }));
vi.mock('./components/file-reader', async original => ({ ...await original<typeof import('./components/file-reader')>(), readWorkspaceText: vi.fn() }));
vi.mock('./components/image-reader', () => ({ parseWorkspaceImage: vi.fn(() => ({ blob: new Blob(), width: 1, height: 1, sourceFormat: 'png', firstFrameOnly: false })) }));
vi.mock('./components/ImageViewer', () => ({ ImageViewer: ({ path }: { path: string }) => <div data-testid="image">{path}</div> }));
vi.mock('./components/ExplorerEditor', () => ({ ExplorerEditor: ({ text, lightweight, partial, revealRequest }: { text: string; lightweight: boolean; partial: boolean; revealRequest?: { nonce: number } }) => <div data-testid="editor" data-reveal={revealRequest?.nonce} data-lightweight={lightweight} data-partial={partial}>{text}</div> }));
const props = { projectId: 'p', path: 'file.txt', searchRequest: 0, position: { top: 0, left: 0 }, onScroll: vi.fn() };
const info = { path: 'file.txt', version: 'v1', kind: 'text' as const, sizeBytes: 7 };
const value = { text: 'content', lines: 1, longestLine: 7, start: 0, end: 7, partial: false, lightweight: false };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.inspectWorkspaceFile).mockResolvedValue(info); vi.mocked(readWorkspaceText).mockResolvedValue(value); });
describe('bounded active file document', () => {
  it('routes content-sniffed images through the bounded binary API', async () => {
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, kind: 'image' });
    vi.mocked(api.readWorkspaceImage).mockResolvedValue(new ArrayBuffer(1));
    render(<FileDocument {...props} />); expect(await screen.findByTestId('image')).toHaveTextContent('file.txt');
    expect(api.readWorkspaceImage).toHaveBeenCalledWith('p', 'file.txt', 'v1'); expect(readWorkspaceText).not.toHaveBeenCalled();
  });
  it('cancel discards an in-flight image result', async () => {
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, kind: 'image' });
    let finish!: (value: ArrayBuffer) => void; vi.mocked(api.readWorkspaceImage).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<FileDocument {...props} />); await waitFor(() => expect(api.readWorkspaceImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '取消讀取' })); finish(new ArrayBuffer(1));
    await screen.findByText('已取消讀取'); await Promise.resolve(); expect(screen.queryByTestId('image')).toBeNull();
  });
  it('reads ordinary content after metadata', async () => { render(<FileDocument {...props} />); expect(await screen.findByTestId('editor')).toHaveTextContent('content'); expect(readWorkspaceText).toHaveBeenCalledWith('p', info, expect.any(AbortSignal), expect.any(Function), undefined); });
  it('requires consent before loading a 20–64 MiB document', async () => {
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, sizeBytes: NORMAL_FILE_BYTES + 1 });
    render(<FileDocument {...props} />); await screen.findByText('開啟大型文字檔'); expect(readWorkspaceText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '繼續開啟' })); expect(await screen.findByTestId('editor')).toBeVisible();
  });
  it('large files use explicit bounded ranges instead of unlimited models', async () => {
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, sizeBytes: FULL_FILE_BYTES + 1 });
    vi.mocked(readWorkspaceText).mockResolvedValue({ ...value, partial: true, lightweight: true });
    render(<FileDocument {...props} />); await screen.findByText('分段閱讀大型文字檔'); expect(readWorkspaceText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '分段閱讀' })); await screen.findByTestId('editor');
    expect(readWorkspaceText).toHaveBeenLastCalledWith('p', expect.anything(), expect.anything(), expect.anything(), 0);
    fireEvent.click(screen.getByRole('button', { name: '下一段' })); await waitFor(() => expect(readWorkspaceText).toHaveBeenLastCalledWith('p', expect.anything(), expect.anything(), expect.anything(), 7));
    await screen.findByTestId('editor'); fireEvent.click(screen.getByRole('button', { name: '上一段' }));
    await waitFor(() => expect(readWorkspaceText).toHaveBeenLastCalledWith('p', expect.anything(), expect.anything(), expect.anything(), 0));
  });
  it('line-count downgrade offers ranges', async () => { vi.mocked(readWorkspaceText).mockRejectedValue(new RangeRequired()); render(<FileDocument {...props} />); expect(await screen.findByText('分段閱讀大型文字檔')).toBeVisible(); });
  it('cancel during metadata prevents content and ignores a stale response', async () => {
    let finish!: (v: typeof info) => void; vi.mocked(api.inspectWorkspaceFile).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<FileDocument {...props} />); fireEvent.click(screen.getByRole('button', { name: '取消讀取' })); finish(info);
    await screen.findByText('已取消讀取'); await Promise.resolve(); expect(readWorkspaceText).not.toHaveBeenCalled(); expect(screen.queryByTestId('editor')).toBeNull();
  });
  it('unmount aborts an in-progress chunk chain', async () => {
    vi.mocked(readWorkspaceText).mockImplementation(async (_project, _info, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); signal.throwIfAborted(); return value; });
    const view = render(<FileDocument {...props} />); await waitFor(() => expect(readWorkspaceText).toHaveBeenCalled()); const signal = vi.mocked(readWorkspaceText).mock.calls[0][2]; view.unmount(); expect(signal.aborted).toBe(true);
  });
  it.each([{ ...info, kind: 'binary' as const }, { ...info, path: '../escape' }, { ...info, sizeBytes: Infinity }])('rejects invalid or non-text preflight %#', async metadata => {
    vi.mocked(api.inspectWorkspaceFile).mockResolvedValue(metadata); render(<FileDocument {...props} />); await screen.findByRole('alert'); expect(readWorkspaceText).not.toHaveBeenCalled();
  });
});

it('binds the initial link read to the inspected version and only explicit retry accepts a new version', async () => {
  vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, version: 'v2' });
  const handled = vi.fn();
  render(<FileDocument {...props} reference={{ version: 'v1', nonce: 1, line: 2 }} onReferenceHandled={handled} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('連結解析後已變更');
  expect(readWorkspaceText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新讀取檔案' }));
  expect(await screen.findByTestId('editor')).toHaveTextContent('content');
  expect(handled).toHaveBeenCalledWith(1);
});
it('a new link to an already loaded revision reuses content and only changes location', async () => {
  const view = render(<FileDocument {...props} />);
  await screen.findByTestId('editor');
  view.rerender(<FileDocument {...props} reference={{ version: 'v1', nonce: 2, line: 9 }} />);
  expect(screen.getByTestId('editor')).toHaveAttribute('data-reveal', '2');
  expect(readWorkspaceText).toHaveBeenCalledTimes(1);
  expect(api.inspectWorkspaceFile).toHaveBeenCalledTimes(1);
});
it('a link to a newer revision reloads before applying the new location', async () => {
  const view = render(<FileDocument {...props} />);
  await screen.findByTestId('editor');
  vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, version: 'v2' });
  let finish!: (result: typeof value) => void;
  vi.mocked(readWorkspaceText).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  view.rerender(<FileDocument {...props} reference={{ version: 'v2', nonce: 3, line: 9 }} />);
  await waitFor(() => expect(readWorkspaceText).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('editor')).toBeNull();
  finish({ ...value, text: 'new revision' });
  expect(await screen.findByTestId('editor')).toHaveAttribute('data-reveal', '3');
});
it('range mode explains that global line navigation was not applied and keeps reads bounded', async () => {
  vi.mocked(api.inspectWorkspaceFile).mockResolvedValue({ ...info, sizeBytes: FULL_FILE_BYTES + 1 });
  const handled = vi.fn();
  render(<FileDocument {...props} reference={{ version: 'v1', nonce: 4, line: 999 }} onReferenceHandled={handled} />);
  await screen.findByText('分段閱讀大型文字檔');
  expect(await screen.findByText(/分段閱讀不支援全檔行欄定位/)).toBeVisible();
  expect(readWorkspaceText).not.toHaveBeenCalled(); expect(handled).toHaveBeenCalledWith(4);
});
