import { useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { TrashedSession } from '../types';
import { Dialog } from './Dialog';
import { agentName, dateLabel } from './History';

import { useSessionFeed } from '../use-session-feed';
import { VirtualSessionList } from './VirtualSessionList';

export function SessionTrash({ onClose, onChanged, refreshToken }: {
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  refreshToken: number;
}) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const scrollMemory = useRef({ top: 0 }).current;
  const page = useSessionFeed<TrashedSession>('trash', JSON.stringify([revision, refreshToken]), api.trash);
  const { loading } = page;
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
  return <Dialog title="Session 資源回收筒" onClose={onClose} wide>
    <p>這裡的對話已從 Session Bay 歷史與搜尋中隱藏，可以逐筆還原。原始 Agent 歷史仍保留，執行中的工作不受影響。</p>
    <p className="muted">重新掃描或重建索引不會清空資源回收筒。本階段不提供永久刪除原始歷史。</p>
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
        <button className="secondary" disabled={loading || busy || !!entry.unavailableReason}
          aria-label={`還原 ${entry.session.title || entry.session.externalId}`}
          onClick={() => void restore(entry.id)}>還原</button>
      </article>} />
    <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>重新整理</button>
  </Dialog>;
}
