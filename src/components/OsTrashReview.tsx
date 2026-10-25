import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { agentNames } from '../agents';
import type { OsTrashPlan, OsTrashResult, TrashedSession } from '../types';

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
    <p role="alert" className="inline-error">部分檔案未能移到系統垃圾桶，Session Bay 已不再顯示這個 Session。</p>
    <ul aria-label="未移動">{partial.failed.map(reason => <li key={reason}>{reason}</li>)}</ul>
    <div className="history-undo-actions"><button ref={backButton} onClick={() => void onMoved()}>完成</button></div>
  </>;
  return <>
    <h3>{entry.session.title || entry.session.externalId}</h3>
    <p>下列檔案會移到系統垃圾桶。在系統垃圾桶清空前，可從本視窗的「已移到系統垃圾桶」還原；檔名是 Session ID，不是標題。共享儲存不會變動，可能仍留有這個 Session 的片段紀錄。</p>
    {loading && <p role="status">檢查 Session 檔案中…</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {plan && <>
      <p className="session-trash-source">{agentNames[plan.kind]} · Session {entry.session.externalId}<br />來源 {plan.sourceRoot}</p>
      {!!plan.items.length && <ul aria-label="將移到系統垃圾桶">
        {plan.items.map(item => <li key={item.relativePath}>
          <span className="session-trash-source">{item.relativePath}{item.directory ? '/' : ''}</span>
          {' · '}{item.directory ? `資料夾，${item.entries} 個項目，` : ''}{sizeLabel(item.bytes)}
        </li>)}
      </ul>}
      {!!plan.kept.length && <>
        <p>保留不動的共享儲存：</p>
        <ul aria-label="保留的共享儲存">{plan.kept.map(name => <li key={name} className="session-trash-source">{name}</li>)}</ul>
      </>}
      {!!plan.blockers.length && <ul aria-label="無法移動原因" className="inline-error">
        {plan.blockers.map(reason => <li key={reason}>{reason}</li>)}
      </ul>}
      {ready && <label className="checkbox-label">
        <input type="checkbox" className="checkbox" checked={confirmed} disabled={moving}
          onChange={event => setConfirmed(event.target.checked)} />
        我了解這些檔案會離開 Agent 的歷史資料夾，Agent 將無法再接續這個 Session。
      </label>}
    </>}
    <div className="history-undo-actions">
      <button ref={backButton} className="secondary" disabled={moving} onClick={onClose}>返回資源回收筒</button>
      <button className="secondary" disabled={loading || moving} onClick={() => setRevision(value => value + 1)}>重新檢查</button>
      <button className="danger" disabled={!ready || !confirmed || moving || loading}
        onClick={() => void execute()}>{moving ? '移動中…' : '移到系統垃圾桶'}</button>
    </div>
  </>;
}
