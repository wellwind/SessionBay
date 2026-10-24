import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { confirmAction } from '../confirmation';
import { gitApi } from './git-api';
import { chooseAll, chooseBlock, lineOffset, parseConflicts } from './conflict-markers';
import type { BlockChoice } from './conflict-markers';
import type { ConflictFile, ConflictSide, RepoPath, ResolveChoice } from './types';
import { operationLabel } from './types';

function SidePane({ side }: { side: ConflictSide }) {
  return <section className="git-conflict-side" aria-label={side.label}>
    <header><strong>{side.label}</strong>{side.detail && <span className="git-muted"> {side.detail}</span>}</header>
    {!side.present ? <p className="git-muted git-pad">此側沒有這個檔案（已刪除或尚未新增）。</p>
      : side.text === null ? <p className="git-muted git-pad">非文字內容（{side.size} bytes）；不顯示內容差異。</p>
        : <pre className="git-conflict-text">{side.text}</pre>}
  </section>;
}

const choiceText: Record<ResolveChoice, string> = {
  ours: '採用', theirs: '採用', base: '採用共同祖先版本', delete: '刪除此檔案', keepWorkTree: '保留目前工作目錄的檔案',
};

/** Three-way view with an editable result; saving and resolving are separate. */
export function ConflictView({ projectId, repoId, repoName, path, revision, onChanged }: {
  projectId: string; repoId: string; repoName: string; path: RepoPath; revision: string | undefined; onChanged: () => void;
}) {
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [token, setToken] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keepMarkers, setKeepMarkers] = useState(false);
  const [pending, setPending] = useState<{ choice: ResolveChoice; newPath: string } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await gitApi.conflictFile(projectId, repoId, path);
      setFile(next); setToken(next.token); setResult(next.result.text ?? ''); setDirty(false); setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }, [projectId, repoId, path]);
  useEffect(() => { void load(); }, [load]);
  // External changes reload only when nothing unsaved would be lost.
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    if (!dirty) void load();
  }, [revision, dirty, load]);

  const blocks = useMemo(() => parseConflicts(result), [result]);
  const edit = (next: string) => { setResult(next); setDirty(true); setNotice(''); };
  const focusBlock = (index: number) => {
    const block = blocks[index];
    if (!block || !editor.current) return;
    const offset = lineOffset(result, block.start);
    editor.current.focus();
    editor.current.setSelectionRange(offset, offset);
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const saved = await gitApi.saveConflict(projectId, { repoId, path, token, content: result });
      setToken(saved.token); setDirty(false); setNotice('已儲存結果；尚未標記為已解決。');
      onChanged();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const resolve = async () => {
    setBusy(true); setError('');
    try {
      const outcome = await gitApi.markResolved(projectId, { repoId, path, token, allowMarkers: keepMarkers });
      setNotice(outcome.message); onChanged(); await load();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const resolveWith = async (choice: ResolveChoice, newPath: string) => {
    setBusy(true); setError('');
    try {
      const outcome = await gitApi.resolveWith(projectId, { repoId, path, token, choice, newPath: newPath.trim() ? { path: newPath.trim() } : null });
      setNotice(outcome.message); setPending(null); onChanged(); await load();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };

  if (!file) return <div className="git-conflict">{error ? <p className="git-error" role="alert">{error}</p>
    : <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取衝突…</p>}</div>;
  const blockButtons: [BlockChoice, string][] = [['ours', `採用「${file.ours.label}」`], ['theirs', `採用「${file.theirs.label}」`],
    ['both', '兩者（我方在前）'], ['bothReverse', '兩者（對方在前）'], ...(blocks.some(block => block.base) ? [['base', '採用共同祖先'] as [BlockChoice, string]] : [])];
  return <div className="git-conflict">
    <div className="git-doc-toolbar">
      <span className="git-doc-title"><strong>衝突 {path.path}</strong>
        <span className="git-muted"> · {repoName}{file.operation ? ` · ${operationLabel[file.operation]}` : ''}</span></span>
      <button className="git-icon-button" aria-label="重新載入衝突" title={dirty ? '有未儲存的修改' : '重新載入'} disabled={busy}
        onClick={() => { void (dirty ? confirmAction('放棄未儲存的結果並重新載入？') : Promise.resolve(true)).then(ok => { if (ok) void load(); }); }}><RefreshCw size={14} /></button>
    </div>
    <p className="git-muted git-conflict-note">「我方／對方」依目前操作的實際語意命名，不一定代表你最新的修改。{!file.unmerged && ' 此檔案已不在衝突狀態。'}</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    {notice && <p className="git-success" role="status">{notice}</p>}
    <div className="git-conflict-sides">
      <SidePane side={file.base} /><SidePane side={file.ours} /><SidePane side={file.theirs} />
    </div>
    {file.textual && file.unmerged ? <section className="git-conflict-result" aria-label="合併結果">
      <div className="git-row">
        <strong>{file.result.label}</strong>
        <span className="git-muted">{blocks.length ? `剩 ${blocks.length} 個衝突區塊` : '沒有衝突標記'}{dirty ? ' · 未儲存' : ''}</span>
        <button onClick={() => edit(chooseAll(result, 'ours'))} disabled={!blocks.length}>全部採用我方</button>
        <button onClick={() => edit(chooseAll(result, 'theirs'))} disabled={!blocks.length}>全部採用對方</button>
      </div>
      {blocks.map((block, index) => <div key={`${block.start}:${index}`} className="git-row git-conflict-block" role="group" aria-label={`衝突區塊 ${index + 1}`}>
        <button className="git-link" onClick={() => focusBlock(index)}>區塊 {index + 1}（第 {block.start + 1} 行）</button>
        {blockButtons.map(([choice, label]) => <button key={choice} onClick={() => edit(chooseBlock(result, index, choice))}>{label}</button>)}
      </div>)}
      <textarea ref={editor} className="git-conflict-editor" aria-label="合併結果內容" spellCheck={false} value={result} onChange={event => edit(event.target.value)} />
      <div className="git-row">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} aria-hidden="true" />儲存結果</button>
        {blocks.length > 0 && !dirty && <label className="git-check"><input type="checkbox" checked={keepMarkers} onChange={event => setKeepMarkers(event.target.checked)} />我確定要保留衝突標記</label>}
        <button disabled={busy || dirty || (blocks.length > 0 && !keepMarkers)} title={dirty ? '請先儲存結果' : blocks.length ? '仍有衝突標記' : undefined}
          onClick={() => void resolve()}><CheckCircle2 size={14} aria-hidden="true" />標記為已解決</button>
      </div>
    </section> : file.unmerged && <section className="git-conflict-result" aria-label="整檔處置">
      <p>此衝突需要選擇整個檔案的結果{file.textual ? '' : '（非文字、刪除或新增衝突）'}：</p>
      <div className="git-row">
        {file.ours.present && <button onClick={() => setPending({ choice: 'ours', newPath: '' })}>採用「{file.ours.label}」</button>}
        {file.theirs.present && <button onClick={() => setPending({ choice: 'theirs', newPath: '' })}>採用「{file.theirs.label}」</button>}
        {file.base.present && <button onClick={() => setPending({ choice: 'base', newPath: '' })}>採用共同祖先</button>}
        {file.result.present && <button onClick={() => setPending({ choice: 'keepWorkTree', newPath: '' })}>保留工作目錄檔案</button>}
        <button className="danger" onClick={() => setPending({ choice: 'delete', newPath: '' })}>刪除檔案</button>
      </div>
    </section>}
    {pending && <Dialog title="確認衝突處置" onClose={() => { if (!busy) setPending(null); }}>
      <p>{pending.choice === 'ours' || pending.choice === 'theirs' ? `${choiceText[pending.choice]}「${file[pending.choice].label}」的 ${path.path}` : `${choiceText[pending.choice]}：${path.path}`}，並標記為已解決。</p>
      {pending.choice === 'delete' && <p className="git-warning">檔案會從工作目錄與 index 移除。</p>}
      {(pending.choice === 'ours' || pending.choice === 'theirs' || pending.choice === 'base') && <label className="git-field">改用新路徑保存（選填；原路徑會移除）
        <input value={pending.newPath} onChange={event => setPending({ ...pending, newPath: event.target.value })} placeholder={path.path} /></label>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => setPending(null)}>取消</button>
        <button data-dialog-confirm className={pending.choice === 'delete' ? 'danger' : 'primary'} disabled={busy} onClick={() => void resolveWith(pending.choice, pending.newPath)}>確認</button>
      </div>
    </Dialog>}
  </div>;
}
