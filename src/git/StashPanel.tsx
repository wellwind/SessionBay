import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, RepoInfo, RepoStatus, StashEntry } from './types';
import { formatTime } from './types';
import { t } from '../i18n';

export function StashPanel({ projectId, repo, status, onOutcome }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onOutcome: (outcome: Outcome | { error: string }) => void;
}) {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [danger, setDanger] = useState<{ kind: 'drop'; entry: StashEntry } | { kind: 'clear' } | null>(null);
  const load = useCallback(() => {
    gitApi.stashes(projectId, repo.id).then(setStashes).catch(failure => onOutcome({ error: errorMessage(failure) }));
  }, [projectId, repo.id, onOutcome]);
  useEffect(() => { load(); }, [load, status.stashCount, status.revision]);
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    try { onOutcome(await action()); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); load(); }
  };
  return <div className="git-form">
    <form className="git-form" onSubmit={event => {
      event.preventDefault();
      void run(() => gitApi.stashPush(projectId, { repoId: repo.id, message, includeUntracked: untracked, keepIndex })).then(() => setMessage(''));
    }}>
      <label className="git-field">{t('Stash message')}<input value={message} onChange={event => setMessage(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={untracked} onChange={event => setUntracked(event.target.checked)} />{t('Include untracked files')}</label>
      <label className="git-check"><input type="checkbox" checked={keepIndex} onChange={event => setKeepIndex(event.target.checked)} />{t('Keep staged content (--keep-index)')}</label>
      <button type="submit" disabled={busy || !status.entries.length}>{t('Stash changes')}</button>
    </form>
    {stashes.length > 0 && <>
      <label className="git-check"><input type="checkbox" checked={restoreIndex} onChange={event => setRestoreIndex(event.target.checked)} />{t('Also restore the staged state when applying (--index)')}</label>
      <ul className="git-file-list" aria-label={t('Stash list')}>{stashes.map(entry => <li key={entry.oid} className="git-change">
        <span className="git-change-open"><code>stash@{`{${entry.index}}`}</code><span className="git-change-name">{entry.message}</span>
          <span className="git-change-dir">{formatTime(entry.createdAt)}</span></span>
        <span className="git-change-actions">
          <button disabled={busy} aria-label={t('Apply stash@{{{index}}}', { index: entry.index })} title={t('Apply (keep the stash)')}
            onClick={() => void run(() => gitApi.stashApply(projectId, { repoId: repo.id, index: entry.index, expected: entry.oid, pop: false, restoreIndex }))}><ArchiveRestore size={14} /></button>
          <button disabled={busy} aria-label={t('Apply and remove stash@{{{index}}}', { index: entry.index })} title={t('Pop (removed only if applying succeeds)')}
            onClick={() => void run(() => gitApi.stashApply(projectId, { repoId: repo.id, index: entry.index, expected: entry.oid, pop: true, restoreIndex }))}>Pop</button>
          <button disabled={busy} aria-label={t('Delete stash@{{{index}}}', { index: entry.index })} title={t('Delete stash')} onClick={() => setDanger({ kind: 'drop', entry })}><Trash2 size={14} /></button>
        </span>
      </li>)}</ul>
      <button className="danger" disabled={busy} onClick={() => setDanger({ kind: 'clear' })}>{t('Clear all stashes…')}</button>
    </>}
    {!stashes.length && <p className="git-muted">{t('No stashes.')}</p>}
    {danger && <DangerDialog
      title={danger.kind === 'drop' ? t('Delete stash@{{{index}}}?', { index: danger.entry.index }) : t('Clear all stashes in {{repo}}?', { repo: repo.name })}
      confirmLabel={danger.kind === 'drop' ? t('Delete stash') : t('Clear {{count}} stashes', { count: stashes.length })}
      acknowledge={danger.kind === 'drop' ? t('I understand this stash will be removed from the list') : t('I understand all {{count}} stashes will be removed', { count: stashes.length })}
      impact={danger.kind === 'drop' ? <p>{t('{{repo}}: "{{message}}" will be removed from the stash list.', { repo: repo.name, message: danger.entry.message })}</p>
        : <ul>{stashes.map(entry => <li key={entry.oid}>{entry.message}</li>)}</ul>}
      recovery={t('A recovery point saves the stash commit, so you can put it back from "Recovery points" (the order may change).')}
      onClose={() => setDanger(null)}
      onConfirm={async () => {
        const result = danger.kind === 'drop'
          ? await gitApi.stashDrop(projectId, { repoId: repo.id, index: danger.entry.index, expected: danger.entry.oid })
          : await gitApi.stashClear(projectId, { repoId: repo.id, expected: stashes.map(entry => entry.oid) });
        onOutcome(result); load();
      }} />}
  </div>;
}
