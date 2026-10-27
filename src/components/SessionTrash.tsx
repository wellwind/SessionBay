import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { OsTrashedSession, TrashedSession } from '../types';
import { OsTrashReview } from './OsTrashReview';
import { Dialog } from './Dialog';
import { agentName, dateLabel } from './History';

import { useSessionFeed } from '../use-session-feed';
import { VirtualSessionList } from './VirtualSessionList';
import { t } from '../i18n';

export function SessionTrash({ onClose, onChanged, refreshToken }: {
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  refreshToken: number;
}) {
  const inspectionPrefix = useId();
  const inspectionReturnId = useRef<string | null>(null);
  const [inspectionTarget, setInspectionTarget] = useState<TrashedSession | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const scrollMemory = useRef({ top: 0 }).current;
  const page = useSessionFeed<TrashedSession>('trash', JSON.stringify([revision, refreshToken]), api.trash);
  const { loading } = page;
  useEffect(() => {
    if (!inspectionTarget && inspectionReturnId.current) {
      document.getElementById(inspectionReturnId.current)?.focus();
      inspectionReturnId.current = null;
    }
  }, [inspectionTarget]);
  const restore = async (id: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.restoreSession(id);
      setRevision((value) => value + 1);
      await onChanged();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { lock.current = false; setBusy(false); }
  };
  const moved = async () => {
    inspectionReturnId.current = null;
    setInspectionTarget(null);
    setRevision((value) => value + 1);
    await onChanged();
  };
  return <Dialog title={inspectionTarget ? t('Move to system trash') : t('Session recycle bin')}
    onClose={inspectionTarget ? () => setInspectionTarget(null) : onClose} wide>
    {inspectionTarget ? <OsTrashReview key={inspectionTarget.id} entry={inspectionTarget}
      onClose={() => setInspectionTarget(null)} onMoved={moved} /> : <>
    <p>{t('These conversations are hidden from Session Bay history and search, and you can restore them one by one. The original agent history is kept and running work is not affected. To really delete the files, use "Move to system trash…" on an entry.')}</p>
    <p className="muted session-trash-note">{t('Rescanning or rebuilding the index does not empty the recycle bin. To really delete, move each session\'s agent files to the system trash.')}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && <p role="status">{t('Loading recycle bin…')}</p>}
    {!loading && !error && !page.error && !page.total && <p>{t('The recycle bin is empty.')}</p>}
    <VirtualSessionList items={page.items} total={page.total} label={t('Recycle bin list')}
      className="session-trash-list" rowHeight={210} scrollMemory={scrollMemory}
      loading={loading} done={page.done} error={page.error} loadMore={page.loadMore} retry={page.retry}
      renderRow={(entry) => <article className="session-trash-entry">
        <div>
          <h3>{entry.session.title || entry.session.externalId}</h3>
          <p>{t('{{agent}} · deleted {{time}}', { agent: agentName(entry.session.kind), time: dateLabel(entry.deletedAt) })}</p>
          <p className="session-trash-source">{t('Source {{root}}', { root: entry.session.sourceId })} · {entry.sourceRoot}<br />Session {entry.session.externalId}</p>
          {entry.unavailableReason && <p role="status">{entry.unavailableReason}</p>}
        </div>
        <div className="history-undo-actions">
        <button id={`${inspectionPrefix}-${entry.id}`} className="secondary" disabled={loading || busy}
          aria-label={t('Move {{title}} to system trash', { title: entry.session.title || entry.session.externalId })}
          onClick={() => { inspectionReturnId.current = `${inspectionPrefix}-${entry.id}`; setInspectionTarget(entry); }}>{t('Move to system trash…')}</button>
        <button className="secondary" disabled={loading || busy || !!entry.unavailableReason}
          aria-label={t('Restore {{title}}', { title: entry.session.title || entry.session.externalId })}
          onClick={() => void restore(entry.id)}>{t('Restore')}</button>
        </div>
      </article>} />
    <MovedSessions revision={revision} onRestored={async () => { setRevision((value) => value + 1); await onChanged(); }} />
    <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t('Refresh')}</button>
    </>}
  </Dialog>;
}

/** Sessions whose files went to the OS trash; the record maps ID-named trash items back to titles. */
function MovedSessions({ revision, onRestored }: { revision: number; onRestored: () => Promise<void> }) {
  const [items, setItems] = useState<OsTrashedSession[]>([]);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api.osTrashed().then(value => { if (!cancelled) setItems(value); }, reason => { if (!cancelled) setMessage(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [revision, reload]);
  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setMessage('');
    try { await action(); } catch (reason) { setMessage(errorMessage(reason)); }
    finally { setBusy(''); setReload(value => value + 1); }
  };
  const restore = (entry: OsTrashedSession) => run(entry.id, async () => {
    const result = await api.restoreOsTrashed(entry.id);
    if (result.moved.length) {
      await api.scan();
      await onRestored();
    }
    setMessage(result.failed.length ? t('Some items were not restored: {{reasons}}', { reasons: result.failed.join(t('; ')) }) : t('Restored "{{title}}". It shows up in history after a rescan.', { title: entry.title || entry.externalId }));
  });
  if (!items.length && !message) return null;
  return <section aria-label={t('Moved to system trash')} className="session-os-trash">
    <h3>{t('Moved to system trash')}</h3>
    <p className="muted">{t('Items in the system trash are named by session ID. Emptying the trash deletes them for good; until then you can restore them to their original location here.')}</p>
    {message && <p role="status">{message}</p>}
    {items.map(entry => {
      const remaining = entry.items.filter(item => item.inTrash).length;
      const name = entry.title || entry.externalId;
      return <article key={entry.id} className="session-trash-entry">
        <div>
          <h3>{name}</h3>
          <p>{t('{{agent}} · moved to trash {{time}}', { agent: agentName(entry.kind), time: dateLabel(new Date(entry.movedAt * 1000).toISOString()) })}
            {' · '}{remaining ? t('{{remaining}} / {{total}} items still in the trash', { remaining, total: entry.items.length }) : t('Permanently deleted from the trash')}</p>
          <p className="session-trash-source">Session {entry.externalId}<br />
            {entry.items.map(item => `${item.relativePath}${item.inTrash ? '' : t(' (deleted)')}`).join(t(', '))}</p>
        </div>
        <div className="history-undo-actions">
          {remaining > 0 && <button className="secondary" disabled={!!busy} aria-label={t('Restore {{name}} from system trash', { name })}
            onClick={() => void restore(entry)}>{t('Restore')}</button>}
          <button className="secondary" disabled={!!busy} aria-label={t('Remove record {{name}}', { name })}
            onClick={() => void run(entry.id, () => api.forgetOsTrashed(entry.id))}>{t('Remove record')}</button>
        </div>
      </article>;
    })}
  </section>;
}
