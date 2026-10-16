import { useId, useRef, useState } from 'react';
import { displayNameError } from '../display-name';
import { errorMessage } from '../api';
import { Dialog } from './Dialog';

export function RenameDialog({ title, name, description, onSave, onClose }: {
  title: string;
  name: string;
  description: string;
  onSave: (name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const id = useId();
  const validation = displayNameError(draft);
  const close = () => { if (!pending.current) onClose(); };
  return <Dialog title={title} onClose={close}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (pending.current || validation) return;
      pending.current = true;
      setBusy(true);
      setError('');
      void Promise.resolve().then(() => onSave(draft.trim())).then(onClose).catch((cause) => {
        setError(errorMessage(cause));
      }).finally(() => { pending.current = false; setBusy(false); });
    }}>
      <p className="dialog-description">{description}</p>
      <label className="field-label" htmlFor={id}>顯示名稱
        <input id={id} autoFocus value={draft} disabled={busy} aria-invalid={!!validation || !!error}
          aria-describedby={`${id}-help ${id}-error`} onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => { setDraft(event.target.value); setError(''); }} />
      </label>
      <p className="small-muted" id={`${id}-help`}>最多 200 個字元；可使用重複名稱，請由所在位置或路徑分辨。</p>
      <p id={`${id}-error`} role={validation || error ? 'alert' : undefined} className="inline-warning">{validation || error}</p>
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="primary" disabled={busy || !!validation}>{busy ? '儲存中…' : '儲存名稱'}</button>
      </div>
    </form>
  </Dialog>;
}
