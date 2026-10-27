import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { GitTargetContext } from './git-target';
import { t } from '../i18n';

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
      {target && <p className="git-danger-target">{t('Target project: ')}<strong>{target}</strong></p>}
      <p className="git-danger-heading"><AlertTriangle size={16} aria-hidden="true" />{t('Impact')}</p>
      <div className="git-danger-impact">{impact}</div>
      {children}
      <p className="git-danger-heading">{t('Recovery')}</p>
      <div className="git-muted">{recovery ?? t('This operation has no automatic recovery point; Session Bay cannot undo it afterwards.')}</div>
      <label className="git-check git-ack"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />{acknowledge}</label>
      {error && <p className="git-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button className="danger" data-dialog-confirm disabled={!checked || busy} onClick={() => {
        setBusy(true); setError('');
        onConfirm().then(onClose, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>{busy ? <><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Working…')}</> : confirmLabel}</button>
    </div>
  </Dialog>;
}
