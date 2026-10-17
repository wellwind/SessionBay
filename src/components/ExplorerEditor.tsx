import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Search, X } from 'lucide-react';
import { fileLanguage, highlightLine, literalMatches } from './explorer-model';

export interface ScrollPosition { top: number; left: number }
export function ExplorerEditor({ path, text, sizeBytes, position, onScroll, searchRequest }: {
  path: string; text: string; sizeBytes: number; position: ScrollPosition;
  onScroll: (position: ScrollPosition) => void; searchRequest: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pendingReveal = useRef(false);
  const [view, setView] = useState({ top: position.top, height: 400 });
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const language = fileLanguage(path);
  const lines = useMemo(() => text.split('\n'), [text]);
  const offsets = useMemo(() => {
    let offset = 0;
    return lines.map(line => { const current = offset; offset += line.length + 1; return current; });
  }, [lines]);
  const matches = useMemo(() => literalMatches(text, query), [text, query]);
  const start = Math.min(lines.length - 1, Math.max(0, Math.floor(view.top / 20) - 8));
  const end = Math.min(lines.length, start + Math.ceil(view.height / 20) + 16);
  useLayoutEffect(() => {
    const element = scroller.current!;
    element.scrollTop = position.top; element.scrollLeft = position.left;
    const measure = () => { if (element.clientHeight) setView({ top: element.scrollTop, height: element.clientHeight }); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
    // The editor is keyed by file path/revision; restore its retained position on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (searchRequest) { setFinding(true); search.current?.focus(); } }, [searchRequest]);
  useEffect(() => { if (finding) search.current?.focus(); }, [finding]);
  const reveal = (index: number) => {
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setMatch(next);
    pendingReveal.current = true;
    const offset = matches[next];
    let low = 0; let high = offsets.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (offsets[mid] <= offset) low = mid; else high = mid; }
    const element = scroller.current!;
    element.scrollTop = Math.max(0, low * 20 - element.clientHeight / 3);
    element.scrollLeft = Math.max(0, (offset - offsets[low]) * 7.8 - 60);
    setView(old => ({ ...old, top: element.scrollTop }));
    onScroll({ top: element.scrollTop, left: element.scrollLeft });
  };
  useLayoutEffect(() => {
    if (!pendingReveal.current) return;
    pendingReveal.current = false;
    const element = scroller.current!;
    const mark = element.querySelector<HTMLElement>('mark.current-match');
    if (mark) {
      const target = mark.getBoundingClientRect(); const viewport = element.getBoundingClientRect();
      if (target.left < viewport.left + 48 || target.right > viewport.right) element.scrollLeft += target.left - viewport.left - 60;
      onScroll({ top: element.scrollTop, left: element.scrollLeft });
    }
  });
  const closeFind = () => { setFinding(false); scroller.current?.focus(); };
  useEffect(() => {
    if (query) reveal(0);
    // New text/query starts at its first result; moving results must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, text]);
  const visibleMatches = matches.filter(index => index + query.length > offsets[start] && index <= (offsets[end] ?? text.length));
  const marked = visibleMatches.slice(0, 300);
  if (matches[match] !== undefined && !marked.includes(matches[match])) marked.push(matches[match]);
  marked.sort((a, b) => a - b);
  const rendered = lines.slice(start, end).map((line, row) => {
    let tokenOffset = offsets[start + row];
    return <span key={start + row} data-line={start + row + 1}>{highlightLine(line, language).map((token, tokenIndex) => {
      const absolute = tokenOffset; tokenOffset += token.text.length;
      const hits = marked.filter(index => index < tokenOffset && index + query.length > absolute);
      let consumed = 0;
      const parts = [];
      for (const hit of hits) {
        const from = Math.max(0, hit - absolute); const to = Math.min(token.text.length, hit + query.length - absolute);
        if (from > consumed) parts.push(token.text.slice(consumed, from));
        parts.push(<mark key={hit} className={hit === matches[match] ? 'current-match' : ''}>{token.text.slice(from, to)}</mark>); consumed = to;
      }
      parts.push(token.text.slice(consumed));
      return <span key={tokenIndex} className={token.kind ? `syntax-${token.kind}` : undefined}>{parts}</span>;
    })}{start + row < lines.length - 1 ? '\n' : ''}</span>;
  });
  return <div className="explorer-editor" onKeyDown={event => {
    if (event.key === 'Escape' && finding) { event.preventDefault(); event.stopPropagation(); closeFind(); }
    if (event.key === 'F3') { event.preventDefault(); event.stopPropagation(); reveal(match + (event.shiftKey ? -1 : 1)); }
  }}>
    <div className="explorer-document-bar"><span title={path}>{path.split('/').join(' › ')}</span><button aria-label="複製檔案全文" title="複製全文（畫面選取只包含可見行）" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopyStatus('已複製全文'); }
      catch { setCopyStatus('剪貼簿不可用；畫面選取只包含可見行'); }
    }}><Copy size={14} /></button><button aria-label="檔案內搜尋" title="檔案內搜尋（Ctrl/Cmd+F）" onClick={() => { setFinding(true); search.current?.focus(); }}><Search size={14} /></button></div>
    {finding && <div className="explorer-find" role="search" aria-label="檔案內搜尋">
      <input ref={search} aria-label="搜尋文字（區分大小寫）" placeholder="搜尋文字" value={query} onChange={event => { setQuery(event.target.value); setMatch(0); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); reveal(match + (event.shiftKey ? -1 : 1)); }
      }} />
      <span role="status" aria-live="polite">{query ? `${matches.length ? match + 1 : 0}/${matches.length}${matches.length === 10000 ? '+' : ''}` : '區分大小寫'}</span>
      <button aria-label="上一個結果" disabled={!matches.length} onClick={() => reveal(match - 1)}><ArrowUp size={14} /></button>
      <button aria-label="下一個結果" disabled={!matches.length} onClick={() => reveal(match + 1)}><ArrowDown size={14} /></button>
      <button aria-label="關閉檔案搜尋" onClick={closeFind}><X size={14} /></button>
    </div>}
    <div ref={scroller} className="explorer-code-scroll" tabIndex={0} aria-label={`唯讀內容：${path}`} onScroll={event => {
      const element = event.currentTarget;
      setView(old => ({ ...old, top: element.scrollTop })); onScroll({ top: element.scrollTop, left: element.scrollLeft });
    }}>
      <div className="explorer-code-space" style={{ minHeight: lines.length * 20 }}>
        <div className="explorer-line-numbers" aria-hidden="true"><div style={{ paddingTop: start * 20 }}>{lines.slice(start, end).map((_, row) => <div key={start + row}>{start + row + 1}</div>)}</div></div>
        <pre style={{ paddingTop: start * 20, paddingBottom: Math.max(0, lines.length - end) * 20 }}><code>{rendered}</code></pre>
      </div>
    </div>
    <div className="explorer-status"><span>唯讀 · {language}</span><span>{lines.length.toLocaleString()} 行 · {sizeBytes.toLocaleString()} bytes</span><span role="status">{copyStatus || '選取可見行；複製全文請用上方按鈕'}</span></div>
  </div>;
}
