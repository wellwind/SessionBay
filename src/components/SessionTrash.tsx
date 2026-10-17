import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { TrashPage } from '../types';
import { Dialog } from './Dialog';
import { agentName, dateLabel } from './History';

export function SessionTrash({ onClose, onChanged, refreshToken }: {
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  refreshToken: number;
}) {
  const [page, setPage] = useState<TrashPage>({ items: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api.trash(offset, 40).then((result) => {
      if (cancelled) return;
      if (offset && offset >= result.total) {
        setOffset(Math.max(0, Math.floor((result.total - 1) / 40) * 40));
        return;
      }
      setPage(result);
    }).catch((reason) => { if (!cancelled) setError(errorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [offset, revision, refreshToken]);
  const restore = async (id: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.restoreSession(id);
      setPage((previous) => ({ items: previous.items.filter((entry) => entry.id !== id), total: Math.max(0, previous.total - 1) }));
      setRevision((value) => value + 1);
      await onChanged();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Dialog title="Session 資源回收筒" onClose={onClose} wide>
    <p>這裡的對話已從 Session Bay 歷史與搜尋中隱藏，可以逐筆還原。原始 Agent 歷史仍保留，執行中的工作不受影響。</p>
    <p className="muted">重新掃描或重建索引不會清空資源回收筒。本階段不提供永久刪除原始歷史。</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && <p role="status">讀取資源回收筒…</p>}
    {!loading && !error && !page.total && <p>資源回收筒是空的。</p>}
    <div className="session-trash-list" aria-label="資源回收筒清單" aria-busy={loading}>
      {page.items.map((entry) => <article className="session-trash-entry" key={entry.id}>
        <div>
          <h3>{entry.session.title || entry.session.externalId}</h3>
          <p>{agentName(entry.session.kind)} · 移入時間 {dateLabel(entry.deletedAt)}</p>
          <p className="session-trash-source">來源 {entry.session.sourceId} · {entry.sourceRoot}<br />Session {entry.session.externalId}</p>
          {entry.unavailableReason && <p role="status">{entry.unavailableReason}</p>}
        </div>
        <button className="secondary" disabled={loading || busy || !!entry.unavailableReason}
          aria-label={`還原 ${entry.session.title || entry.session.externalId}`}
          onClick={() => void restore(entry.id)}>還原</button>
      </article>)}
    </div>
    <div className="pagination">
      <span>{page.total} 個已刪除項目</span>
      <div>
        <button disabled={loading || busy || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 40))}>上一頁</button>
        <button disabled={loading || busy || offset + 40 >= page.total} onClick={() => setOffset((value) => value + 40)}>下一頁</button>
        <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>重新整理</button>
      </div>
    </div>
  </Dialog>;
}
