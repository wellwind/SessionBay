import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { RecoveryPoint, RepoInfo } from './types';
import { coverageText, formatTime } from './types';
import { t } from '../i18n';

/** Recovery points list exactly what they can restore. */
export function RecoveryPanel({ projectId, repo, revision, onRestored }: {
  projectId: string; repo: RepoInfo; revision: string | undefined; onRestored: (message: { tone: 'success' | 'error'; text: string }) => void;
}) {
  const [points, setPoints] = useState<RecoveryPoint[]>([]);
  const [target, setTarget] = useState<RecoveryPoint | null>(null);
  const [error, setError] = useState('');
  const [needsMove, setNeedsMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { gitApi.recoveryPoints(projectId, repo.id).then(setPoints).catch(() => setPoints([])); }, [projectId, repo.id]);
  useEffect(() => { load(); }, [load, revision]);
  const restore = async (allowHeadMove: boolean) => {
    if (!target) return;
    setBusy(true); setError('');
    try {
      const done = await gitApi.restoreRecovery(projectId, repo.id, target.id, allowHeadMove);
      onRestored({ tone: 'success', text: done.join(t('; ')) || t('Restored') });
      setTarget(null); setNeedsMove(false);
    } catch (failure) {
      const text = errorMessage(failure);
      setError(text);
      setNeedsMove(text.includes(t('HEAD has moved')));
    } finally { setBusy(false); load(); }
  };
  if (!points.length) return <p className="git-muted">{t('No recovery points. Risky operations create one automatically.')}</p>;
  return <div className="git-form">
    <ul className="git-file-list" aria-label={t('Recovery points')}>{points.map(point => <li key={point.id} className="git-change">
      <button className="git-change-open" onClick={() => { setTarget(point); setError(''); setNeedsMove(false); }} aria-label={t('View recovery point: {{operation}}', { operation: point.operation })}>
        <span className="git-change-name">{point.operation}</span><span className="git-change-dir">{formatTime(point.createdAt)}</span>
      </button>
    </li>)}</ul>
    {target && <Dialog title={t('Restore: {{operation}}', { operation: target.operation })} onClose={() => { if (!busy) setTarget(null); }}>
      <p>{t('Created {{time}}', { time: formatTime(target.createdAt) })}{target.branch ? t(', branch {{branch}}', { branch: target.branch }) : ''}{target.head ? t(', HEAD {{head}}', { head: target.head.slice(0, 7) }) : ''}{t('.')}</p>
      <p className="git-danger-heading">{t('This recovery point saves')}</p>
      <ul>{coverageText(target.coverage).map(item => <li key={item}>{item}</li>)}</ul>
      {target.notes.map(note => <p key={note} className="git-muted">{note}</p>)}
      <p className="git-muted">{t('Restoring never overwrites later uncommitted changes. If HEAD has moved, a recovery point of the current state is created first.')}</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void gitApi.removeRecovery(projectId, repo.id, target.id).then(() => { setTarget(null); load(); })}>{t('Delete recovery point')}</button>
        <button disabled={busy} onClick={() => setTarget(null)}>{t('Cancel')}</button>
        {needsMove ? <button className="danger" disabled={busy} onClick={() => void restore(true)}>{t('Move HEAD back and restore anyway')}</button>
          : <button className="primary" data-dialog-confirm disabled={busy} onClick={() => void restore(false)}>{t('Restore')}</button>}
      </div>
    </Dialog>}
  </div>;
}
