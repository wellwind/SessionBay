import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ExplorerEditor } from './components/ExplorerEditor';
import { monaco, models, widgets, onPreviewError } from './test/monaco-preview-mock';
vi.mock('./components/monaco-preview', () => ({ monaco, onPreviewError }));
beforeEach(() => { vi.clearAllMocks(); models.length = 0; widgets.length = 0; });
it('clamps a link location after model load, survives layout restore, reuses the model and never steals focus', async () => {
  const handled = vi.fn();
  const props = { path: 'file.ts', text: 'one\nlast', sizeBytes: 8, searchRequest: 0, position: { top: 100, left: 20 }, onScroll: vi.fn() };
  const view = render(<><textarea aria-label="live terminal" /><ExplorerEditor {...props}
    revealRequest={{ version: 'v1', nonce: 1, line: 999, column: 999 }} onRevealHandled={handled} /></>);
  const terminal = screen.getByLabelText('live terminal'); terminal.focus();
  await waitFor(() => expect(screen.getByRole('button', { name: '檔案內搜尋' })).toBeEnabled());
  const widget = monaco.editor.create.mock.results.at(-1)!.value;
  expect(widget.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 5 });
  expect(widget.revealPositionInCenter).toHaveBeenLastCalledWith({ lineNumber: 2, column: 5 });
  expect(handled).toHaveBeenCalledWith(1);
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  expect(widget.setScrollPosition).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(terminal); expect(widget.focus).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('超出範圍');
  view.rerender(<><textarea aria-label="live terminal" /><ExplorerEditor {...props}
    revealRequest={{ version: 'v1', nonce: 2, line: 1, column: 2 }} onRevealHandled={handled} /></>);
  expect(monaco.editor.createModel).toHaveBeenCalledTimes(1);
  expect(widget.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 2 });
  expect(handled).toHaveBeenCalledWith(2); expect(widget.focus).not.toHaveBeenCalled();
});
