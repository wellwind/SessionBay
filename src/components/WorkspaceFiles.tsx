import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Copy, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../api';
import { ExplorerTree, FileIcon } from './ExplorerTree';
import { ExplorerEditor } from './ExplorerEditor';
import type { ScrollPosition } from './ExplorerEditor';
import { ExplorerTabs } from './ExplorerTabs';
import { emptyFileTabs, fileTabsReducer } from './explorer-model';
import './explorer.css';

interface DocumentData { path: string; text?: string; sizeBytes?: number; error?: string }
export function WorkspaceFiles({ projectId }: { projectId: string }) {
  // Reset all file state if a host reuses this component for another project.
  return <Explorer key={projectId} projectId={projectId} />;
}
function Explorer({ projectId }: { projectId: string }) {
  const [state, dispatch] = useReducer(fileTabsReducer, emptyFileTabs);
  const [hidden, setHidden] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [revision, setRevision] = useState(0);
  const [treeWidth, setTreeWidth] = useState(180);
  const [outerWidth, setOuterWidth] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);
  const [documentData, setDocument] = useState<DocumentData>();
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; target: HTMLElement }>();
  const root = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const documents = useRef(new Map<string, DocumentData>());
  const positions = useRef(new Map<string, ScrollPosition>());
  const activeRef = useRef(state.active); activeRef.current = state.active;
  const resize = useRef<{ x: number; width: number; outer: boolean } | undefined>(undefined);
  const open = (path: string, pinned = false) => { setNotice(''); setSearchRequest(0); dispatch({ type: 'open', path, pinned }); };
  const closeFile = (path: string) => {
    dispatch({ type: 'close', path });
    requestAnimationFrame(() => (root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') ?? root.current?.querySelector<HTMLButtonElement>('[data-tree-row]:not(:disabled)'))?.focus());
  };
  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('.workspace-files-pane');
    if (!pane || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setOuterWidth(Math.round(pane.getBoundingClientRect().width)));
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = root.current!;
    const close = () => { if (activeRef.current) closeFile(activeRef.current); };
    element.addEventListener('explorer-close-file', close);
    return () => element.removeEventListener('explorer-close-file', close);
  }, []);
  useEffect(() => {
    const paths = new Set(state.tabs.map(tab => tab.path));
    for (const path of documents.current.keys()) if (!paths.has(path)) documents.current.delete(path);
    for (const path of positions.current.keys()) if (!paths.has(path)) positions.current.delete(path);
  }, [state.tabs]);
  useEffect(() => {
    let cancelled = false;
    const path = state.active;
    setDocument(undefined);
    if (!path) return;
    const cached = documents.current.get(path);
    if (cached) { setDocument(cached); return; }
    void api.readWorkspaceFile(projectId, path).then(result => {
      if (!cancelled) { const value = { path, text: result.text, sizeBytes: result.sizeBytes }; documents.current.set(path, value); setDocument(value); }
    }, cause => {
      if (!cancelled) { const value = { path, error: errorMessage(cause) }; documents.current.set(path, value); setDocument(value); }
    });
    return () => { cancelled = true; };
  }, [projectId, state.active, revision]);
  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('.workspace-files-pane');
    const body = pane?.parentElement; const canvas = body?.parentElement;
    if (!pane || !body || !canvas) return;
    pane.dataset.explorerMaximized = String(maximized);
    const sync = () => {
      const active = canvas.style.display !== 'none' && Array.from(body.querySelectorAll<HTMLElement>('[data-explorer-maximized="true"]')).some(item => item.style.display !== 'none');
      const terminal = body.querySelector<HTMLElement>('.workspace-terminal-surface');
      if (terminal && terminal.inert !== active) terminal.inert = active;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(body, { subtree: true, attributes: true, attributeFilter: ['style', 'data-explorer-maximized'] });
    observer.observe(canvas, { attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); delete pane.dataset.explorerMaximized; sync(); };
  }, [maximized]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  const refresh = () => { documents.current.clear(); setDocument(undefined); setRevision(value => value + 1); };
  const width = (pixels: number) => {
    const pane = root.current?.closest<HTMLElement>('.workspace-files-pane');
    if (!pane?.parentElement) return;
    const available = pane.parentElement.getBoundingClientRect().width;
    pane.style.setProperty('--explorer-width', `${Math.max(Math.min(280, available * .75), Math.min(available * .75, pixels))}px`);
  };
  const copyPath = async () => {
    if (!menu) return;
    const target = menu.target;
    try { await navigator.clipboard.writeText(menu.path); setNotice('已複製專案相對路徑。'); setMenu(undefined); target.focus(); }
    catch { setNotice('無法存取剪貼簿，請選取下方路徑後複製。'); }
  };
  return <section ref={root} className="workspace-files explorer" data-file-explorer aria-label="工作區檔案預覽" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); setSearchRequest(value => value + 1);
    } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'w') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat && state.active) closeFile(state.active);
    } else if (event.ctrlKey && !event.metaKey && ['PageUp', 'PageDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const index = state.tabs.findIndex(tab => tab.path === state.active);
      if (state.tabs.length) open(state.tabs[(index + (event.key === 'PageUp' ? -1 : 1) + state.tabs.length) % state.tabs.length].path);
    } else if (event.key === 'Escape' && maximized) { event.preventDefault(); event.stopPropagation(); setMaximized(false); }
  }}>
    <div role="separator" aria-label="調整檔案區寬度" aria-orientation="vertical" aria-valuenow={outerWidth} aria-valuemin={0} aria-valuemax={Math.max(outerWidth, window.innerWidth)} aria-valuetext={`${outerWidth}px`} tabIndex={maximized ? -1 : 0} className="explorer-outer-resize" hidden={maximized}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize.current = { x: event.clientX, width: root.current!.parentElement!.getBoundingClientRect().width, outer: true }; }}
      onPointerMove={event => { if (resize.current?.outer && event.currentTarget.hasPointerCapture(event.pointerId)) width(resize.current.width + resize.current.x - event.clientX); }}
      onPointerUp={event => { resize.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resize.current = undefined; }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); width(root.current!.parentElement!.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 32 : -32)); } }} />
    <div className="explorer-toolbar"><strong>唯讀檔案</strong><span className="explorer-toolbar-spacer" />
      <button aria-label={treeVisible ? '收合目錄樹' : '顯示目錄樹'} aria-pressed={treeVisible} onClick={() => setTreeVisible(value => !value)}>{treeVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</button>
      <button aria-label="重新整理檔案" title="重新讀取目錄與檔案" onClick={refresh}><RefreshCw size={15} /></button>
      <button aria-label={maximized ? '還原檔案區' : '最大化檔案區'} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></div>
    <div className="explorer-options"><label><input aria-label="顯示隱藏檔案" type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />隱藏檔案</label>
      <label>檔案區<select aria-label="檔案區寬度" defaultValue="" onChange={event => width(Number(event.target.value))}><option value="" disabled>調寬</option><option value="320">窄</option><option value="560">中</option><option value="800">寬</option></select></label>
      <label className="explorer-tree-width-choice">目錄<select aria-label="目錄樹寬度" value={treeWidth} onChange={event => setTreeWidth(Number(event.target.value))}><option value={treeWidth}>{treeWidth}px</option>{[140, 180, 240, 300].filter(value => value !== treeWidth).map(value => <option key={value} value={value}>{value}px</option>)}</select></label></div>
    <div className={`explorer-body${treeVisible ? '' : ' tree-collapsed'}`} style={{ gridTemplateColumns: treeVisible ? `${treeWidth}px 5px minmax(0,1fr)` : undefined }}>
      <div className="explorer-tree-pane" hidden={!treeVisible}><ExplorerTree key={`${projectId}:${hidden}:${revision}`} projectId={projectId} showHidden={hidden} selected={state.active} onOpen={open}
        onMenu={(path, target, x, y) => setMenu({ path, target, x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 110) })} /></div>
      <div role="separator" aria-label="調整目錄樹寬度" aria-orientation="vertical" aria-valuemin={120} aria-valuemax={300} aria-valuenow={treeWidth} tabIndex={0} hidden={!treeVisible} className="explorer-tree-resize"
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize.current = { x: event.clientX, width: treeWidth, outer: false }; }}
        onPointerMove={event => { if (resize.current && !resize.current.outer && event.currentTarget.hasPointerCapture(event.pointerId)) setTreeWidth(Math.max(120, Math.min(300, resize.current.width + event.clientX - resize.current.x))); }}
        onPointerUp={event => { resize.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resize.current = undefined; }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setTreeWidth(value => Math.max(120, Math.min(300, value + (event.key === 'ArrowRight' ? 16 : -16)))); } }} />
      <div className="workspace-file-preview explorer-preview"><ExplorerTabs state={state} dispatch={action => { if (action.type === 'open') open(action.path, action.pinned); else dispatch(action); }} close={closeFile} />
        {state.notice && <p role="status">{state.notice}</p>}
        {!state.active ? <div className="explorer-empty"><FileIcon path="readme.txt" /><strong>開啟檔案閱讀</strong><p>單擊預覽，雙擊固定分頁。<br />只讀取原始文字，不執行內容。</p><small>專案目錄 · 每檔上限 256 KiB</small></div>
          : !documentData || documentData.path !== state.active ? <p role="status">讀取檔案中…</p>
            : documentData.error ? <div className="explorer-empty"><p role="alert">{documentData.error}</p><button onClick={refresh}>重新讀取檔案</button></div>
              : <ExplorerEditor key={`${state.active}:${revision}`} path={state.active} text={documentData.text!} sizeBytes={documentData.sizeBytes!} searchRequest={searchRequest}
                position={positions.current.get(state.active) ?? { top: 0, left: 0 }} onScroll={value => positions.current.set(state.active, value)} />}</div>
    </div>
    {notice && <p className="explorer-notice" role="status">{notice}</p>}
    {menu && <div ref={menuRef} role="menu" aria-label="檔案操作" className="explorer-context" style={{ left: Math.max(0, menu.x), top: Math.max(0, menu.y) }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.target.focus(); setMenu(undefined); }
    }}><button role="menuitem" onClick={() => void copyPath()}><Copy size={14} />複製相對路徑</button><input readOnly aria-label="專案相對路徑" value={menu.path} onFocus={event => event.currentTarget.select()} /></div>}
  </section>;
}
