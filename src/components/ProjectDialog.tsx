import { useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { Project } from '../types';
import { Dialog } from './Dialog';
import { DirectoryPathField } from './DirectoryPathField';
import { t } from '../i18n';

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
    <Dialog title={t('Add or create a project')} onClose={close}>
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
        <div className="project-mode" role="group" aria-label={t('How to add the project')}>
          <button type="button" disabled={busy || !!saved.current} className={mode === 'existing' ? 'selected' : ''}
            onClick={() => { setMode('existing'); setError(''); }}>{t('Add existing folder')}</button>
          <button type="button" disabled={busy || !!saved.current} className={mode === 'create' ? 'selected' : ''}
            onClick={() => { setMode('create'); setError(''); }}>{t('Create new project')}</button>
        </div>
        <p className="dialog-description">{mode === 'create'
          ? t('Creates a new folder in the parent folder you choose and adds it to your projects. Existing folders are never overwritten.')
          : t('Adds only the folder you choose to your projects. History found automatically stays browsable in "All sessions".')}</p>
        <DirectoryPathField key={mode} label={mode === 'create' ? t('Parent folder path') : t('Folder path')}
          required disabled={busy || !!saved.current} autoFocus value={path}
          placeholder={t('/Users/you/projects or /home/you/projects')} onChange={setPath} />
        <label className="field-label">{mode === 'create' ? t('Project name (new folder name)') : t('Project name (optional)')}
          <input required={mode === 'create'} disabled={busy || !!saved.current} value={name} maxLength={120}
            placeholder={mode === 'create' ? 'my-project' : t('Defaults to the folder name')}
            onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="small-muted">{t('Use the full absolute path on this computer.')}{mode === 'create' && t('The name cannot contain /, \\ or ...')}</p>
        {error && <p className="inline-warning" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>{t('Cancel')}</button>
          <button className="primary" disabled={busy || !path.trim() || (mode === 'create' && !name.trim())}>
            {busy ? t('Saving…') : saved.current ? t('Refresh projects') : mode === 'create' ? t('Create and add') : t('Add project')}
            <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
