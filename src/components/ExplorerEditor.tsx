import { useEffect, useRef, useState } from 'react';
import { Copy, Search } from 'lucide-react';
import type { editor } from 'monaco-editor';
import { fileLanguage, monacoLanguage } from './explorer-model';
import { previewTheme, previewThemeName } from './monaco-theme';

export interface ScrollPosition { top: number; left: number; viewState?: editor.ICodeEditorViewState | null }
let nextModel = 0;
export function ExplorerEditor({ path, text, sizeBytes, position, onScroll, searchRequest, lightweight = false, partial = false, lineCount }: {
  path: string; text: string; sizeBytes: number; position: ScrollPosition;
  onScroll: (position: ScrollPosition) => void; searchRequest: number;
  lightweight?: boolean; partial?: boolean; lineCount?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const runEditor = useRef<(action: (widget: editor.IStandaloneCodeEditor) => unknown) => void>(() => {});
  const latest = useRef({ onScroll, position, searchRequest });
  latest.current = { onScroll, position, searchRequest };
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const find = () => runEditor.current(widget => widget.getAction('actions.find')?.run());
  useEffect(() => {
    let disposed = false;
    let failed = false;
    let initializing = false;
    let released = false;
    let widget: editor.IStandaloneCodeEditor | undefined;
    let save: (() => void) | undefined;
    const cleanups: (() => void)[] = [];
    const safely = (cleanup: () => void) => {
      try { cleanup(); } catch (error) { console.error('File preview cleanup failed', error); }
    };
    const release = () => {
      if (released) return;
      released = true;
      if (runEditor.current === run) runEditor.current = () => {};
      // A failing disposer must not prevent the remaining resources being released.
      for (const cleanup of cleanups.reverse()) safely(cleanup);
      cleanups.length = 0;
      widget = undefined;
      save = undefined;
    };
    const own = (cleanup: () => void) => { if (released) safely(cleanup); else cleanups.push(cleanup); };
    const fail = (error: unknown) => {
      if (disposed || failed) return;
      failed = true;
      console.error('File preview failed', error);
      // Monaco may report an unexpected error synchronously during construction.
      // Finish acquiring each returned resource before disposing it.
      if (!initializing) release();
      setStatus('error');
    };
    const run = (action: (widget: editor.IStandaloneCodeEditor) => unknown) => {
      if (disposed || failed || !widget) return;
      try { void Promise.resolve(action(widget)).catch(fail); } catch (error) { fail(error); }
    };
    runEditor.current = run;
    setStatus('loading');
    void import('./monaco-preview').then(({ monaco, onPreviewError }) => {
      if (disposed || !container.current) return;
      initializing = true;
      try {
        const host = container.current;
        // Remove a partial widget's DOM even when its constructor/disposer throws.
        own(() => host.replaceChildren());
        own(onPreviewError(fail));
        // Unique model ownership prevents collisions across projects with the same
        // relative path. The extension remains visible to language tokenizers.
        const uri = monaco.Uri.from({ scheme: 'sessionbay-preview', path: `/${++nextModel}/${path}` });
        const model = monaco.editor.createModel(text, lightweight ? 'plaintext' : monacoLanguage(path), uri);
        own(() => model.dispose());
        if (failed || disposed) return;
        const updateTheme = () => {
          const { theme, themePalette } = document.documentElement.dataset;
          monaco.editor.defineTheme(previewThemeName, previewTheme(themePalette, theme === 'light' ? 'light' : 'dark'));
          monaco.editor.setTheme(previewThemeName);
        };
        updateTheme();
        widget = monaco.editor.create(host, {
          theme: previewThemeName,
          model, readOnly: true, domReadOnly: true, automaticLayout: true,
          ariaLabel: `程式碼：${path}`, fontSize: 13, lineHeight: 20,
          minimap: { enabled: false }, scrollBeyondLastLine: false,
          folding: !lightweight, showFoldingControls: 'mouseover',
          renderValidationDecorations: 'off', links: false,
          stickyScroll: { enabled: false }, wordWrap: 'off', stopRenderingLineAfter: lightweight ? 10000 : -1,
          matchBrackets: lightweight ? 'never' : 'always',
          bracketPairColorization: { enabled: !lightweight },
          occurrencesHighlight: 'off', selectionHighlight: !lightweight,
          unicodeHighlight: { ambiguousCharacters: false },
          padding: { top: 6, bottom: 6 },
        });
        const ownedWidget = widget;
        own(() => ownedWidget.dispose());
        if (failed || disposed) return;
        const retained = latest.current.position;
        const restore = () => {
          if (retained.viewState) ownedWidget.restoreViewState(retained.viewState);
          else ownedWidget.setScrollPosition({ scrollTop: retained.top, scrollLeft: retained.left });
        };
        restore();
        // Restore again after the host and horizontal scrollbar have their final
        // dimensions. Restoring during construction can clamp a near-bottom offset.
        const restoreFrame = requestAnimationFrame(() => {
          run(current => { current.layout(); restore(); });
        });
        own(() => cancelAnimationFrame(restoreFrame));
        save = () => latest.current.onScroll({ top: ownedWidget.getScrollTop(), left: ownedWidget.getScrollLeft(), viewState: ownedWidget.saveViewState() });
        const scroll = ownedWidget.onDidScrollChange(() => run(() => save?.()));
        own(() => scroll.dispose());
        const selection = ownedWidget.onDidChangeCursorSelection(() => run(() => save?.()));
        own(() => selection.dispose());
        const observer = new MutationObserver(() => run(updateTheme));
        own(() => observer.disconnect());
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-palette'] });
        if (failed || disposed) return;
        setStatus('ready');
        if (latest.current.searchRequest) run(current => current.getAction('actions.find')?.run());
      } catch (error) { fail(error); }
      finally { initializing = false; if (failed || disposed) release(); }
    }).catch(fail);
    return () => {
      disposed = true;
      if (!failed && save) safely(save);
      release();
    };
  }, [path, text, retry, lightweight]);
  useEffect(() => { if (searchRequest) find(); }, [searchRequest]);
  return <div className="explorer-editor">
    <div className="explorer-document-bar"><span title={path}>{path.split('/').join(' › ')}</span>
      <button aria-label={partial ? '複製目前區段' : '複製檔案全文'} title={partial ? '複製區段' : '複製全文'} onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopyStatus(partial ? '已複製目前區段' : '已複製全文'); }
        catch { setCopyStatus('剪貼簿不可用，請選取文字後複製'); }
      }}><Copy size={14} /></button>
      <button aria-label="檔案內搜尋" title="檔案內搜尋（Ctrl/Cmd+F）" disabled={status !== 'ready'} onClick={find}><Search size={14} /></button>
    </div>
    <div className="explorer-monaco-host" aria-label={`唯讀內容：${path}`} tabIndex={0} onFocus={event => { if (event.target === event.currentTarget) runEditor.current(widget => widget.focus()); }}>
      <div ref={container} className="explorer-monaco" />
      {status === 'loading' && <p className="explorer-editor-message" role="status">載入編輯器中…</p>}
      {status === 'error' && <div className="explorer-editor-message" role="alert">無法載入編輯器。<button onClick={() => setRetry(value => value + 1)}>重試</button></div>}
    </div>
    <div className="explorer-status"><span>唯讀 · {lightweight ? '純文字（效能模式）' : fileLanguage(path)}</span><span>{(lineCount ?? text.split('\n').length).toLocaleString()} 行 · {sizeBytes.toLocaleString()} bytes</span><span role="status">{copyStatus}</span></div>
  </div>;
}
