import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, GitBranch, GitCompare, History, LoaderCircle, PanelRightClose, RefreshCw, ScrollText, X } from 'lucide-react';
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
import { GraphView } from './GraphView';
import { CommitPanel } from './CommitPanel';
import { BlameView } from './BlameView';
import { FileHistoryView } from './FileHistoryView';
import { SyncPanel } from './SyncPanel';
import { BranchesPanel } from './BranchesPanel';
import { StashPanel } from './StashPanel';
import { TagsPanel } from './TagsPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { DangerDialog } from './DangerDialog';
import { ResetDialog, RevertDialog } from './HistoryActions';
import { ConflictView } from './ConflictView';
import { OperationBar } from './OperationBar';
import { documentsReducer, emptyDocuments } from './git-documents';
import type { DocumentSpec, GitDocument } from './git-documents';
import { gitApi } from './git-api';
import type { CommitDetail, IssueKind, Outcome, Refs, RepoInfo, RepoPath, StatusEntry } from './types';
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

/** Collapsed sections mount their content (and its requests) when first opened. */
export function Section({ title, children, open = true, actions }: { title: string; children: ReactNode; open?: boolean; actions?: ReactNode }) {
  // Once opened, content stays mounted so drafts survive collapsing.
  const [opened, setOpened] = useState(open);
  return <details className="git-section" open={open} onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary><span>{title}</span>{actions && <span className="git-section-actions" onClick={event => event.preventDefault()}>{actions}</span>}</summary>
    {opened && <div className="git-section-body">{children}</div>}
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

  const [historyAction, setHistoryAction] = useState<{ kind: 'reset' | 'revert'; repo: RepoInfo; commit: CommitDetail } | null>(null);
  const [discarding, setDiscarding] = useState<{ repo: RepoInfo; entries: StatusEntry[] } | null>(null);
  const handleOutcome = (repoId: string) => (outcome: Outcome | { error: string }) => {
    if ('error' in outcome) setMessage({ tone: 'error', text: outcome.error });
    else setMessage({ tone: outcome.conflicts ? 'error' : 'success',
      text: `${outcome.message}${outcome.recovery ? '（已建立復原點，可在「復原點」還原）' : ''}` });
    void git.refreshStatus(repoId);
    void loadRefs(repoId);
  };
  const commitActions = (repo: RepoInfo) => (detail: CommitDetail) => git.statuses[repo.id]?.branch.oid ? <>
    <button onClick={() => setHistoryAction({ kind: 'revert', repo, commit: detail })}>Revert…</button>
    <button className="danger" disabled={detail.oid === git.statuses[repo.id]?.branch.oid}
      onClick={() => setHistoryAction({ kind: 'reset', repo, commit: detail })}>Reset 到此…</button>
  </> : null;
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
    const openCommit = (commit: string) => open(repo, { kind: 'comparison', source: { kind: 'commit', commit, parent: null } });
    const openBlame = (path: RepoPath, rev: string | null) => open(repo, { kind: 'blame', path, rev });
    const openHistory = (path: RepoPath) => open(repo, { kind: 'fileHistory', path });
    switch (spec.kind) {
      case 'diff': return <DiffView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} path={spec.path} oldPath={spec.oldPath}
        source={spec.source} untracked={spec.untracked} revision={status?.revision} preferences={preferences} onPreferences={setPreferences}
        onSource={spec.source.kind === 'commit' || spec.source.kind === 'compare' ? undefined : source => replace({ ...spec, source })}
        onChanged={() => void git.refreshStatus(repo.id)}
        actions={!spec.untracked && <>
          <button className="git-icon-button" aria-label={`Blame ${spec.path.path}`} title="Blame（逐行作者）"
            onClick={() => openBlame(spec.path, spec.source.kind === 'commit' ? spec.source.commit : null)}><ScrollText size={14} /></button>
          <button className="git-icon-button" aria-label={`${spec.path.path} 的歷史`} title="檔案歷史" onClick={() => openHistory(spec.path)}><History size={14} /></button>
        </>} />;
      case 'comparison': return spec.source.kind === 'commit'
        ? <CommitPanel key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} commit={spec.source.commit}
          preferences={preferences} onPreferences={setPreferences} onSelectCommit={openCommit} actions={commitActions(repo)} />
        : <ComparisonView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} source={spec.source}
          preferences={preferences} onPreferences={setPreferences} onSource={source => replace({ ...spec, source })} />;
      case 'graph': return <GraphView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} headOid={status?.branch.oid ?? null}
        preferences={preferences} onPreferences={setPreferences} onOpenComparison={openCommit} commitActions={commitActions(repo)} />;
      case 'blame': return <BlameView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} path={spec.path} rev={spec.rev}
        onOpenCommit={openCommit} onBlame={openBlame} onHistory={openHistory} />;
      case 'fileHistory': return <FileHistoryView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} path={spec.path}
        onBlame={openBlame} onOpenDiff={revision => open(repo, { kind: 'diff', path: revision.path, oldPath: null, untracked: false,
          source: { kind: 'commit', commit: revision.commit.oid, parent: revision.commit.parents.length > 1 ? 1 : null } })} />;
      case 'conflict': return <ConflictView key={document.key} projectId={projectId} repoId={repo.id} repoName={repo.name} path={spec.path}
        revision={status?.revision} onChanged={() => void git.refreshStatus(repo.id)} />;
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
      {selectedRepo && selectedStatus?.operation && <OperationBar projectId={projectId} repo={selectedRepo} status={selectedStatus}
        onOutcome={handleOutcome(selectedRepo.id)} />}
      {message && <p className={message.tone === 'success' ? 'git-success' : 'git-error'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      {selectedRepo && selectedStatus && <Section title="變更">
        <GitChanges status={selectedStatus} actions={{
          busy, activeKey: activeEntryKey,
          onOpen: (entry, group) => openEntry(selectedRepo, entry, group),
          onStage: entries => void mutate(selectedRepo.id, entries.length > 1 ? `已暫存 ${entries.length} 個檔案。` : `已暫存 ${entries[0].path.path}。`,
            () => gitApi.stagePaths(projectId, selectedRepo.id, entries.map(entry => entry.path))),
          onUnstage: entries => void mutate(selectedRepo.id, entries.length > 1 ? `已取消暫存 ${entries.length} 個檔案。` : `已取消暫存 ${entries[0].path.path}。`,
            () => gitApi.unstagePaths(projectId, selectedRepo.id, entries.flatMap(entry => entry.origPath ? [entry.path, entry.origPath] : [entry.path]))),
          onDiscard: entries => setDiscarding({ repo: selectedRepo, entries }),
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
      {selectedRepo && selectedStatus && <Section title="Branches" open={false}>
        <BranchesPanel projectId={projectId} repo={selectedRepo} status={selectedStatus} refs={refs[selectedRepo.id] ?? null}
          onOutcome={handleOutcome(selectedRepo.id)}
          onCompare={(base, head) => open(selectedRepo, { kind: 'comparison', source: { kind: 'compare', base, head, mergeBase: true } })} />
      </Section>}
      {selectedRepo && selectedStatus && <Section title={`Stash${selectedStatus.stashCount ? `（${selectedStatus.stashCount}）` : ''}`} open={false}>
        <StashPanel projectId={projectId} repo={selectedRepo} status={selectedStatus} onOutcome={handleOutcome(selectedRepo.id)} />
      </Section>}
      {selectedRepo && <Section title="Tags" open={false}>
        <TagsPanel projectId={projectId} repo={selectedRepo} refs={refs[selectedRepo.id] ?? null} onOutcome={handleOutcome(selectedRepo.id)} />
      </Section>}
      {selectedRepo && <Section title="復原點" open={false}>
        <RecoveryPanel projectId={projectId} repo={selectedRepo} revision={selectedStatus?.revision} onRestored={result => {
          setMessage(result); void git.refreshStatus(selectedRepo.id); void loadRefs(selectedRepo.id);
        }} />
      </Section>}
      {selectedRepo && <Section title="歷史">
        <div className="git-row">
          <button onClick={() => open(selectedRepo, { kind: 'graph' })}><GitBranch size={14} aria-hidden="true" />開啟歷史 graph</button>
        </div>
      </Section>}
      {historyAction && git.statuses[historyAction.repo.id] && (historyAction.kind === 'reset'
        ? <ResetDialog projectId={projectId} repo={historyAction.repo} status={git.statuses[historyAction.repo.id]} commit={historyAction.commit}
          onOutcome={handleOutcome(historyAction.repo.id)} onClose={() => setHistoryAction(null)} />
        : <RevertDialog projectId={projectId} repo={historyAction.repo} status={git.statuses[historyAction.repo.id]} commit={historyAction.commit}
          onOutcome={handleOutcome(historyAction.repo.id)} onClose={() => setHistoryAction(null)} />)}
      {discarding && <DangerDialog title={`捨棄 ${discarding.entries.length} 個檔案的變更？`} confirmLabel="捨棄變更"
        acknowledge={`我了解 ${discarding.repo.name} 這些檔案的未提交變更會被移除`}
        impact={<ul>{discarding.entries.map(entry => <li key={pathKey(entry.path)}>{entry.untracked ? '刪除未追蹤檔案' : '還原為 index 版本'}：<code>{entry.path.path}</code></li>)}</ul>}
        recovery="自動建立復原點：保存 tracked 工作檔的未提交變更與 index，並逐位元組備份要刪除的 untracked 檔案（上限 50 MB）；備份失敗則不會刪除。"
        onClose={() => setDiscarding(null)}
        onConfirm={async () => handleOutcome(discarding.repo.id)(await gitApi.discard(projectId, { repoId: discarding.repo.id,
          paths: discarding.entries.filter(entry => !entry.untracked).map(entry => entry.path),
          untracked: discarding.entries.filter(entry => entry.untracked).map(entry => entry.path) }))} />}
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
