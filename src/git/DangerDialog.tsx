import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { GitTargetContext } from './git-target';

/**
 * Destructive confirmations always spell out the impact and what a recovery
 * point can and cannot bring back, and need an explicit acknowledgement.
 */
export function DangerDialog({ title, impact, recovery, confirmLabel, acknowledge, children, onConfirm, onClose }: {
  title: string;
  impact: ReactNode;
  /** What the automatic recovery point keeps; `null` means none. */
  recovery: ReactNode | null;
  confirmLabel: string;
  acknowledge: string;
  children?: ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const target = useContext(GitTargetContext);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={title} onClose={() => { if (!busy) onClose(); }}>
    <div className="git-danger-body">
      {target && <p className="git-danger-target">目標專案：<strong>{target}</strong></p>}
      <p className="git-danger-heading"><AlertTriangle size={16} aria-hidden="true" />影響範圍</p>
      <div className="git-danger-impact">{impact}</div>
      {children}
      <p className="git-danger-heading">復原</p>
      <div className="git-muted">{recovery ?? '此操作沒有自動復原點，完成後無法由 Session Bay 還原。'}</div>
      <label className="git-check git-ack"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />{acknowledge}</label>
      {error && <p className="git-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>取消</button>
      <button className="danger" data-dialog-confirm disabled={!checked || busy} onClick={() => {
        setBusy(true); setError('');
        onConfirm().then(onClose, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>{busy ? <><LoaderCircle className="spin" size={14} aria-hidden="true" /> 處理中…</> : confirmLabel}</button>
    </div>
  </Dialog>;
}
