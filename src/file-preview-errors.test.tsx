import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExplorerEditor } from './components/ExplorerEditor';
import { FilePreviewBoundary } from './components/FilePreviewBoundary';
import { emitPreviewError, models, monaco, onPreviewError, previewErrors, widgets } from './test/monaco-preview-mock';

vi.mock('./components/monaco-preview', () => ({ monaco, onPreviewError }));
const props = { path: 'safe.ts', text: 'const value = 1;', sizeBytes: 16, position: { top: 0, left: 0 }, onScroll: vi.fn(), searchRequest: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  models.length = 0; widgets.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
const ready = () => waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());

it('contains delayed Monaco errors, releases resources and retries without replacing the surrounding UI', async () => {
  const view = render(<><textarea aria-label="live terminal" /><ExplorerEditor {...props} /></>);
  await ready();
  const terminal = screen.getByLabelText('live terminal');
  fireEvent.change(terminal, { target: { value: 'keep terminal input' } });
  const model = models[0]; const widget = widgets[0];
  const staleError = onPreviewError.mock.calls.at(-1)![0];
  expect(previewErrors.size).toBe(1);
  act(() => emitPreviewError(new Error('delayed SuggestMemory failure')));
  expect(await screen.findByRole('alert')).toHaveTextContent('無法載入編輯器');
  expect(model.dispose).toHaveBeenCalledOnce(); expect(widget.dispose).toHaveBeenCalledOnce();
  expect(previewErrors.size).toBe(0);
  expect(screen.getByLabelText('live terminal')).toBe(terminal);
  expect(terminal).toHaveValue('keep terminal input');
  fireEvent.click(screen.getByRole('button', { name: '重試' }));
  await ready();
  expect(models).toHaveLength(2); expect(previewErrors.size).toBe(1);
  act(() => staleError(new Error('late error from disposed generation')));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(models[1].dispose).not.toHaveBeenCalled();
  view.unmount();
  expect(models[1].dispose).toHaveBeenCalledOnce(); expect(widgets[1].dispose).toHaveBeenCalledOnce();
  expect(previewErrors.size).toBe(0);
});

it('cleans up a synchronous setup failure after editor creation', async () => {
  monaco.editor.setTheme.mockImplementationOnce(() => { throw new Error('theme setup failed'); });
  render(<ExplorerEditor {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('無法載入編輯器');
  expect(models[0].dispose).toHaveBeenCalledOnce(); expect(widgets[0].dispose).toHaveBeenCalledOnce();
  expect(previewErrors.size).toBe(0);
});

it('disposes the model if editor construction fails and allows retry', async () => {
  monaco.editor.create.mockImplementationOnce(() => { throw new Error('constructor failed'); });
  render(<ExplorerEditor {...props} />);
  await screen.findByRole('alert');
  expect(models[0].dispose).toHaveBeenCalledOnce(); expect(previewErrors.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: '重試' }));
  await ready();
  expect(models).toHaveLength(2);
});

it('contains an unexpected error reported synchronously during construction', async () => {
  monaco.editor.setTheme.mockImplementationOnce(() => emitPreviewError(new Error('synchronous contribution error')));
  render(<ExplorerEditor {...props} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeDisabled();
  expect(models[0].dispose).toHaveBeenCalledOnce(); expect(widgets[0].dispose).toHaveBeenCalledOnce();
  expect(previewErrors.size).toBe(0);
});

it('contains rejected find actions instead of creating an unhandled rejection', async () => {
  render(<ExplorerEditor {...props} />);
  await ready();
  const widget = monaco.editor.create.mock.results.at(-1)!.value;
  widget.getAction.mockReturnValueOnce({ run: vi.fn().mockRejectedValue(new Error('find failed')) });
  fireEvent.click(screen.getByRole('button', { name: '檔案內搜尋' }));
  await screen.findByRole('alert');
  expect(models[0].dispose).toHaveBeenCalledOnce(); expect(widgets[0].dispose).toHaveBeenCalledOnce();
  expect(previewErrors.size).toBe(0);
});

it('contains scheduled layout errors and still releases the model if editor disposal throws', async () => {
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 7; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  render(<ExplorerEditor {...props} />);
  await ready();
  const widget = monaco.editor.create.mock.results.at(-1)!.value;
  widget.layout.mockImplementationOnce(() => { throw new Error('layout failed'); });
  widget.dispose.mockImplementationOnce(() => { throw new Error('dispose failed'); });
  act(() => frame?.(0));
  await screen.findByRole('alert');
  expect(cancel).toHaveBeenCalledWith(7);
  expect(models[0].dispose).toHaveBeenCalledOnce(); expect(previewErrors.size).toBe(0);
  expect(screen.getByLabelText('唯讀內容：safe.ts').querySelector('.explorer-monaco')).toBeEmptyDOMElement();
});

it('isolates React render failures and retry remounts only the failed preview', async () => {
  let broken = true;
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Preview() {
    useEffect(() => { mounted(); return unmounted; }, []);
    if (broken) throw new Error('render failed');
    return <p>recovered preview</p>;
  }
  const view = render(<><textarea aria-label="live terminal" /><FilePreviewBoundary path="safe.ts"><Preview /></FilePreviewBoundary></>);
  const terminal = screen.getByLabelText('live terminal');
  expect(await screen.findByRole('alert')).toHaveTextContent('safe.ts');
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: '重試' }));
  expect(await screen.findByText('recovered preview')).toBeInTheDocument();
  expect(screen.getByLabelText('live terminal')).toBe(terminal);
  expect(mounted).toHaveBeenCalledOnce();
  view.unmount(); expect(unmounted).toHaveBeenCalledOnce();
});
