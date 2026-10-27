import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { CommitPreview, RepoInfo, RepoStatus } from './types';
import { operationLabel, pathKey } from './types';
import { ChangeBadge } from './GitChanges';
import { t } from '../i18n';

const letter = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged' } as const;

/** Commits exactly what the index holds, after the user has seen it. */
export function CommitBox({ projectId, repo, status, onDone }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onDone: (message: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const staged = status.entries.filter(entry => entry.staged).length;
  const conflicts = status.entries.some(entry => entry.conflict);
  const merging = status.operation === 'merge';
  const open = async () => {
    setLoading(true); setError('');
    try { setPreview(await gitApi.commitPreview(projectId, repo.id)); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setRunning(true); setError('');
    try {
      const result = await gitApi.commit(projectId, repo.id, message, preview.token);
      setPreview(null); setMessage('');
      onDone(t('Created commit {{commit}}: {{summary}}', { commit: result.oid.slice(0, 7), summary: result.summary }));
    } catch (failure) {
      setError(errorMessage(failure));
      onDone('');
    } finally { setRunning(false); }
  };
  const disabledReason = conflicts ? t('There are still unresolved conflicts') : !staged && !merging ? t('No staged changes') : !message.trim() ? t('Enter a commit message') : '';
  return <div className="git-form">
    <label className="git-field">{t('Commit message')}
      <textarea rows={3} value={message} placeholder={t('The first line is the summary; add details after a blank line')} onChange={event => setMessage(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !disabledReason) { event.preventDefault(); void open(); }
        }} />
    </label>
    <div className="git-row">
      <span className="git-muted">{t('{{count}} staged files', { count: staged })}{merging ? t(' (merging)') : ''}</span>
      <button className="primary" disabled={!!disabledReason || loading} title={disabledReason || t('Review what will be committed (Ctrl/⌘+Enter)')} onClick={() => void open()}>
        {loading ? t('Loading…') : t('Review and commit')}</button>
    </div>
    {error && !preview && <p className="git-error" role="alert">{error}</p>}
    {preview && <Dialog title={t('Confirm commit')} wide onClose={() => { if (!running) setPreview(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd title={repo.root}>{repo.name} <span className="git-muted">{repo.root}</span></dd>
        <dt>Branch</dt><dd>{preview.branch ?? <span className="git-warning">{t('detached HEAD (the commit is not on any branch)')}</span>}
          {!preview.head && <span className="git-muted">{t(' (first commit)')}</span>}</dd>
        {preview.operation && <><dt>{t('State')}</dt><dd className="git-warning">{operationLabel[preview.operation]}</dd></>}
        {preview.author && <><dt>{t('Author')}</dt><dd>{preview.author}</dd></>}
        <dt>{t('Message')}</dt><dd><pre className="git-message">{message}</pre></dd>
        <dt>Hooks</dt><dd>{preview.hooks.length ? t('Will run: {{hooks}}', { hooks: preview.hooks.join(t(', ')) }) : t('No commit hooks detected')}</dd>
        <dt>{t('Signing')}</dt><dd>{preview.signing ? t('Signed per your Git config ({{method}})', { method: preview.signing }) : t('Commit signing is not configured')}</dd>
      </dl>
      <p className="git-muted">{t('Only the index is committed ({{count}} files); unstaged changes are not included.', { count: `${preview.files.length}${preview.truncated ? '+' : ''}` })}</p>
      <ul className="git-file-list git-preview-files">{preview.files.map(file => <li key={pathKey(file.path)} className="git-change">
        <span className="git-change-open"><ChangeBadge change={letter[file.status as keyof typeof letter] ?? 'modified'} />
          <span className="git-change-name">{file.path.path}</span>{file.oldPath && <span className="git-change-dir">← {file.oldPath.path}</span>}</span>
      </li>)}</ul>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <>
          <span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Running the commit and hooks…')}</span>
          <button onClick={() => void gitApi.cancelOperation(projectId, repo.id)}>{t('Stop')}</button>
        </> : <>
          <button onClick={() => setPreview(null)}>{t('Cancel')}</button>
          <button data-dialog-confirm className="primary" onClick={() => void commit()}>{t('Create commit')}</button>
        </>}
      </div>
    </Dialog>}
  </div>;
}
