import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { CommitDetail, Outcome, RepoInfo, RepoStatus, ResetMode } from './types';
import { resetModeLabel } from './types';
import { t } from '../i18n';

/** Reset moves a branch; it is never presented as a generic "undo". */
export function ResetDialog({ projectId, repo, status, commit, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; commit: CommitDetail;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<ResetMode>('mixed');
  const dirty = status.entries.filter(entry => !entry.untracked).length;
  const head = status.branch.oid ?? '';
  return <DangerDialog title={t('Reset {{branch}} to {{commit}}?', { branch: status.branch.head ?? 'HEAD', commit: commit.oid.slice(0, 7) })} confirmLabel={`Reset --${mode}`}
    acknowledge={t('I understand {{branch}} will move to {{commit}}', { branch: status.branch.head ?? 'HEAD', commit: commit.oid.slice(0, 7) })}
    impact={<>
      <p>{t('Moves {{branch}} in repository {{repo}} from {{from}} to "{{subject}}" ({{commit}}). Later commits will no longer belong to this branch.', { repo: repo.name, branch: status.branch.head ?? 'detached HEAD', from: head.slice(0, 7), subject: commit.message.split('\n')[0], commit: commit.oid.slice(0, 7) })}</p>
      <p>{resetModeLabel[mode].detail}</p>
      {mode === 'hard' && dirty > 0 && <p className="git-warning">{t('Uncommitted changes in {{count}} tracked files will be overwritten.', { count: dirty })}</p>}
    </>}
    recovery={t('A recovery point is created automatically. It saves the HEAD and branch position, the index and uncommitted changes to tracked files. Untracked and ignored files are not affected by reset and are not included.')}
    onClose={onClose}
    onConfirm={async () => onOutcome(await gitApi.reset(projectId, { repoId: repo.id, target: commit.oid, mode, expectedHead: head }))}>
    <fieldset className="git-radio-row"><legend>{t('Mode')}</legend>
      {(Object.keys(resetModeLabel) as ResetMode[]).map(value => <label key={value}>
        <input type="radio" name="reset-mode" checked={mode === value} onChange={() => setMode(value)} />{resetModeLabel[value].title}</label>)}
    </fieldset>
  </DangerDialog>;
}

/** Revert adds a new commit that applies the reverse change. */
export function RevertDialog({ projectId, repo, status, commit, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; commit: CommitDetail;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [parent, setParent] = useState<number | null>(commit.parents.length > 1 ? null : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const merge = commit.parents.length > 1;
  return <Dialog title={t('Revert {{commit}}?', { commit: commit.oid.slice(0, 7) })} onClose={() => { if (!busy) onClose(); }}>
    <p>{t('Creates a new commit on {{branch}} in {{repo}} that reverses "{{subject}}". The original commit and history stay unchanged.', { repo: repo.name, branch: status.branch.head ?? 'detached HEAD', subject: commit.message.split('\n')[0] })}</p>
    {merge && <label className="git-field">{t('Mainline parent of the merge commit')}
      <select value={parent ?? ''} onChange={event => setParent(event.target.value ? Number(event.target.value) : null)}>
        <option value="">{t('Select…')}</option>
        {commit.parents.map((oid, index) => <option key={oid} value={index + 1}>parent {index + 1} · {oid.slice(0, 7)}</option>)}
      </select></label>}
    <p className="git-muted">{t('If reverting causes conflicts, the revert stays in progress; resolve them here, then continue or abort.')}</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button className="primary" data-dialog-confirm disabled={busy || (merge && !parent)} onClick={() => {
        setBusy(true); setError('');
        gitApi.revert(projectId, { repoId: repo.id, commit: commit.oid, parent, expectedHead: status.branch.oid ?? '' })
          .then(result => { onOutcome(result); onClose(); }, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>{t('Create revert commit')}</button>
    </div>
  </Dialog>;
}
