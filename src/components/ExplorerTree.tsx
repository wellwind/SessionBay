import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FileJson, FileText, Folder, FolderOpen, LockKeyhole } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { WorkspaceFileEntry } from '../types';
import type { KeyboardEvent } from 'react';

export function FileIcon({ path }: { path: string }) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const Icon = ['json', 'yml', 'yaml'].includes(ext) ? FileJson : ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'css', 'html', 'sh'].includes(ext) ? FileCode2 : FileText;
  return <Icon size={15} aria-hidden="true" className={`explorer-file-icon file-${ext.replace(/[^a-z]/g, '').slice(0, 8)}`} />;
}
interface TreeProps {
  projectId: string; showHidden: boolean; selected: string;
  onOpen: (path: string, pinned?: boolean) => void;
  onMenu: (path: string, button: HTMLElement, x: number, y: number) => void;
}
function Directory({ path, depth, focus, setFocus, ...props }: TreeProps & { path: string; depth: number; focus: string; setFocus: (path: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const alive = useRef(false);
  const pending = useRef(false);
  const load = async (offset: number) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const page = await api.listWorkspaceFiles(props.projectId, path, offset, props.showHidden);
      if (alive.current) {
        setEntries(old => {
          if (!offset) return page.entries;
          const known = new Set(old.map(item => item.path));
          return [...old, ...page.entries.filter(entry => !known.has(entry.path))];
        });
        setNext(page.nextOffset);
      }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void load(0);
    return () => { alive.current = false; };
    // A directory instance is keyed by project, hidden setting and refresh generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ul role={depth ? 'group' : 'tree'} className="workspace-file-tree" aria-label={depth ? undefined : '專案根目錄'}>
    {entries.map((entry, index) => <li key={entry.path} role="treeitem" aria-selected={props.selected === entry.path}
      aria-expanded={entry.kind === 'directory' ? !!expanded[entry.path] : undefined}>
      <button data-tree-row data-path={entry.path} data-parent={path} data-directory={entry.kind === 'directory'}
        className={props.selected === entry.path ? 'selected' : ''} disabled={entry.kind === 'blocked'}
        tabIndex={focus === entry.path || (!focus && depth === 0 && index === entries.findIndex(item => item.kind !== 'blocked')) ? 0 : -1}
        onFocus={() => setFocus(entry.path)}
        title={entry.kind === 'blocked' ? '連結或特殊檔案不開啟' : entry.path}
        aria-expanded={entry.kind === 'directory' ? !!expanded[entry.path] : undefined}
        onClick={() => entry.kind === 'directory' ? setExpanded(old => ({ ...old, [entry.path]: !old[entry.path] })) : props.onOpen(entry.path)}
        onDoubleClick={() => { if (entry.kind === 'file') props.onOpen(entry.path, true); }}
        onContextMenu={event => { event.preventDefault(); props.onMenu(entry.path, event.currentTarget, event.clientX, event.clientY); }}>
        {entry.kind === 'directory' ? <>{expanded[entry.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{expanded[entry.path] ? <FolderOpen size={15} /> : <Folder size={15} />}</>
          : <><span className="explorer-tree-spacer" />{entry.kind === 'blocked' ? <LockKeyhole size={15} /> : <FileIcon path={entry.path} />}</>}
        <span>{entry.name}</span>{entry.kind === 'blocked' && <small>不開啟</small>}
      </button>
      {entry.kind === 'directory' && expanded[entry.path] !== undefined && <div hidden={!expanded[entry.path]}>
        <Directory {...props} key={entry.path} path={entry.path} depth={depth + 1} focus={focus} setFocus={setFocus} />
      </div>}
    </li>)}
    {busy && <li role="none"><span role="status">讀取目錄中…</span></li>}
    {error && <li role="none"><p role="alert">{error}</p><button onClick={() => void load(entries.length ? next ?? 0 : 0)}>重試目錄</button></li>}
    {!busy && !error && !entries.length && <li role="none" className="file-muted">沒有可顯示的檔案</li>}
    {next !== null && !error && <li role="none"><button disabled={busy} onClick={() => void load(next)}>載入更多檔案</button></li>}
  </ul>;
}
export function ExplorerTree(props: TreeProps) {
  const [focus, setFocus] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const keyDown = (event: KeyboardEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tree-row]');
    if (!button || !root.current) return;
    const rows = Array.from(root.current.querySelectorAll<HTMLButtonElement>('button[data-tree-row]')).filter(row => !row.disabled && !row.closest('[hidden]'));
    const index = rows.indexOf(button);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (button.dataset.directory === 'true') {
        if (button.getAttribute('aria-expanded') !== 'true') button.click(); else next = rows[index + 1]?.dataset.parent === button.dataset.path ? rows[index + 1] : undefined;
      }
    } else if (event.key === 'ArrowLeft') {
      if (button.getAttribute('aria-expanded') === 'true') button.click(); else next = rows.find(row => row.dataset.path === button.dataset.parent);
    } else if (event.key === 'Enter' || event.key === ' ') button.click();
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const rect = button.getBoundingClientRect(); props.onMenu(button.dataset.path!, button, rect.left, rect.bottom);
    } else return;
    event.preventDefault(); event.stopPropagation(); next?.focus();
  };
  return <div ref={root} className="workspace-file-list" onKeyDown={keyDown}><Directory {...props} path="" depth={0} focus={focus} setFocus={setFocus} /></div>;
}
