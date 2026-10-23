import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { CommitPreview, RepoInfo, RepoStatus } from './types';
import { operationLabel, pathKey } from './types';
import { ChangeBadge } from './GitChanges';

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
      onDone(`已建立 commit ${result.oid.slice(0, 7)}：${result.summary}`);
    } catch (failure) {
      setError(errorMessage(failure));
      onDone('');
    } finally { setRunning(false); }
  };
  const disabledReason = conflicts ? '仍有未解決的衝突' : !staged && !merging ? '沒有已暫存的變更' : !message.trim() ? '請輸入 commit 訊息' : '';
  return <div className="git-form">
    <label className="git-field">Commit 訊息
      <textarea rows={3} value={message} placeholder="第一行是摘要；空一行後寫說明" onChange={event => setMessage(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !disabledReason) { event.preventDefault(); void open(); }
        }} />
    </label>
    <div className="git-row">
      <span className="git-muted">{staged} 個已暫存檔案{merging ? '（合併中）' : ''}</span>
      <button className="primary" disabled={!!disabledReason || loading} title={disabledReason || '檢視將提交的內容（Ctrl/⌘+Enter）'} onClick={() => void open()}>
        {loading ? '讀取中…' : '檢視並 Commit'}</button>
    </div>
    {error && !preview && <p className="git-error" role="alert">{error}</p>}
    {preview && <Dialog title="確認建立 commit" wide onClose={() => { if (!running) setPreview(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd title={repo.root}>{repo.name} <span className="git-muted">{repo.root}</span></dd>
        <dt>Branch</dt><dd>{preview.branch ?? <span className="git-warning">detached HEAD（commit 不在任何 branch 上）</span>}
          {!preview.head && <span className="git-muted">（第一個 commit）</span>}</dd>
        {preview.operation && <><dt>狀態</dt><dd className="git-warning">{operationLabel[preview.operation]}</dd></>}
        {preview.author && <><dt>作者</dt><dd>{preview.author}</dd></>}
        <dt>訊息</dt><dd><pre className="git-message">{message}</pre></dd>
        <dt>Hooks</dt><dd>{preview.hooks.length ? `會執行：${preview.hooks.join('、')}` : '沒有偵測到 commit hooks'}</dd>
        <dt>簽章</dt><dd>{preview.signing ? `依 Git 設定簽章（${preview.signing}）` : '未設定 commit 簽章'}</dd>
      </dl>
      <p className="git-muted">只提交 index 中的內容（{preview.files.length}{preview.truncated ? '+' : ''} 個檔案）；未暫存的變更不會加入。</p>
      <ul className="git-file-list git-preview-files">{preview.files.map(file => <li key={pathKey(file.path)} className="git-change">
        <span className="git-change-open"><ChangeBadge change={letter[file.status as keyof typeof letter] ?? 'modified'} />
          <span className="git-change-name">{file.path.path}</span>{file.oldPath && <span className="git-change-dir">← {file.oldPath.path}</span>}</span>
      </li>)}</ul>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <>
          <span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 正在執行 commit 與 hooks…</span>
          <button onClick={() => void gitApi.cancelOperation(projectId, repo.id)}>停止</button>
        </> : <>
          <button onClick={() => setPreview(null)}>取消</button>
          <button data-dialog-confirm className="primary" onClick={() => void commit()}>建立 commit</button>
        </>}
      </div>
    </Dialog>}
  </div>;
}
