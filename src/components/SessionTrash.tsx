import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { OsTrashedSession, TrashedSession } from '../types';
import { OsTrashReview } from './OsTrashReview';
import { Dialog } from './Dialog';
import { agentName, dateLabel } from './History';

import { useSessionFeed } from '../use-session-feed';
import { VirtualSessionList } from './VirtualSessionList';

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
  return <Dialog title={inspectionTarget ? '移到系統垃圾桶' : 'Session 資源回收筒'}
    onClose={inspectionTarget ? () => setInspectionTarget(null) : onClose} wide>
    {inspectionTarget ? <OsTrashReview key={inspectionTarget.id} entry={inspectionTarget}
      onClose={() => setInspectionTarget(null)} onMoved={moved} /> : <>
    <p>這裡的對話已從 Session Bay 歷史與搜尋中隱藏，可以逐筆還原。原始 Agent 歷史仍保留，執行中的工作不受影響；要真正刪除檔案，請按該筆的「移到系統垃圾桶…」。</p>
    <p className="muted">重新掃描或重建索引不會清空資源回收筒。要真正刪除時，可逐筆把 Agent 的 Session 檔案移到系統垃圾桶。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && <p role="status">讀取資源回收筒…</p>}
    {!loading && !error && !page.error && !page.total && <p>資源回收筒是空的。</p>}
    <VirtualSessionList items={page.items} total={page.total} label="資源回收筒清單"
      className="session-trash-list" rowHeight={210} scrollMemory={scrollMemory}
      loading={loading} done={page.done} error={page.error} loadMore={page.loadMore} retry={page.retry}
      renderRow={(entry) => <article className="session-trash-entry">
        <div>
          <h3>{entry.session.title || entry.session.externalId}</h3>
          <p>{agentName(entry.session.kind)} · 移入時間 {dateLabel(entry.deletedAt)}</p>
          <p className="session-trash-source">來源 {entry.session.sourceId} · {entry.sourceRoot}<br />Session {entry.session.externalId}</p>
          {entry.unavailableReason && <p role="status">{entry.unavailableReason}</p>}
        </div>
        <div className="history-undo-actions">
        <button id={`${inspectionPrefix}-${entry.id}`} className="secondary" disabled={loading || busy}
          aria-label={`移到系統垃圾桶 ${entry.session.title || entry.session.externalId}`}
          onClick={() => { inspectionReturnId.current = `${inspectionPrefix}-${entry.id}`; setInspectionTarget(entry); }}>移到系統垃圾桶…</button>
        <button className="secondary" disabled={loading || busy || !!entry.unavailableReason}
          aria-label={`還原 ${entry.session.title || entry.session.externalId}`}
          onClick={() => void restore(entry.id)}>還原</button>
        </div>
      </article>} />
    <MovedSessions revision={revision} onRestored={async () => { setRevision((value) => value + 1); await onChanged(); }} />
    <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>重新整理</button>
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
    setMessage(result.failed.length ? `部分項目未還原：${result.failed.join('；')}` : `已還原「${entry.title || entry.externalId}」，重新掃描後會出現在歷史中。`);
  });
  if (!items.length && !message) return null;
  return <section aria-label="已移到系統垃圾桶" className="session-os-trash">
    <h3>已移到系統垃圾桶</h3>
    <p className="muted">系統垃圾桶中的項目以 Session ID 命名。清空垃圾桶即永久刪除；清空前可在這裡還原到原位置。</p>
    {message && <p role="status">{message}</p>}
    {items.map(entry => {
      const remaining = entry.items.filter(item => item.inTrash).length;
      const name = entry.title || entry.externalId;
      return <article key={entry.id} className="session-trash-entry">
        <div>
          <h3>{name}</h3>
          <p>{agentName(entry.kind)} · 移到垃圾桶 {dateLabel(new Date(entry.movedAt * 1000).toISOString())}
            {' · '}{remaining ? `${remaining}／${entry.items.length} 項仍在垃圾桶` : '已從垃圾桶永久刪除'}</p>
          <p className="session-trash-source">Session {entry.externalId}<br />
            {entry.items.map(item => `${item.relativePath}${item.inTrash ? '' : '（已刪除）'}`).join('、')}</p>
        </div>
        <div className="history-undo-actions">
          {remaining > 0 && <button className="secondary" disabled={!!busy} aria-label={`從系統垃圾桶還原 ${name}`}
            onClick={() => void restore(entry)}>還原</button>}
          <button className="secondary" disabled={!!busy} aria-label={`移除紀錄 ${name}`}
            onClick={() => void run(entry.id, () => api.forgetOsTrashed(entry.id))}>移除紀錄</button>
        </div>
      </article>;
    })}
  </section>;
}
