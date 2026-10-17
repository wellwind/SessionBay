import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { WorkspaceFileEntry } from '../types';

function Directory({ projectId, path, showHidden, onSelect, selected }: {
  projectId: string; path: string; showHidden: boolean;
  onSelect: (path: string) => void; selected: string;
}) {
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const mounted = useRef(false);
  const pending = useRef(false);
  async function load(offset: number) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
    try {
      const page = await api.listWorkspaceFiles(projectId, path, offset, showHidden);
      if (!mounted.current) return;
      setEntries((old) => offset ? [...old, ...page.entries.filter((entry) => !old.some((item) => item.path === entry.path))] : page.entries);
      setNext(page.nextOffset);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load(0);
    return () => { mounted.current = false; };
    // Each directory is keyed by its path, hidden setting and refresh generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ul className="workspace-file-tree" aria-label={path || '專案根目錄'}>
    {entries.map((entry) => <li key={entry.path}>
      <button className={selected === entry.path ? 'selected' : ''}
        disabled={entry.kind === 'blocked'}
        aria-current={selected === entry.path ? 'true' : undefined}
        title={entry.kind === 'blocked' ? '符號連結、多重硬連結或特殊檔案不開啟' : entry.path}
        aria-expanded={entry.kind === 'directory' ? !!expanded[entry.path] : undefined}
        onClick={() => entry.kind === 'directory'
          ? setExpanded((old) => ({ ...old, [entry.path]: !old[entry.path] })) : onSelect(entry.path)}>
        {entry.kind === 'directory' ? <>{expanded[entry.path] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Folder size={14} /></> : <FileText size={14} />}
        <span>{entry.name}</span>{entry.kind === 'blocked' && <small>不開啟</small>}
      </button>
      {entry.kind === 'directory' && expanded[entry.path] && <Directory key={entry.path}
        projectId={projectId} path={entry.path} showHidden={showHidden} onSelect={onSelect} selected={selected} />}
    </li>)}
    {busy && <li role="status">讀取目錄中…</li>}
    {error && <li><p role="alert">{error}</p><button onClick={() => void load(entries.length ? next ?? 0 : 0)}>重試目錄</button></li>}
    {!busy && !error && !entries.length && <li className="file-muted">沒有可顯示的檔案</li>}
    {next !== null && !error && <li><button disabled={busy} onClick={() => void load(next)}>載入更多檔案</button></li>}
  </ul>;
}

export function WorkspaceFiles({ projectId }: { projectId: string }) {
  const [showHidden, setShowHidden] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{ text: string; sizeBytes: number }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(undefined); setError('');
    if (!selected) { setLoading(false); return; }
    setLoading(true);
    void api.readWorkspaceFile(projectId, selected).then((result) => {
      if (!cancelled) setPreview(result);
    }, (cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, selected, revision]);
  return <section className="workspace-files" aria-label="工作區檔案預覽">
    <div className="workspace-files-options">
      <label><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />顯示隱藏檔案</label>
      <button onClick={() => setRevision((value) => value + 1)} aria-label="重新整理檔案"><RefreshCw size={14} /></button>
    </div>
    <p className="file-muted file-scope">唯讀 · 專案原始目錄 · 文字上限 256 KiB · 不開啟連結</p>
    <div className="workspace-file-list">
      <Directory key={`${projectId}:${showHidden}:${revision}`} projectId={projectId} path="" showHidden={showHidden} selected={selected} onSelect={setSelected} />
    </div>
    <div className="workspace-file-preview">
      <div className="file-preview-title" title={selected}>{selected || '選擇文字或程式碼檔案'}{preview && <small>{preview.sizeBytes.toLocaleString()} bytes</small>}</div>
      {loading && <p role="status">讀取檔案中…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && <pre tabIndex={0} aria-label={`唯讀內容：${selected}`}><code>{preview.text}</code></pre>}
      {!selected && <p className="file-muted">展開目錄後選擇檔案。內容不會執行，也不會修改原檔。</p>}
    </div>
  </section>;
}
