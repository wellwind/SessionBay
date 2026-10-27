import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, Refs, RepoInfo, RepoStatus, WorktreeStatus } from './types';
import { t } from '../i18n';

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
    {worktrees.length > 0 && <ul className="git-file-list" aria-label={t('Worktree list')}>{worktrees.map(worktree => <li key={worktree.path} className="git-change">
      <span className="git-change-open" title={worktree.path}>
        <span className="git-change-name">{label(worktree)}</span>
        <span className="git-change-dir">{worktree.path}</span>
        {worktree.main && <span className="git-chip">{t('Main')}</span>}
        {worktree.current && <span className="git-chip">{t('Current')}</span>}
        {worktree.locked && <span className="git-chip">{t('Locked')}</span>}
        {worktree.prunable && <span className="git-chip">{t('Stale')}</span>}
        {worktree.dirty && <span className="git-chip">{t('Has changes')}</span>}
      </span>
      <span className="git-change-actions">
        {onOpen && !worktree.current && !worktree.prunable && <button disabled={busy} aria-label={t('Open {{name}} as a project', { name: label(worktree) })} title={t('Open as project')}
          onClick={() => onOpen(worktree.path, false)}><FolderOpen size={14} /></button>}
        {!worktree.main && !worktree.current && !worktree.prunable && <button disabled={busy || worktree.locked} aria-label={t('Remove worktree {{name}}', { name: label(worktree) })}
          title={worktree.locked ? t('Locked; cannot be removed') : t('Remove worktree (keeps the branch)')} onClick={() => setRemoving(worktree)}><Trash2 size={14} /></button>}
      </span>
    </li>)}</ul>}
    {worktrees.some(worktree => worktree.prunable) && <button disabled={busy} onClick={() => {
      setBusy(true);
      gitApi.worktreePrune(projectId, { repoId: repo.id }).then(onOutcome, failure => onOutcome({ error: errorMessage(failure) }))
        .finally(() => { setBusy(false); load(); });
    }}>{t('Prune stale records')}</button>}

    <form className="git-form" aria-label={t('Add worktree')} onSubmit={event => {
      event.preventDefault();
      if (!name) return;
      setBusy(true);
      gitApi.worktreeAdd(projectId, { repoId: repo.id, branch: name, create, base: create ? base.trim() || null : null, path: path.trim() || null })
        .then(added => {
          onOutcome({ message: t('Created worktree at {{path}} ({{branch}})', { path: added.path, branch: added.branch }), recovery: null, conflicts: false });
          setBranch(''); setBase(''); setPath('');
          if (openAfter) onOpen?.(added.path, true);
        }, failure => onOutcome({ error: errorMessage(failure) }))
        .finally(() => { setBusy(false); load(); });
    }}>
      <fieldset className="git-radio-row">
        <legend>{t('Branch source')}</legend>
        <label className="git-check"><input type="radio" checked={create} onChange={() => { setCreate(true); setBranch(''); }} />{t('New branch')}</label>
        <label className="git-check"><input type="radio" checked={!create} disabled={!free.length} onChange={() => { setCreate(false); setBranch(free[0] ?? ''); }} />{t('Existing branch')}</label>
      </fieldset>
      {create
        ? <label className="git-field">{t('Branch name')}<input value={branch} required placeholder="feature/login" onChange={event => setBranch(event.target.value)} /></label>
        : <label className="git-field">Branch<select value={name} onChange={event => setBranch(event.target.value)}>
            {free.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
      {create && <label className="git-field">{t('Start point (optional)')}<input value={base} placeholder={status.branch.head ?? 'HEAD'} onChange={event => setBase(event.target.value)} /></label>}
      <label className="git-field">{t('Path (optional)')}<input value={path} placeholder={t('{{repo}}.worktrees/<branch> (next to the repository)', { repo: repo.name })} onChange={event => setPath(event.target.value)} /></label>
      {onOpen && <label className="git-check"><input type="checkbox" checked={openAfter} onChange={event => setOpenAfter(event.target.checked)} />{t('Open as a project and start new work after creating')}</label>}
      <button type="submit" disabled={busy || !name}>{t('Create worktree')}</button>
    </form>

    {removing && <DangerDialog
      title={t('Remove worktree {{name}}?', { name: label(removing) })}
      confirmLabel={removing.dirty ? t('Stash changes and remove') : t('Remove worktree')}
      acknowledge={removing.dirty ? t('I understand changes are stashed first and the folder will be removed') : t('I understand the folder will be removed')}
      impact={<p>{t('{{path}} will be removed from disk. Branch {{branch}} is kept, so you can create a worktree for it again later.', { path: removing.path, branch: removing.branch ?? t('(detached)') })}</p>}
      recovery={removing.dirty ? t('Uncommitted changes (including untracked files) are stashed first; get them back from Stash.') : null}
      onClose={() => setRemoving(null)}
      onConfirm={async () => {
        const result = await gitApi.worktreeRemove(projectId, { repoId: repo.id, path: removing.path, stash: removing.dirty === true });
        onOutcome(result); load();
      }} />}
  </div>;
}
