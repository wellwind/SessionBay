import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { RecoveryPoint, RepoInfo } from './types';
import { coverageText, formatTime } from './types';

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
      onRestored({ tone: 'success', text: done.join('；') || '已還原' });
      setTarget(null); setNeedsMove(false);
    } catch (failure) {
      const text = errorMessage(failure);
      setError(text);
      setNeedsMove(text.includes('HEAD 已移動'));
    } finally { setBusy(false); load(); }
  };
  if (!points.length) return <p className="git-muted">沒有復原點。危險操作會自動建立。</p>;
  return <div className="git-form">
    <ul className="git-file-list" aria-label="復原點">{points.map(point => <li key={point.id} className="git-change">
      <button className="git-change-open" onClick={() => { setTarget(point); setError(''); setNeedsMove(false); }} aria-label={`檢視復原點：${point.operation}`}>
        <span className="git-change-name">{point.operation}</span><span className="git-change-dir">{formatTime(point.createdAt)}</span>
      </button>
    </li>)}</ul>
    {target && <Dialog title={`還原：${target.operation}`} onClose={() => { if (!busy) setTarget(null); }}>
      <p>建立於 {formatTime(target.createdAt)}{target.branch ? `，branch ${target.branch}` : ''}{target.head ? `，HEAD ${target.head.slice(0, 7)}` : ''}。</p>
      <p className="git-danger-heading">此復原點保存</p>
      <ul>{coverageText(target.coverage).map(item => <li key={item}>{item}</li>)}</ul>
      {target.notes.map(note => <p key={note} className="git-muted">{note}</p>)}
      <p className="git-muted">還原不會覆蓋之後的未提交修改；若 HEAD 已移動，會先建立目前狀態的復原點。</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void gitApi.removeRecovery(projectId, repo.id, target.id).then(() => { setTarget(null); load(); })}>刪除復原點</button>
        <button disabled={busy} onClick={() => setTarget(null)}>取消</button>
        {needsMove ? <button className="danger" disabled={busy} onClick={() => void restore(true)}>仍要移回 HEAD 並還原</button>
          : <button className="primary" data-dialog-confirm disabled={busy} onClick={() => void restore(false)}>還原</button>}
      </div>
    </Dialog>}
  </div>;
}
