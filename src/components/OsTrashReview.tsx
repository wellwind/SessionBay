import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { agentNames } from '../agents';
import type { OsTrashPlan, OsTrashResult, TrashedSession } from '../types';
import { t } from '../i18n';

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function OsTrashReview({ entry, onClose, onMoved }: {
  entry: TrashedSession;
  onClose: () => void;
  onMoved: () => Promise<void>;
}) {
  const [revision, setRevision] = useState(0);
  const [plan, setPlan] = useState<OsTrashPlan | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [moving, setMoving] = useState(false);
  const [partial, setPartial] = useState<OsTrashResult | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { backButton.current?.focus(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlan(null);
    setConfirmed(false);
    setError('');
    void api.prepareSessionOsTrash(entry.id).then(value => {
      if (!cancelled) setPlan(value);
    }, reason => {
      if (!cancelled) setError(errorMessage(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry.id, revision]);
  const execute = async () => {
    if (!plan?.planId || moving) return;
    setMoving(true);
    setError('');
    try {
      const result = await api.executeSessionOsTrash(plan.planId);
      if (result.failed.length) setPartial(result);
      else await onMoved();
    } catch (reason) {
      setError(errorMessage(reason));
      // A consumed or stale plan cannot be retried; fetch a fresh one.
      setRevision(value => value + 1);
    } finally { setMoving(false); }
  };
  const ready = !!plan?.planId && !plan.blockers.length;
  if (partial) return <>
    <h3>{entry.session.title || entry.session.externalId}</h3>
    <p role="alert" className="inline-error">{t('Some files could not be moved to the system trash. Session Bay no longer shows this session.')}</p>
    <ul aria-label={t('Not moved')}>{partial.failed.map(reason => <li key={reason}>{reason}</li>)}</ul>
    <div className="history-undo-actions"><button ref={backButton} onClick={() => void onMoved()}>{t('Done')}</button></div>
  </>;
  return <>
    <h3>{entry.session.title || entry.session.externalId}</h3>
    <p>{t('These files will move to the system trash. Until the trash is emptied, you can restore them from "Moved to system trash" in this window. File names are session IDs, not titles. Shared storage is not changed and may still hold fragments of this session.')}</p>
    {loading && <p role="status">{t('Checking session files…')}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {plan && <>
      <p className="session-trash-source">{agentNames[plan.kind]} · Session {entry.session.externalId}<br />{t('Source {{root}}', { root: plan.sourceRoot })}</p>
      {plan.kind === 'opencode' && <p>{t('OpenCode keeps conversations in a shared database. Session Bay first exports the full JSON with the official ')}<code>opencode export</code>{t(' command, verifies the export, deletes the session with ')}<code>opencode session delete</code>{t(' and moves the export to the system trash. Restoring runs ')}<code>opencode import</code>{t(' in the original working directory.')}</p>}
      {!!plan.items.length && <ul aria-label={t('Will move to the system trash')}>
        {plan.items.map(item => <li key={item.relativePath}>
          <span className="session-trash-source">{item.relativePath}{item.directory ? '/' : ''}</span>
          {plan.kind !== 'opencode' && <>{' · '}{item.directory ? t('folder, {{count}} items, ', { count: item.entries }) : ''}{sizeLabel(item.bytes)}</>}
        </li>)}
      </ul>}
      {!!plan.kept.length && <>
        <p>{t('Shared storage left untouched:')}</p>
        <ul aria-label={t('Shared storage kept')}>{plan.kept.map(name => <li key={name} className="session-trash-source">{name}</li>)}</ul>
      </>}
      {!!plan.blockers.length && <ul aria-label={t('Why it cannot be moved')} className="inline-error">
        {plan.blockers.map(reason => <li key={reason}>{reason}</li>)}
      </ul>}
      {ready && <label className="checkbox-label">
        <input type="checkbox" className="checkbox" checked={confirmed} disabled={moving}
          onChange={event => setConfirmed(event.target.checked)} />
        {t('I understand these files will leave the agent\'s history folder and the agent can no longer resume this session.')}
      </label>}
    </>}
    <div className="history-undo-actions">
      <button ref={backButton} className="secondary" disabled={moving} onClick={onClose}>{t('Back to recycle bin')}</button>
      <button className="secondary" disabled={loading || moving} onClick={() => setRevision(value => value + 1)}>{t('Check again')}</button>
      <button className="danger" disabled={!ready || !confirmed || moving || loading}
        onClick={() => void execute()}>{moving ? t('Moving…') : t('Move to system trash')}</button>
    </div>
  </>;
}
