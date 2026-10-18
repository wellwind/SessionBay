import { useEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, PanelLeftClose, PanelRightClose, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../api';
import { ExplorerTree, FileIcon } from './ExplorerTree';
import { ExplorerEditor } from './ExplorerEditor';
import type { ScrollPosition } from './ExplorerEditor';
import { ProjectFileTabs } from './ProjectFileTabs';
import { emptyFileTabs, fileTabsReducer } from './explorer-model';
import './explorer.css';
import './project-files.css';

export interface WorkspaceFilesProps {
  sidebarSide?: 'left' | 'right';
  projectId: string; visible: boolean; active: boolean; sidebarVisible: boolean;
  sidebarHost: HTMLElement | null; tabsHost: HTMLElement | null; documentHost: HTMLElement | null;
  onActivate: () => void; onEmpty: () => void; onHideSidebar: () => void;
}
interface DocumentData { path: string; text?: string; sizeBytes?: number; error?: string }
export function WorkspaceFiles(props: WorkspaceFilesProps) {
  return <Explorer key={props.projectId} {...props} />;
}
function Explorer({ sidebarSide = 'left', projectId, visible, active, sidebarVisible, sidebarHost, tabsHost, documentHost, onActivate, onEmpty, onHideSidebar }: WorkspaceFilesProps) {
  const [state, dispatch] = useReducer(fileTabsReducer, emptyFileTabs);
  const [revision, setRevision] = useState(0);
  const [treeWidth, setTreeWidth] = useState(240);
  const [searchRequest, setSearchRequest] = useState(0);
  const [documentData, setDocument] = useState<DocumentData>();
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; target: HTMLElement }>();
  const sidebar = useRef<HTMLElement>(null);
  const documentRoot = useRef<HTMLElement>(null);
  const tabRoot = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const documents = useRef(new Map<string, DocumentData>());
  const positions = useRef(new Map<string, ScrollPosition>());
  const latest = useRef({ visible, active, sidebarVisible, state }); latest.current = { visible, active, sidebarVisible, state };
  const resize = useRef<{ x: number; width: number } | undefined>(undefined);
  const focusGeneration = useRef(0);
  useEffect(() => {
    const tracker = focusGeneration;
    const moved = () => { tracker.current++; };
    document.addEventListener('focusin', moved);
    return () => { tracker.current++; document.removeEventListener('focusin', moved); };
  }, []);
  const open = (path: string, pinned = false) => {
    focusGeneration.current++; setNotice(''); setSearchRequest(0); dispatch({ type: 'open', path, pinned }); onActivate();
  };
  const closeFile = (path: string) => {
    const next = fileTabsReducer(state, { type: 'close', path });
    const owner = document.activeElement;
    const shouldFocus = tabRoot.current?.contains(owner) || documentRoot.current?.contains(owner);
    const generation = ++focusGeneration.current;
    dispatch({ type: 'close', path });
    if (active && state.tabs.length && !next.tabs.length) onEmpty();
    if (shouldFocus) requestAnimationFrame(() => {
      // A later focus owner, navigation, dialog, or unmount supersedes this close.
      if (focusGeneration.current !== generation || !latest.current.visible || latest.current.state.active !== next.active
        || document.querySelector('[role="dialog"], dialog[open]')
        || (document.activeElement !== owner && document.activeElement !== document.body)) return;
      if (next.tabs.length) {
        if (latest.current.active !== active) return;
        tabRoot.current?.querySelector<HTMLButtonElement>('[role="tab"][tabindex="0"]')?.focus();
      } else if (latest.current.sidebarVisible) {
        // onEmpty intentionally changes the main view; the visible tree remains valid.
        sidebar.current?.querySelector<HTMLButtonElement>('[data-tree-row]:not(:disabled)')?.focus();
      }
    });
  };
  useEffect(() => {
    if (!visible || !active) return;
    const close = (event: Event) => { event.stopPropagation(); if (state.active) closeFile(state.active); };
    const element = documentRoot.current;
    element?.addEventListener('explorer-close-file', close);
    return () => element?.removeEventListener('explorer-close-file', close);
  });
  const keys = (event: KeyboardEvent) => {
    if (!visible || !active || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || document.querySelector('[role="dialog"], dialog[open]') || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'w') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat && state.active) closeFile(state.active);
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault(); event.stopPropagation(); setSearchRequest(value => value + 1);
    }
  };
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
  useEffect(() => {
    if (!menu || !visible || !sidebarVisible) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menu, visible, sidebarVisible]);
  const refresh = () => { documents.current.clear(); setDocument(undefined); setRevision(value => value + 1); };
  const copyPath = async () => {
    if (!menu) return;
    const target = menu.target;
    try { await navigator.clipboard.writeText(menu.path); setNotice('已複製專案相對路徑。'); setMenu(undefined); target.focus(); }
    catch { setNotice('無法存取剪貼簿，請選取下方路徑後複製。'); }
  };
  const clampWidth = (width: number) => Math.max(160, Math.min(480, width));
  return <>
    {sidebarHost && createPortal(<aside ref={sidebar} hidden={!visible || !sidebarVisible} className="project-files-sidebar explorer" data-side={sidebarSide} aria-label="專案檔案" style={{ width: treeWidth }} onKeyDown={event => { keys(event); if (event.key === 'Escape' && !menu) { event.preventDefault(); event.stopPropagation(); onHideSidebar(); } }}>
      <div className="project-files-heading"><strong>檔案</strong><span />
        <button aria-label="重新整理檔案" title="重新讀取目錄與檔案" onClick={refresh}><RefreshCw size={15} /></button>
        <button aria-label="收合目錄樹" onClick={onHideSidebar}>{sidebarSide === 'right' ? <PanelRightClose size={15} /> : <PanelLeftClose size={15} />}</button></div>
      <div className="explorer-tree-pane"><ExplorerTree key={`${projectId}:${revision}`} projectId={projectId} showHidden selected={state.active} onOpen={open}
        onMenu={(path, target, x, y) => setMenu({ path, target, x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 110) })} /></div>
      <div role="separator" aria-label="調整目錄樹寬度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={480} aria-valuenow={treeWidth} tabIndex={0} className="project-files-resize"
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize.current = { x: event.clientX, width: treeWidth }; }}
        onPointerMove={event => { if (resize.current && event.currentTarget.hasPointerCapture(event.pointerId)) setTreeWidth(clampWidth(resize.current.width + (event.clientX - resize.current.x) * (sidebarSide === 'right' ? -1 : 1))); }}
        onPointerUp={event => { resize.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resize.current = undefined; }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setTreeWidth(value => event.key === 'Home' ? 160 : event.key === 'End' ? 480 : clampWidth(value + (event.key === 'ArrowRight' ? 16 : -16) * (sidebarSide === 'right' ? -1 : 1))); } }} />
      {notice && <p className="explorer-notice" role="status">{notice}</p>}
      {menu && <div ref={menuRef} role="menu" aria-label="檔案操作" className="explorer-context" style={{ left: Math.max(0, menu.x), top: Math.max(0, menu.y) }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.target.focus(); setMenu(undefined); }
      }}><button role="menuitem" onClick={() => void copyPath()}><Copy size={14} />複製相對路徑</button><input readOnly aria-label="專案相對路徑" value={menu.path} onFocus={event => event.currentTarget.select()} /></div>}
    </aside>, sidebarHost)}
    {tabsHost && createPortal(<div ref={tabRoot} className="project-file-tabs-group" hidden={!visible} onKeyDown={keys}>
      <ProjectFileTabs state={state} active={active} dispatch={action => { if (action.type === 'open') open(action.path, action.pinned); else dispatch(action); }} close={closeFile} />
    </div>, tabsHost)}
    {documentHost && createPortal(<section ref={documentRoot} hidden={!visible || !active} className="project-files-document explorer" data-file-explorer={visible && active ? '' : undefined} aria-label="工作區檔案預覽" onKeyDown={keys}>
      {state.notice && <p role="status">{state.notice}</p>}
      {!state.active ? <div className="explorer-empty"><FileIcon path="readme.txt" /><strong>開啟檔案閱讀</strong><p>單擊預覽，雙擊固定分頁。<br />只讀取原始文字，不執行內容。</p><small>專案目錄 · 每檔上限 256 KiB</small></div>
        : !documentData || documentData.path !== state.active ? <p role="status">讀取檔案中…</p>
          : documentData.error ? <div className="explorer-empty"><p role="alert">{documentData.error}</p><button onClick={refresh}>重新讀取檔案</button></div>
            : <ExplorerEditor key={`${state.active}:${revision}`} path={state.active} text={documentData.text!} sizeBytes={documentData.sizeBytes!} searchRequest={searchRequest}
              position={positions.current.get(state.active) ?? { top: 0, left: 0 }} onScroll={value => positions.current.set(state.active, value)} />}
    </section>, documentHost)}
  </>;
}
