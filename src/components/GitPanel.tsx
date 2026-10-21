import { GitBranch, LoaderCircle, RefreshCw, Square, AlertTriangle } from 'lucide-react';
import { GIT_STATE_LABELS, KIND_LABELS, branchLabel, repositoryLocation, type GitWorkbenchState } from '../git';
import type { GitStatusSummary } from '../types';
import './git-panel.css';

function StatusLine({ status }: { status: GitStatusSummary | { error: string } | undefined }) {
  if (!status) return <span className="git-repo-status muted">讀取狀態中…</span>;
  if ('error' in status) return <span className="git-repo-status error" role="status">{status.error}</span>;
  const parts: string[] = [];
  if (status.ahead !== null || status.behind !== null) parts.push(`↑${status.ahead ?? 0} ↓${status.behind ?? 0}`);
  else if (!status.detached) parts.push('無 upstream');
  const counts = [
    status.staged ? `已暫存 ${status.staged}` : '',
    status.unstaged ? `未暫存 ${status.unstaged}` : '',
    status.untracked ? `未追蹤 ${status.untracked}` : '',
    status.conflicted ? `衝突 ${status.conflicted}` : '',
  ].filter(Boolean);
  parts.push(counts.length ? counts.join('、') : '沒有變更');
  if (status.limited) parts.push('數量過多，僅顯示下限');
  return <span className="git-repo-status">
    <span className="git-repo-branch"><GitBranch size={12} aria-hidden="true" />{branchLabel(status)}</span>
    <span>{parts.join(' · ')}</span>
  </span>;
}

/** Read-only G1 panel: repository selector with per-repo status summary. */
export function GitPanel({ git }: { git: GitWorkbenchState }) {
  const { discovery, scanning, error, statuses, selectedId } = git;
  const selected = discovery?.repositories.find(repo => repo.id === selectedId) ?? null;
  return <section className="git-panel" aria-label="Git">
    <header className="project-files-heading">
      <strong>Git</strong><span />
      {scanning
        ? <button type="button" className="icon-button" title="停止探測" aria-label="停止探測" onClick={git.cancel}><Square size={14} /></button>
        : <button type="button" className="icon-button" title="重新整理 Git 狀態" aria-label="重新整理 Git 狀態" onClick={git.refresh}><RefreshCw size={14} /></button>}
    </header>
    {scanning && <p className="git-panel-note" role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" /> 探測 repository 中…</p>}
    {error && <p className="git-panel-note error" role="alert">{error}</p>}
    {discovery?.cancelled && <p className="git-panel-note" role="status">探測已取消，清單可能不完整。</p>}
    {discovery?.truncated && !discovery.cancelled && <p className="git-panel-note" role="status">已達探測上限（{discovery.scannedDirectories} 個資料夾），清單可能不完整。</p>}
    {discovery && <div className="git-repo-list" role="listbox" aria-label="Repository">
      {discovery.repositories.map(repo => <div key={repo.id} id={`git-repo-${repo.id}`} role="option" tabIndex={0}
        aria-selected={repo.id === selectedId} className={`git-repo${repo.id === selectedId ? ' selected' : ''}`}
        title={repo.worktreeRoot}
        onClick={() => git.select(repo.id)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); git.select(repo.id); } }}>
        <span className="git-repo-name"><strong>{repo.name}</strong>
          {KIND_LABELS[repo.kind] && <em className="git-repo-kind">{KIND_LABELS[repo.kind]}</em>}</span>
        <span className="git-repo-path">{repositoryLocation(repo)}</span>
        <StatusLine status={statuses[repo.id]} />
      </div>)}
    </div>}
    {selected && <dl className="git-repo-detail" aria-label="目前 repository">
      <dt>工作目錄</dt><dd>{selected.worktreeRoot}</dd>
      <dt>gitdir</dt><dd>{selected.gitDir}</dd>
      {selected.commonDir !== selected.gitDir && <><dt>common dir</dt><dd>{selected.commonDir}</dd></>}
      {selected.superproject && <><dt>上層 repository</dt><dd>{selected.superproject}</dd></>}
    </dl>}
    {!!discovery?.issues.length && <div className="git-issues" aria-label="無法使用的 Git 位置">
      {discovery.issues.map(issue => <p key={issue.path} className="git-issue" title={issue.message ?? undefined}>
        <AlertTriangle size={12} aria-hidden="true" /> <span>{issue.path}</span>：{GIT_STATE_LABELS[issue.state]}
      </p>)}
    </div>}
    <p className="git-panel-note muted">G1 僅顯示狀態；暫存、commit 與 diff 尚未提供。切換 repository 不會變更 Agent 或 Terminal。</p>
  </section>;
}
