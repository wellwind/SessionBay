import { vi } from 'vitest';
// DOM-only contract double. Actual tokenization, folding, workers, selection and
// find behavior are exercised by Playwright against real Monaco.
export const models: { dispose: ReturnType<typeof vi.fn>; text: string }[] = [];
export const widgets: { dispose: ReturnType<typeof vi.fn> }[] = [];
export const previewErrors = new Set<(error: unknown) => void>();
export const onPreviewError = vi.fn((listener: (error: unknown) => void) => {
  previewErrors.add(listener);
  return vi.fn(() => { previewErrors.delete(listener); });
});
export function emitPreviewError(error: unknown) { for (const listener of previewErrors) listener(error); }
export const monaco = {
  Uri: { from: vi.fn(value => value) },
  editor: {
    defineTheme: vi.fn<(name: string, data: unknown) => void>(),
    setTheme: vi.fn(),
    createModel: vi.fn((text: string) => { const model = { text, dispose: vi.fn() }; models.push(model); return model; }),
    create: vi.fn((container: HTMLElement, options: { model: { text: string }; ariaLabel: string }) => {
      const pre = document.createElement('pre'); pre.textContent = options.model.text;
      container.append(pre);
      let top = 0; let left = 0;
      const widget = {
        dispose: vi.fn(() => container.replaceChildren()),
        setScrollPosition: vi.fn((value: { scrollTop: number; scrollLeft: number }) => { top = value.scrollTop; left = value.scrollLeft; }),
        restoreViewState: vi.fn(), saveViewState: vi.fn(() => ({ viewState: { scrollTop: top } })),
        getScrollTop: () => top, getScrollLeft: () => left,
        onDidScrollChange: () => ({ dispose: vi.fn() }), onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
        layout: vi.fn(), focus: vi.fn(),
        getAction: vi.fn(() => ({ run: vi.fn(() => {
          let input = container.querySelector('input');
          if (!input) { input = document.createElement('input'); input.setAttribute('aria-label', '搜尋文字'); container.append(input); }
          input.focus();
        }) })),
      };
      widgets.push(widget); return widget;
    }),
  },
};
