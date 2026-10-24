import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, GitBranch, GitCompare, LoaderCircle, PanelRightClose, RefreshCw, X } from 'lucide-react';
import { errorMessage } from '../api';
import { useGitProject } from './use-git-project';
import { GitRepoSelector } from './GitRepoSelector';
import { GitChanges } from './GitChanges';
import type { ChangeGroup } from './GitChanges';
import { GitDocumentTabs } from './GitDocumentTabs';
import { DiffView } from './DiffView';
import type { DiffPreferences } from './DiffView';
import { ComparisonView } from './ComparisonView';
import { CompareForm } from './CompareForm';
import { CommitBox } from './CommitBox';
import { SyncPanel } from './SyncPanel';
import { documentsReducer, emptyDocuments } from './git-documents';
import type { DocumentSpec, GitDocument } from './git-documents';
import { gitApi } from './git-api';
import type { IssueKind, Refs, RepoInfo, StatusEntry } from './types';
import { branchLabel, operationLabel, pathKey } from './types';
import './git.css';

export interface GitWorkbenchProps {
  projectId: string;
  /** This project is the current one. */
  visible: boolean;
  /** The central Git view is the current main view. */
  active: boolean;
  sidebarVisible: boolean;
  sidebarHost: HTMLElement | null;
  tabsHost: HTMLElement | null;
  documentHost: HTMLElement | null;
  onActivate: () => void;
  onEmpty: () => void;
  onHideSidebar: () => void;
  onDocumentsChange?: (projectId: string, count: number) => void;
}

const issueTitle: Record<IssueKind, string> = {
  bare: '裸 repository', broken: '無法使用的 Git 目錄', dubiousOwnership: '目錄擁有者不受信任', submodule: '子模組',
};

export default function GitWorkbench(props: GitWorkbenchProps) {
  return <Workbench key={props.projectId} {...props} />;
}

export function Section({ title, children, open = true, actions }: { title: string; children: ReactNode; open?: boolean; actions?: ReactNode }) {
  return <details className="git-section" open={open}>
    <summary><span>{title}</span>{actions && <span className="git-section-actions" onClick={event => event.preventDefault()}>{actions}</span>}</summary>
    <div className="git-section-body">{children}</div>
  </details>;
}

function Workbench({ projectId, visible, active, sidebarVisible, sidebarHost, tabsHost, documentHost, onActivate, onEmpty, onHideSidebar, onDocumentsChange }: GitWorkbenchProps) {
  const [documents, dispatch] = useReducer(documentsReducer, emptyDocuments);
  const enabled = visible && (sidebarVisible || active);
  const git = useGitProject(projectId, enabled);
  const { project, selectedRepo, selectedStatus } = git;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [preferences, setPreferences] = useState<DiffPreferences>({ mode: 'split', ignoreWhitespace: false });
  const [refs, setRefs] = useState<Record<string, Refs>>({});
  const tabRoot = useRef<HTMLDivElement>(null);
  const documentRoot = useRef<HTMLElement>(null);
  const wasEnabled = useRef(false);

  useEffect(() => { onDocumentsChange?.(projectId, documents.documents.length); }, [projectId, documents.documents.length, onDocumentsChange]);
  useEffect(() => {
    if (enabled && !wasEnabled.current && project?.state === 'ready')
      for (const repo of project.repos) void git.refreshStatus(repo.id);
    wasEnabled.current = enabled;
  }, [enabled, project, git]);
  // Views of repositories that disappeared from discovery are closed.
  useEffect(() => {
    if (project?.state !== 'ready') return;
    const gone = [...new Set(documents.documents.map(document => document.repoId))].filter(id => !project.repos.some(repo => repo.id === id));
    if (gone.length) dispatch({ type: 'closeRepo', repoIds: gone });
  }, [project, documents.documents]);

  const loadRefs = useCallback(async (repoId: string) => {
    try { const next = await gitApi.refs(projectId, repoId); setRefs(previous => ({ ...previous, [repoId]: next })); }
    catch { /* Refs only feed suggestions; status errors are reported elsewhere. */ }
  }, [projectId]);
  useEffect(() => { if (enabled && selectedRepo) void loadRefs(selectedRepo.id); }, [enabled, selectedRepo, selectedStatus?.revision, loadRefs]);

  const open = (repo: RepoInfo, spec: DocumentSpec) => {
    dispatch({ type: 'open', repoId: repo.id, repoName: repo.name, spec });
    onActivate();
  };
  const close = (key: string) => {
    const remaining = documents.documents.filter(document => document.key !== key).length;
    dispatch({ type: 'close', key });
    if (!remaining && active) onEmpty();
  };
  useEffect(() => {
    if (!visible || !active) return;
    const element = documentRoot.current;
    const handler = (event: Event) => { event.stopPropagation(); if (documents.active) close(documents.active); };
    element?.addEventListener('git-close-document', handler);
    return () => element?.removeEventListener('git-close-document', handler);
  });

  const mutate = async (repoId: string, label: string, action: () => Promise<unknown>) => {
    setBusy(true); setMessage(null);
    try { await action(); setMessage({ tone: 'success', text: label }); }
    catch (failure) { setMessage({ tone: 'error', text: errorMessage(failure) }); }
    finally { setBusy(false); await git.refreshStatus(repoId); }
  };
  const openEntry = (repo: RepoInfo, entry: StatusEntry, group: ChangeGroup) => {
    if (group === 'conflicts') { open(repo, { kind: 'conflict', path: entry.path }); return; }
    open(repo, { kind: 'diff', path: entry.path, oldPath: entry.origPath ?? null, untracked: entry.untracked,
      source: { kind: group === 'staged' ? 'staged' : 'unstaged' } });
  };
  const activeDocument = documents.documents.find(document => document.key === documents.active) ?? null;
  const activeEntryKey = activeDocument?.spec.kind === 'diff' && activeDocument.repoId === selectedRepo?.id
    ? `${activeDocument.spec.source.kind === 'staged' ? 'staged' : activeDocument.spec.untracked ? 'untracked' : 'unstaged'}:${pathKey(activeDocument.spec.path)}` : null;

  const renderDocument = (document: GitDocument) => {
    const repo = project?.state === 'ready' ? project.repos.find(item => item.id === document.repoId) : undefined;
    if (!repo) return <p className="git-muted git-pad">此 repository 已不在專案中。</p>;
    const status = git.statuses[repo.id];
    const replace = (spec: DocumentSpec) => dispatch({ type: 'replace', key: document.key, spec });
    const spec = document.spec;
    switch (spec.kind) {
      case 'diff': return <DiffView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} path={spec.path} oldPath={spec.oldPath}
        source={spec.source} untracked={spec.untracked} revision={status?.revision} preferences={preferences} onPreferences={setPreferences}
        onSource={source => replace({ ...spec, source })} onChanged={() => void git.refreshStatus(repo.id)} />;
      case 'comparison': return <ComparisonView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} source={spec.source}
        preferences={preferences} onPreferences={setPreferences} onSource={source => replace({ ...spec, source })} />;
      default: return <p className="git-muted git-pad">此檢視尚未提供。</p>;
    }
  };

  const sidebarBody = () => {
    if (!project) return git.discoveryError
      ? <div className="git-empty" role="alert"><AlertTriangle size={18} aria-hidden="true" /><p>{git.discoveryError}</p>
        <button onClick={() => void git.discover()}>重試</button></div>
      : <div className="git-empty" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><p>正在尋找 Git repository…</p>
        <button onClick={git.cancelDiscovery}>取消掃描</button></div>;
    if (project.state === 'unavailable') return <div className="git-empty" role="status">
      <AlertTriangle size={18} aria-hidden="true" /><p>{project.message}</p><p className="git-muted">安裝 Git 後重新整理即可使用 Git 工具。</p></div>;
    return <>
      {project.repos.length === 0 && <div className="git-empty" role="status"><GitBranch size={18} aria-hidden="true" />
        <p>此專案沒有可操作的 Git 工作目錄。</p>
        <p className="git-muted">只有 Git 確認的工作目錄才會提供 Git 操作。</p></div>}
      {project.repos.length > 0 && <GitRepoSelector repos={project.repos} statuses={git.statuses} errors={git.statusErrors}
        selectedId={git.selectedId} onSelect={git.setSelectedId} />}
      {(project.truncated || project.cancelled) && <p className="git-notice" role="status">
        {project.cancelled ? '掃描已取消；' : '專案目錄過大，掃描已在上限停止；'}可能還有未列出的巢狀 repository。</p>}
      {project.issues.length > 0 && <details className="git-issues">
        <summary>{project.issues.length} 個未提供操作的位置</summary>
        <ul>{project.issues.map(issue => <li key={`${issue.kind}:${issue.relativePath}`}>
          <strong>{issueTitle[issue.kind]}</strong> <code>{issue.relativePath || '.'}</code><p>{issue.message}</p></li>)}</ul>
      </details>}
      {selectedRepo && <div className="git-context" aria-live="polite">
        <span className="git-context-repo" title={selectedRepo.root}>{selectedRepo.name}</span>
        {selectedStatus && <>
          <span title="目前 branch"><GitBranch size={12} aria-hidden="true" />{branchLabel(selectedStatus.branch)}</span>
          {selectedStatus.branch.upstream && <span className="git-muted" title="upstream">→ {selectedStatus.branch.upstream}</span>}
          {selectedStatus.operation && <span className="git-warning">{operationLabel[selectedStatus.operation]}</span>}
        </>}
      </div>}
      {selectedRepo && git.statusErrors[selectedRepo.id] && <p className="git-error" role="alert">{git.statusErrors[selectedRepo.id]}</p>}
      {message && <p className={message.tone === 'success' ? 'git-success' : 'git-error'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      {selectedRepo && selectedStatus && <Section title="變更">
        <GitChanges status={selectedStatus} actions={{
          busy, activeKey: activeEntryKey,
          onOpen: (entry, group) => openEntry(selectedRepo, entry, group),
          onStage: entries => void mutate(selectedRepo.id, entries.length > 1 ? `已暫存 ${entries.length} 個檔案。` : `已暫存 ${entries[0].path.path}。`,
            () => gitApi.stagePaths(projectId, selectedRepo.id, entries.map(entry => entry.path))),
          onUnstage: entries => void mutate(selectedRepo.id, entries.length > 1 ? `已取消暫存 ${entries.length} 個檔案。` : `已取消暫存 ${entries[0].path.path}。`,
            () => gitApi.unstagePaths(projectId, selectedRepo.id, entries.flatMap(entry => entry.origPath ? [entry.path, entry.origPath] : [entry.path]))),
        }} />
      </Section>}
      {selectedRepo && selectedStatus && <Section title="Commit">
        <CommitBox projectId={projectId} repo={selectedRepo} status={selectedStatus} onDone={text => {
          if (text) setMessage({ tone: 'success', text });
          void git.refreshStatus(selectedRepo.id);
        }} />
      </Section>}
      {selectedRepo && selectedStatus && <Section title="同步">
        <SyncPanel projectId={projectId} repo={selectedRepo} status={selectedStatus} refs={refs[selectedRepo.id] ?? null} onDone={result => {
          setMessage(result);
          void git.refreshStatus(selectedRepo.id);
          void loadRefs(selectedRepo.id);
        }} />
      </Section>}
      {selectedRepo && selectedStatus && <Section title="比較" open={false} actions={<GitCompare size={13} aria-hidden="true" />}>
        <CompareForm refs={refs[selectedRepo.id] ?? null} onCompare={(base, head, mergeBase) =>
          open(selectedRepo, { kind: 'comparison', source: { kind: 'compare', base, head, mergeBase } })} />
      </Section>}
    </>;
  };

  return <>
    {sidebarHost && createPortal(<aside hidden={!visible || !sidebarVisible} className="git-sidebar" aria-label="Git"
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as Element).closest('input, textarea, select, [role="menu"]')) {
          event.preventDefault(); event.stopPropagation(); onHideSidebar();
        }
      }}>
      <div className="project-files-heading"><strong>Git</strong><span />
        {git.discovering && project && <button aria-label="取消掃描" title="取消 repository 掃描" onClick={git.cancelDiscovery}><X size={15} /></button>}
        <button aria-label="重新整理 Git" title="重新尋找 repository 並讀取狀態" disabled={git.discovering} onClick={() => void git.discover()}>
          <RefreshCw size={15} className={git.discovering ? 'spin' : undefined} /></button>
        <button aria-label="收合 Git 面板" onClick={onHideSidebar}><PanelRightClose size={15} /></button>
      </div>
      <div className="git-sidebar-body">{sidebarBody()}</div>
    </aside>, sidebarHost)}
    {tabsHost && documents.documents.length > 0 && createPortal(<div ref={tabRoot} className="git-tabs-group" hidden={!visible}>
      <GitDocumentTabs state={documents} active={active} onActivate={key => { dispatch({ type: 'activate', key }); onActivate(); }} onClose={close} />
    </div>, tabsHost)}
    {documentHost && createPortal(<section ref={documentRoot} hidden={!visible || !active} className="git-document"
      data-git-workbench={visible && active ? '' : undefined} aria-label="Git 檢視">
      {activeDocument && visible && active ? renderDocument(activeDocument)
        : <div className="explorer-empty"><GitBranch size={28} aria-hidden="true" /><strong>從 Git 面板開啟差異或歷史</strong></div>}
    </section>, documentHost)}
  </>;
}
