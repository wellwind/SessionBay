import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, GitBranch, LoaderCircle, PanelRightClose, RefreshCw, X } from 'lucide-react';
import { useGitProject } from './use-git-project';
import { GitRepoSelector } from './GitRepoSelector';
import { GitChanges } from './GitChanges';
import type { IssueKind } from './types';
import { branchLabel, operationLabel } from './types';
import './git.css';

export interface GitWorkbenchProps {
  projectId: string;
  /** This project is the current one. */
  visible: boolean;
  sidebarVisible: boolean;
  sidebarHost: HTMLElement | null;
  onHideSidebar: () => void;
}

const issueTitle: Record<IssueKind, string> = {
  bare: '裸 repository', broken: '無法使用的 Git 目錄', dubiousOwnership: '目錄擁有者不受信任', submodule: '子模組',
};

export default function GitWorkbench(props: GitWorkbenchProps) {
  return <Workbench key={props.projectId} {...props} />;
}

function Workbench({ projectId, visible, sidebarVisible, sidebarHost, onHideSidebar }: GitWorkbenchProps) {
  const enabled = visible && sidebarVisible;
  const git = useGitProject(projectId, enabled);
  const { project, selectedRepo, selectedStatus } = git;
  const sidebar = useRef<HTMLElement>(null);
  const wasEnabled = useRef(false);
  useEffect(() => {
    // Returning to the tool picks up edits made while it was hidden.
    if (enabled && wasEnabled.current === false && project?.state === 'ready')
      for (const repo of project.repos) void git.refreshStatus(repo.id);
    wasEnabled.current = enabled;
  }, [enabled, project, git]);

  const body = () => {
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
      {selectedRepo && selectedStatus && <GitChanges status={selectedStatus} />}
    </>;
  };

  return <>{sidebarHost && createPortal(<aside ref={sidebar} hidden={!visible || !sidebarVisible} className="git-sidebar" aria-label="Git"
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as Element).closest('input, textarea, [role="menu"]')) {
        event.preventDefault(); event.stopPropagation(); onHideSidebar();
      }
    }}>
    <div className="project-files-heading"><strong>Git</strong><span />
      {git.discovering && project && <button aria-label="取消掃描" title="取消 repository 掃描" onClick={git.cancelDiscovery}><X size={15} /></button>}
      <button aria-label="重新整理 Git" title="重新尋找 repository 並讀取狀態" disabled={git.discovering} onClick={() => void git.discover()}>
        <RefreshCw size={15} className={git.discovering ? 'spin' : undefined} /></button>
      <button aria-label="收合 Git 面板" onClick={onHideSidebar}><PanelRightClose size={15} /></button>
    </div>
    <div className="git-sidebar-body">{body()}</div>
  </aside>, sidebarHost)}</>;
}
