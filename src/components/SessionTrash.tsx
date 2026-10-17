import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { RemovalInspection, TrashedSession } from '../types';
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
  return <Dialog title={inspectionTarget ? '來源移除影響檢查' : 'Session 資源回收筒'}
    onClose={inspectionTarget ? () => setInspectionTarget(null) : onClose} wide>
    {inspectionTarget ? <RemovalInspector key={inspectionTarget.id} entry={inspectionTarget}
      onClose={() => setInspectionTarget(null)} /> : <>
    <p>這裡的對話已從 Session Bay 歷史與搜尋中隱藏，可以逐筆還原。原始 Agent 歷史仍保留，執行中的工作不受影響。</p>
    <p className="muted">重新掃描或重建索引不會清空資源回收筒。可逐筆檢查已索引來源；永久移除尚未開放。</p>
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
          aria-label={`檢查來源 ${entry.session.title || entry.session.externalId}`}
          onClick={() => { inspectionReturnId.current = `${inspectionPrefix}-${entry.id}`; setInspectionTarget(entry); }}>檢查來源</button>
        <button className="secondary" disabled={loading || busy || !!entry.unavailableReason}
          aria-label={`還原 ${entry.session.title || entry.session.externalId}`}
          onClick={() => void restore(entry.id)}>還原</button>
        </div>
      </article>} />
    <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>重新整理</button>
    </>}
  </Dialog>;
}

function RemovalInspector({ entry, onClose }: { entry: TrashedSession; onClose: () => void }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<RemovalInspection | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { backButton.current?.focus(); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setError('');
    void api.inspectSessionRemoval(entry.id).then(value => {
      if (!cancelled) setResult(value);
    }, reason => {
      if (!cancelled) setError(errorMessage(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry.id, revision]);
  return <>
    <h3>{entry.session.title || entry.session.externalId}</h3>
    <p>這是唯讀檢查，不會刪除任何資料。以下僅列出已索引來源，不代表完整清除清單。</p>
    {loading && <p role="status">檢查來源中…</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {result && <>
      <p className="session-trash-source">{agentName(result.kind)} · Session {result.externalId}<br />來源 {result.sourceRoot}</p>
      <ul aria-label="已索引來源">
        {result.indexedArtifacts.map(artifact => <li key={artifact.relativePath}>
          <span className="session-trash-source">{artifact.relativePath}</span>
          {' · '}{artifact.status === 'sharedStore' ? '共享儲存，不可整份刪除' :
            artifact.status === 'metadataMatchesIndex' ? '檔案中繼資料符合索引' : '已變更、無法確認或包含連結'}
          {artifact.indexedBytes !== null && ` · 索引大小 ${artifact.indexedBytes} bytes`}
        </li>)}
      </ul>
      <p>符合索引不代表內容未變或 Agent 已停止；檢查結果不能用來授權刪除。</p>
      <ul aria-label="尚未開放原因">{result.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </>}
    <div className="history-undo-actions">
      <button ref={backButton} className="secondary" onClick={onClose}>返回資源回收筒</button>
      <button disabled={loading} onClick={() => setRevision(value => value + 1)}>重新檢查</button>
    </div>
  </>;
}
