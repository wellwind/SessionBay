import type { FileReference } from '../types';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, PanelLeftClose, PanelRightClose, RefreshCw } from 'lucide-react';
import { ExplorerTree, FileIcon } from './ExplorerTree';
import { FileDocument } from './FileDocument';
import { clearFileCache } from './file-reader';
import type { ScrollPosition } from './ExplorerEditor';
import { ProjectFileTabs } from './ProjectFileTabs';
import { emptyFileTabs, fileTabsReducer } from './explorer-model';
import './explorer.css';
import './project-files.css';
import { t } from '../i18n';

export interface WorkspaceFilesProps {
  openRequest?: { path: string; nonce: number; reference?: FileReference };
  onTabsChange?: (projectId: string, paths: string[]) => void;
  sidebarSide?: 'left' | 'right';
  projectId: string; visible: boolean; active: boolean; sidebarVisible: boolean;
  sidebarHost: HTMLElement | null; tabsHost: HTMLElement | null; documentHost: HTMLElement | null;
  onActivate: () => void; onEmpty: () => void; onHideSidebar: () => void;
}
export function WorkspaceFiles(props: WorkspaceFilesProps) {
  return <Explorer key={props.projectId} {...props} />;
}
function Explorer({ openRequest, onTabsChange, sidebarSide = 'left', projectId, visible, active, sidebarVisible, sidebarHost, tabsHost, documentHost, onActivate, onEmpty, onHideSidebar }: WorkspaceFilesProps) {
  const [state, dispatch] = useReducer(fileTabsReducer, emptyFileTabs);
  const [revision, setRevision] = useState(0);
  const [searchRequest, setSearchRequest] = useState(0);
  const [notice, setNotice] = useState('');
  const [reference, setReference] = useState<(FileReference & { path: string })>();
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; target: HTMLElement }>();
  const sidebar = useRef<HTMLElement>(null);
  const documentRoot = useRef<HTMLElement>(null);
  const tabRoot = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, ScrollPosition>());
  const handledReference = useRef<number | undefined>(undefined);
  const latest = useRef({ visible, active, sidebarVisible, state }); latest.current = { visible, active, sidebarVisible, state };
  const focusGeneration = useRef(0);
  useEffect(() => {
    const tracker = focusGeneration;
    const moved = () => { tracker.current++; };
    document.addEventListener('focusin', moved);
    return () => { tracker.current++; document.removeEventListener('focusin', moved); };
  }, []);
  const open = (path: string, pinned = false, linked = false) => {
    if (!linked && openRequest?.reference) handledReference.current = openRequest.reference.nonce;
    focusGeneration.current++; setNotice(''); setSearchRequest(0); setReference(undefined); dispatch({ type: 'open', path, pinned }); onActivate();
  };
  useEffect(() => { onTabsChange?.(projectId, state.tabs.map(tab => tab.path)); }, [projectId, state.tabs, onTabsChange]);
  useEffect(() => {
    if (!openRequest) return;
    open(openRequest.path, true, true);
    if (openRequest.reference) setReference({ ...openRequest.reference, path: openRequest.path });
    const generation = focusGeneration.current;
    const frame = requestAnimationFrame(() => {
      if (generation !== focusGeneration.current || !latest.current.visible || !latest.current.active ||
        document.querySelector('[role="dialog"], dialog[open]')) return;
      tabRoot.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Each request is a new user intent; callback changes must not reopen files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);
  useEffect(() => {
    if (!visible || !active) {
      if (openRequest?.reference) handledReference.current = openRequest.reference.nonce;
      setReference(undefined);
    }
  }, [visible, active, openRequest]);
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
    for (const path of positions.current.keys()) if (!paths.has(path)) positions.current.delete(path);
  }, [state.tabs]);
  useEffect(() => {
    if (!menu || !visible || !sidebarVisible) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menu, visible, sidebarVisible]);
  const refresh = () => { clearFileCache(projectId); setRevision(value => value + 1); };
  const copyPath = async () => {
    if (!menu) return;
    const target = menu.target;
    try { await navigator.clipboard.writeText(menu.path); setNotice(t('Copied the project-relative path.')); setMenu(undefined); target.focus(); }
    catch { setNotice(t('Cannot access the clipboard; select the path below and copy it.')); }
  };
  return <>
    {sidebarHost && createPortal(<aside ref={sidebar} hidden={!visible || !sidebarVisible} className="project-files-sidebar explorer" data-side={sidebarSide} aria-label={t('Project files')} onKeyDown={event => { keys(event); if (event.key === 'Escape' && !menu) { event.preventDefault(); event.stopPropagation(); onHideSidebar(); } }}>
      <div className="project-files-heading"><strong>{t('Files')}</strong><span />
        <button aria-label={t('Refresh files')} title={t('Reload folders and files')} onClick={refresh}><RefreshCw size={15} /></button>
        <button aria-label={t('Collapse file tree')} onClick={onHideSidebar}>{sidebarSide === 'right' ? <PanelRightClose size={15} /> : <PanelLeftClose size={15} />}</button></div>
      <div className="explorer-tree-pane"><ExplorerTree key={`${projectId}:${revision}`} projectId={projectId} showHidden selected={state.active} onOpen={open}
        onMenu={(path, target, x, y) => setMenu({ path, target, x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 110) })} /></div>
      {notice && <p className="explorer-notice" role="status">{notice}</p>}
      {menu && <div ref={menuRef} role="menu" aria-label={t('File actions')} className="explorer-context" style={{ left: Math.max(0, menu.x), top: Math.max(0, menu.y) }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.target.focus(); setMenu(undefined); }
      }}><button role="menuitem" onClick={() => void copyPath()}><Copy size={14} />{t('Copy relative path')}</button><input readOnly aria-label={t('Project-relative path')} value={menu.path} onFocus={event => event.currentTarget.select()} /></div>}
    </aside>, sidebarHost)}
    {tabsHost && createPortal(<div ref={tabRoot} className="project-file-tabs-group" hidden={!visible} onKeyDown={keys}>
      <ProjectFileTabs state={state} active={active} dispatch={action => { if (action.type === 'open') open(action.path, action.pinned); else dispatch(action); }} close={closeFile} />
    </div>, tabsHost)}
    {documentHost && createPortal(<section ref={documentRoot} hidden={!visible || !active} className="project-files-document explorer" data-file-explorer={visible && active ? '' : undefined} aria-label={t('Workspace file preview')} onKeyDown={keys}>
      {state.notice && <p role="status">{state.notice}</p>}
      {!state.active ? <div className="explorer-empty"><FileIcon path="readme.txt" /><strong>{t('Open a file to read it')}</strong></div>
        : visible && active && <FileDocument key={`${state.active}:${revision}`} projectId={projectId} path={state.active} searchRequest={searchRequest}
          reference={reference?.path === state.active && reference.nonce !== handledReference.current ? reference
            : openRequest?.path === state.active && openRequest.reference?.nonce !== handledReference.current ? openRequest.reference : undefined}
          onReferenceHandled={nonce => { handledReference.current = nonce; setReference(current => current?.nonce === nonce ? undefined : current); }}
          position={positions.current.get(state.active) ?? { top: 0, left: 0 }} onScroll={value => positions.current.set(state.active, value)} />}

    </section>, documentHost)}
  </>;
}
