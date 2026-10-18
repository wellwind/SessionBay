import { useEffect, useRef, useState } from 'react';
import { Copy, Search } from 'lucide-react';
import type { editor } from 'monaco-editor';
import { fileLanguage, monacoLanguage } from './explorer-model';

export interface ScrollPosition { top: number; left: number; viewState?: editor.ICodeEditorViewState | null }
let nextModel = 0;
export function ExplorerEditor({ path, text, sizeBytes, position, onScroll, searchRequest }: {
  path: string; text: string; sizeBytes: number; position: ScrollPosition;
  onScroll: (position: ScrollPosition) => void; searchRequest: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ onScroll, position, searchRequest });
  latest.current = { onScroll, position, searchRequest };
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const find = () => { void instance.current?.getAction('actions.find')?.run(); };
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    setStatus('loading');
    void import('./monaco-preview').then(({ monaco }) => {
      if (disposed || !container.current) return;
      // Unique model ownership prevents collisions across projects with the same
      // relative path. The extension remains visible to language tokenizers.
      const uri = monaco.Uri.from({ scheme: 'sessionbay-preview', path: `/${++nextModel}/${path}` });
      const model = monaco.editor.createModel(text, monacoLanguage(path), uri);
      let widget: editor.IStandaloneCodeEditor;
      try {
        widget = monaco.editor.create(container.current, {
          model, readOnly: true, domReadOnly: true, automaticLayout: true,
          ariaLabel: `程式碼：${path}`, fontSize: 13, lineHeight: 20,
          minimap: { enabled: false }, scrollBeyondLastLine: false,
          folding: true, showFoldingControls: 'mouseover',
          renderValidationDecorations: 'off', links: false,
          stickyScroll: { enabled: false }, wordWrap: 'off', stopRenderingLineAfter: -1,
          unicodeHighlight: { ambiguousCharacters: false },
          padding: { top: 6, bottom: 6 },
        });
      } catch (error) { model.dispose(); throw error; }
      instance.current = widget;
      const retained = latest.current.position;
      if (retained.viewState) widget.restoreViewState(retained.viewState);
      else widget.setScrollPosition({ scrollTop: retained.top, scrollLeft: retained.left });
      const save = () => latest.current.onScroll({ top: widget.getScrollTop(), left: widget.getScrollLeft(), viewState: widget.saveViewState() });
      const scroll = widget.onDidScrollChange(save);
      const selection = widget.onDidChangeCursorSelection(save);
      const updateTheme = () => monaco.editor.setTheme(document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark');
      updateTheme();
      const observer = new MutationObserver(updateTheme);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      release = () => {
        save(); observer.disconnect(); scroll.dispose(); selection.dispose();
        widget.dispose(); model.dispose();
        if (instance.current === widget) instance.current = null;
      };
      setStatus('ready');
      if (latest.current.searchRequest) void widget.getAction('actions.find')?.run();
    }).catch(() => { if (!disposed) setStatus('error'); });
    return () => { disposed = true; release?.(); };
  }, [path, text, retry]);
  useEffect(() => { if (searchRequest) find(); }, [searchRequest]);
  return <div className="explorer-editor">
    <div className="explorer-document-bar"><span title={path}>{path.split('/').join(' › ')}</span>
      <button aria-label="複製檔案全文" title="複製全文" onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopyStatus('已複製全文'); }
        catch { setCopyStatus('剪貼簿不可用，請選取文字後複製'); }
      }}><Copy size={14} /></button>
      <button aria-label="檔案內搜尋" title="檔案內搜尋（Ctrl/Cmd+F）" disabled={status !== 'ready'} onClick={find}><Search size={14} /></button>
    </div>
    <div className="explorer-monaco-host" aria-label={`唯讀內容：${path}`} tabIndex={0} onFocus={event => { if (event.target === event.currentTarget) instance.current?.focus(); }}>
      <div ref={container} className="explorer-monaco" />
      {status === 'loading' && <p className="explorer-editor-message" role="status">載入編輯器中…</p>}
      {status === 'error' && <div className="explorer-editor-message" role="alert">無法載入編輯器。<button onClick={() => setRetry(value => value + 1)}>重試</button></div>}
    </div>
    <div className="explorer-status"><span>唯讀 · {fileLanguage(path)}</span><span>{text.split('\n').length.toLocaleString()} 行 · {sizeBytes.toLocaleString()} bytes</span><span role="status">{copyStatus}</span></div>
  </div>;
}
