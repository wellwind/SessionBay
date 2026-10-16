import { useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { Project } from '../types';
import { Dialog } from './Dialog';
import { DirectoryPathField } from './DirectoryPathField';

export function ProjectDialog({ onSaved, onClose }: {
  onSaved: (project: Project) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const saved = useRef<Project | null>(null);
  const close = () => { if (!submitting.current) onClose(); };
  return (
    <Dialog title="加入或建立專案" onClose={close}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        // Keep a successful mutation across a refresh failure. Retry never creates twice.
        void (saved.current ? Promise.resolve(saved.current) : mode === 'create'
          ? api.createProject(path.trim(), name.trim())
          : api.addProject(path.trim(), name.trim() || undefined))
          .then(async (project) => { saved.current = project; await onSaved(project); })
          .catch((reason) => setError(errorMessage(reason)))
          .finally(() => { submitting.current = false; setBusy(false); });
      }}>
        <div className="project-mode" role="group" aria-label="專案加入方式">
          <button type="button" disabled={busy || !!saved.current} className={mode === 'existing' ? 'selected' : ''}
            onClick={() => { setMode('existing'); setError(''); }}>加入現有目錄</button>
          <button type="button" disabled={busy || !!saved.current} className={mode === 'create' ? 'selected' : ''}
            onClick={() => { setMode('create'); setError(''); }}>建立新專案</button>
        </div>
        <p className="dialog-description">{mode === 'create'
          ? '在指定的上層目錄建立一個新資料夾，並加入專案清單。不會覆寫既有資料夾。'
          : '只將你選定的目錄加入專案清單。自動找到的歷史仍可在「所有工作階段」瀏覽。'}</p>
        <DirectoryPathField key={mode} label={mode === 'create' ? '上層目錄路徑' : '目錄路徑'}
          required disabled={busy || !!saved.current} autoFocus value={path}
          placeholder="/Users/you/projects 或 /home/you/projects" onChange={setPath} />
        <label className="field-label">{mode === 'create' ? '專案名稱（新資料夾名稱）' : '專案名稱（選填）'}
          <input required={mode === 'create'} disabled={busy || !!saved.current} value={name} maxLength={120}
            placeholder={mode === 'create' ? 'my-project' : '預設使用目錄名稱'}
            onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="small-muted">請填寫這台桌面電腦上的完整絕對路徑。{mode === 'create' && '名稱不可含 /、\\ 或 ..。'}</p>
        {error && <p className="inline-warning" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
          <button className="primary" disabled={busy || !path.trim() || (mode === 'create' && !name.trim())}>
            {busy ? '儲存中…' : saved.current ? '重新整理專案' : mode === 'create' ? '建立並加入' : '加入專案'}
            <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
