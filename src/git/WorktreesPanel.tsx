import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, Refs, RepoInfo, RepoStatus, WorktreeStatus } from './types';

const label = (worktree: WorktreeStatus) => worktree.branch ?? `detached @ ${worktree.head?.slice(0, 7) ?? '?'}`;

/** List, add and remove linked worktrees; each can open as its own project. */
export function WorktreesPanel({ projectId, repo, status, refs, onOutcome, onOpen }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; refs: Refs | null;
  onOutcome: (outcome: Outcome | { error: string }) => void;
  /** Opens a checkout as a project (and optionally starts new work there). */
  onOpen?: (path: string, startWork: boolean) => void;
}) {
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [create, setCreate] = useState(true);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [openAfter, setOpenAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<WorktreeStatus | null>(null);
  const load = useCallback(() => {
    gitApi.worktrees(projectId, repo.id).then(setWorktrees).catch(failure => onOutcome({ error: errorMessage(failure) }));
  }, [projectId, repo.id, onOutcome]);
  useEffect(() => { load(); }, [load, status.revision]);
  const used = new Set(worktrees.flatMap(worktree => worktree.branch ? [worktree.branch] : []));
  const free = (refs?.branches ?? []).filter(item => !item.remote && !used.has(item.name)).map(item => item.name);
  const name = create ? branch.trim() : branch || free[0] || '';

  return <div className="git-form">
    {worktrees.length > 0 && <ul className="git-file-list" aria-label="Worktree 清單">{worktrees.map(worktree => <li key={worktree.path} className="git-change">
      <span className="git-change-open" title={worktree.path}>
        <span className="git-change-name">{label(worktree)}</span>
        <span className="git-change-dir">{worktree.path}</span>
        {worktree.main && <span className="git-chip">主要</span>}
        {worktree.current && <span className="git-chip">目前</span>}
        {worktree.locked && <span className="git-chip">已鎖定</span>}
        {worktree.prunable && <span className="git-chip">已失效</span>}
        {worktree.dirty && <span className="git-chip">有變更</span>}
      </span>
      <span className="git-change-actions">
        {onOpen && !worktree.current && !worktree.prunable && <button disabled={busy} aria-label={`開啟 ${label(worktree)} 為專案`} title="開啟為專案"
          onClick={() => onOpen(worktree.path, false)}><FolderOpen size={14} /></button>}
        {!worktree.main && !worktree.current && !worktree.prunable && <button disabled={busy || worktree.locked} aria-label={`移除 worktree ${label(worktree)}`}
          title={worktree.locked ? '已鎖定，無法移除' : '移除 worktree（保留 branch）'} onClick={() => setRemoving(worktree)}><Trash2 size={14} /></button>}
      </span>
    </li>)}</ul>}
    {worktrees.some(worktree => worktree.prunable) && <button disabled={busy} onClick={() => {
      setBusy(true);
      gitApi.worktreePrune(projectId, { repoId: repo.id }).then(onOutcome, failure => onOutcome({ error: errorMessage(failure) }))
        .finally(() => { setBusy(false); load(); });
    }}>清理失效紀錄</button>}

    <form className="git-form" aria-label="新增 worktree" onSubmit={event => {
      event.preventDefault();
      if (!name) return;
      setBusy(true);
      gitApi.worktreeAdd(projectId, { repoId: repo.id, branch: name, create, base: create ? base.trim() || null : null, path: path.trim() || null })
        .then(added => {
          onOutcome({ message: `已在 ${added.path} 建立 worktree（${added.branch}）`, recovery: null, conflicts: false });
          setBranch(''); setBase(''); setPath('');
          if (openAfter) onOpen?.(added.path, true);
        }, failure => onOutcome({ error: errorMessage(failure) }))
        .finally(() => { setBusy(false); load(); });
    }}>
      <fieldset className="git-radio-row">
        <legend>Branch 來源</legend>
        <label className="git-check"><input type="radio" checked={create} onChange={() => { setCreate(true); setBranch(''); }} />新 branch</label>
        <label className="git-check"><input type="radio" checked={!create} disabled={!free.length} onChange={() => { setCreate(false); setBranch(free[0] ?? ''); }} />既有 branch</label>
      </fieldset>
      {create
        ? <label className="git-field">Branch 名稱<input value={branch} required placeholder="feature/login" onChange={event => setBranch(event.target.value)} /></label>
        : <label className="git-field">Branch<select value={name} onChange={event => setBranch(event.target.value)}>
            {free.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
      {create && <label className="git-field">起點（選填）<input value={base} placeholder={status.branch.head ?? 'HEAD'} onChange={event => setBase(event.target.value)} /></label>}
      <label className="git-field">路徑（選填）<input value={path} placeholder={`${repo.name}.worktrees/<branch>（與 repository 同層）`} onChange={event => setPath(event.target.value)} /></label>
      {onOpen && <label className="git-check"><input type="checkbox" checked={openAfter} onChange={event => setOpenAfter(event.target.checked)} />建立後開啟為專案並開始新工作</label>}
      <button type="submit" disabled={busy || !name}>建立 worktree</button>
    </form>

    {removing && <DangerDialog
      title={`移除 worktree ${label(removing)}？`}
      confirmLabel={removing.dirty ? 'Stash 變更並移除' : '移除 worktree'}
      acknowledge={removing.dirty ? '我了解變更會先存成 stash，資料夾會被移除' : '我了解資料夾會被移除'}
      impact={<p>{removing.path} 會從磁碟移除。Branch {removing.branch ?? '（detached）'} 保留，之後可以再建立 worktree。</p>}
      recovery={removing.dirty ? '未提交的變更（含 untracked 檔案）會先存成 stash，可在 Stash 區取回。' : null}
      onClose={() => setRemoving(null)}
      onConfirm={async () => {
        const result = await gitApi.worktreeRemove(projectId, { repoId: repo.id, path: removing.path, stash: removing.dirty === true });
        onOutcome(result); load();
      }} />}
  </div>;
}
