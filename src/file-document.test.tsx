import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { FileDocument } from './components/FileDocument';
import { readWorkspaceText, FULL_FILE_BYTES, NORMAL_FILE_BYTES, RangeRequired } from './components/file-reader';
vi.mock('./api', () => ({ api: { inspectWorkspaceFile: vi.fn() }, errorMessage: String }));
vi.mock('./components/file-reader', async original => ({ ...await original<typeof import('./components/file-reader')>(), readWorkspaceText: vi.fn() }));
vi.mock('./components/ExplorerEditor', () => ({ ExplorerEditor: ({ text, lightweight, partial }: { text: string; lightweight: boolean; partial: boolean }) => <div data-testid="editor" data-lightweight={lightweight} data-partial={partial}>{text}</div> }));
const props = { projectId: 'p', path: 'file.txt', searchRequest: 0, position: { top: 0, left: 0 }, onScroll: vi.fn() };
const info = { path: 'file.txt', version: 'v1', kind: 'text' as const, sizeBytes: 7 };
const value = { text: 'content', lines: 1, longestLine: 7, start: 0, end: 7, partial: false, lightweight: false };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.inspectWorkspaceFile).mockResolvedValue(info); vi.mocked(readWorkspaceText).mockResolvedValue(value); });
describe('bounded active file document', () => {
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
