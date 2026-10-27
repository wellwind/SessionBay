import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Branch, Outcome, RepoInfo, RepoStatus } from './types';
import { operationLabel } from './types';
import { t } from '../i18n';

const abortEffect: Record<string, string> = {
  merge: t('Returns to the commit and files from before the merge; anything resolved in this merge is discarded.'),
  rebase: t('Returns the branch to where it was before the rebase; replayed and resolved commits are discarded.'),
  cherryPick: t('Returns to the state before the cherry-pick.'), revert: t('Returns to the state before the revert.'), am: t('Returns to the state before applying patches.'), bisect: t('Ends the bisect and returns to the commit it started from.'),
};

/** Continue/abort for an in-progress merge, rebase, cherry-pick or revert. */
export function OperationBar({ projectId, repo, status, onOutcome }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onOutcome: (outcome: Outcome | { error: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [aborting, setAborting] = useState(false);
  if (!status.operation) return null;
  const conflicts = status.entries.filter(entry => entry.conflict).length;
  return <div className="git-operation" role="region" aria-label={operationLabel[status.operation]}>
    <strong className="git-warning">{operationLabel[status.operation]}</strong>
    <span className="git-muted">{conflicts ? t('{{count}} conflicted files to resolve', { count: conflicts }) : t('Conflicts resolved; you can continue')}</span>
    <div className="git-row">
      {status.operation !== 'bisect' && <button className="primary" disabled={busy || conflicts > 0} title={conflicts ? t('Resolve all conflicts first') : undefined}
        onClick={() => {
          setBusy(true);
          gitApi.continueOperation(projectId, { repoId: repo.id }).then(onOutcome, failure => onOutcome({ error: errorMessage(failure) })).finally(() => setBusy(false));
        }}>Continue</button>}
      <button className="danger" disabled={busy} onClick={() => setAborting(true)}>Abort…</button>
    </div>
    {aborting && <DangerDialog title={t('Abort {{operation}}?', { operation: operationLabel[status.operation].replace(t(' in progress'), '') })} confirmLabel="Abort"
      acknowledge={t('I understand the in-progress result will be discarded')}
      impact={<p>{repo.name}：{abortEffect[status.operation]}</p>}
      recovery={t('A recovery point is created before aborting. It saves the contents of modified files in the working tree (the conflicted index state cannot be saved).')}
      onClose={() => setAborting(false)}
      onConfirm={async () => onOutcome(await gitApi.abortOperation(projectId, { repoId: repo.id }))} />}
  </div>;
}

export function MergeDialog({ projectId, repo, status, branch, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; branch: Branch;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [noFf, setNoFf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={t('Merge {{branch}}?', { branch: branch.name })} onClose={() => { if (!busy) onClose(); }}>
    <p>{t('Merges {{branch}} ({{commit}}) into {{target}} in {{repo}}.', { branch: branch.name, commit: branch.oid.slice(0, 7), repo: repo.name, target: status.branch.head ?? 'HEAD' })}</p>
    <label className="git-check"><input type="checkbox" checked={noFf} onChange={event => setNoFf(event.target.checked)} />{t('Always create a merge commit (--no-ff)')}</label>
    <p className="git-muted">{t('If there are conflicts, the merge stays in progress. Resolve each file in the Git panel, then Continue, or Abort to go back.')}</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button className="primary" data-dialog-confirm disabled={busy} onClick={() => {
        setBusy(true); setError('');
        gitApi.merge(projectId, { repoId: repo.id, rev: branch.fullName, noFf, expectedHead: status.branch.oid ?? '' })
          .then(result => { onOutcome(result); onClose(); }, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>{t('Merge')}</button>
    </div>
  </Dialog>;
}
