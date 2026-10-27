import { useState } from 'react';
import { GitCompare, GitBranchPlus, GitMerge, Trash2 } from 'lucide-react';
import { MergeDialog } from './OperationBar';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Branch, Outcome, Refs, RepoInfo, RepoStatus } from './types';
import { t } from '../i18n';

/** Local and remote branches with repo context on every action. */
export function BranchesPanel({ projectId, repo, status, refs, onOutcome, onCompare }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; refs: Refs | null;
  onOutcome: (outcome: Outcome | { error: string }) => void; onCompare: (base: string, head: string) => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [switchTo, setSwitchTo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Branch | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [force, setForce] = useState(false);
  const [merging, setMerging] = useState<Branch | null>(null);
  const dirty = status.entries.some(entry => !entry.untracked);
  const blocked = status.operation ? t('An operation is in progress') : dirty ? t('The working tree has uncommitted changes') : '';
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    try { onOutcome(await action()); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); }
  };
  const local = refs?.branches.filter(branch => !branch.remote) ?? [];
  const remote = refs?.branches.filter(branch => branch.remote) ?? [];
  const current = local.find(branch => branch.current)?.name ?? 'HEAD';
  const row = (branch: Branch) => {
    const switchReason = branch.current ? t('Current branch') : branch.worktree ? t('Used by another worktree: {{path}}', { path: branch.worktree }) : blocked;
    return <li key={branch.fullName} className={`git-change${branch.current ? ' selected' : ''}`}>
      <button className="git-change-open" disabled={!!switchReason || busy} title={switchReason || t('Switch to {{branch}}', { branch: branch.name })}
        aria-label={`${branch.remote ? t('Create from remote and switch to {{branch}}', { branch: branch.name }) : t('Switch to {{branch}}', { branch: branch.name })}${branch.current ? t(' (current)') : ''}`}
        onClick={() => void run(() => gitApi.switchBranch(projectId, { repoId: repo.id, name: branch.name }))}>
        <span className="git-change-name">{branch.current ? '● ' : ''}{branch.name}</span>
        <span className="git-change-dir">
          {branch.upstreamGone ? t('upstream deleted') : branch.upstream ? `${branch.upstream}${branch.ahead ? ` ↑${branch.ahead}` : ''}${branch.behind ? ` ↓${branch.behind}` : ''}` : ''}
          {branch.worktree ? t(' · other worktree') : ''}
        </span>
      </button>
      <span className="git-change-actions">
        {!branch.current && <button aria-label={t('Compare {{current}} with {{branch}}', { current, branch: branch.name })} title={t('Compare {{current}}...{{branch}}', { current, branch: branch.name })}
          onClick={() => onCompare(current, branch.name)}><GitCompare size={14} /></button>}
        {!branch.current && status.branch.head && <button aria-label={t('Merge {{branch}} into {{current}}', { branch: branch.name, current })} title={t('Merge into {{current}}', { current })}
          disabled={!!blocked || busy} onClick={() => setMerging(branch)}><GitMerge size={14} /></button>}
        {!branch.remote && !branch.current && !branch.worktree && <button aria-label={t('Delete branch {{branch}}', { branch: branch.name })} title={t('Delete branch')}
          onClick={() => setDeleting(branch)}><Trash2 size={14} /></button>}
      </span>
    </li>;
  };
  return <div className="git-form">
    {blocked && <p className="git-muted">{t('{{reason}}, so branches cannot be switched for now.', { reason: blocked })}</p>}
    <ul className="git-file-list" aria-label={t('Local branches')}>{local.map(row)}</ul>
    {remote.length > 0 && <button className="git-link" aria-expanded={showRemote} onClick={() => setShowRemote(value => !value)}>
      {showRemote ? t('Hide remote branches ({{count}})', { count: remote.length }) : t('Show remote branches ({{count}})', { count: remote.length })}</button>}
    {showRemote && <ul className="git-file-list" aria-label={t('Remote branches')}>{remote.map(row)}</ul>}
    <form className="git-form git-inline-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) return;
      void run(() => gitApi.createBranch(projectId, { repoId: repo.id, name: name.trim(), start: start.trim() || null, switch: switchTo && !blocked })).then(() => setName(''));
    }}>
      <label className="git-field">{t('New branch name')}<input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="git-field">{t('Start point (defaults to HEAD)')}<input value={start} placeholder={status.branch.oid?.slice(0, 7) ?? 'HEAD'} onChange={event => setStart(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={switchTo} disabled={!!blocked} onChange={event => setSwitchTo(event.target.checked)} />{t('Switch after creating')}</label>
      <button type="submit" disabled={busy || !name.trim() || status.branch.unborn}><GitBranchPlus size={14} aria-hidden="true" />{t('Create branch')}</button>
    </form>
    {merging && <MergeDialog projectId={projectId} repo={repo} status={status} branch={merging} onClose={() => setMerging(null)}
      onOutcome={result => onOutcome(result)} />}
    {deleting && <DangerDialog title={t('Delete branch {{branch}}?', { branch: deleting.name })} confirmLabel={force ? t('Force delete branch') : t('Delete branch')}
      acknowledge={t('I understand branch {{branch}} in {{repo}} will be deleted', { repo: repo.name, branch: deleting.name })}
      impact={<p>{t('Local branch {{branch}} ({{commit}}) in repository {{repo}} will be deleted; remote branches are not affected.', { repo: repo.name, branch: deleting.name, commit: deleting.oid.slice(0, 7) })}</p>}
      recovery={t('A recovery point saves commit {{commit}} that the branch points to, so you can recreate the branch from "Recovery points".', { commit: deleting.oid.slice(0, 7) })}
      onClose={() => { setDeleting(null); setForce(false); }}
      onConfirm={async () => {
        const result = await gitApi.deleteBranch(projectId, { repoId: repo.id, name: deleting.name, expected: deleting.oid, force });
        onOutcome(result);
      }}>
      <label className="git-check"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
        {t('Delete even if not merged (-D)')}</label>
    </DangerDialog>}
  </div>;
}
