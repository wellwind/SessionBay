import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, RepoInfo, RepoStatus, StashEntry } from './types';
import { formatTime } from './types';

export function StashPanel({ projectId, repo, status, onOutcome }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onOutcome: (outcome: Outcome | { error: string }) => void;
}) {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [danger, setDanger] = useState<{ kind: 'drop'; entry: StashEntry } | { kind: 'clear' } | null>(null);
  const load = useCallback(() => {
    gitApi.stashes(projectId, repo.id).then(setStashes).catch(failure => onOutcome({ error: errorMessage(failure) }));
  }, [projectId, repo.id, onOutcome]);
  useEffect(() => { load(); }, [load, status.stashCount, status.revision]);
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    try { onOutcome(await action()); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); load(); }
  };
  return <div className="git-form">
    <form className="git-form" onSubmit={event => {
      event.preventDefault();
      void run(() => gitApi.stashPush(projectId, { repoId: repo.id, message, includeUntracked: untracked, keepIndex })).then(() => setMessage(''));
    }}>
      <label className="git-field">Stash 訊息<input value={message} onChange={event => setMessage(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={untracked} onChange={event => setUntracked(event.target.checked)} />包含 untracked 檔案</label>
      <label className="git-check"><input type="checkbox" checked={keepIndex} onChange={event => setKeepIndex(event.target.checked)} />保留已暫存內容（--keep-index）</label>
      <button type="submit" disabled={busy || !status.entries.length}>Stash 變更</button>
    </form>
    {stashes.length > 0 && <>
      <label className="git-check"><input type="checkbox" checked={restoreIndex} onChange={event => setRestoreIndex(event.target.checked)} />套用時一併還原暫存狀態（--index）</label>
      <ul className="git-file-list" aria-label="Stash 清單">{stashes.map(entry => <li key={entry.oid} className="git-change">
        <span className="git-change-open"><code>stash@{`{${entry.index}}`}</code><span className="git-change-name">{entry.message}</span>
          <span className="git-change-dir">{formatTime(entry.createdAt)}</span></span>
        <span className="git-change-actions">
          <button disabled={busy} aria-label={`套用 stash@{${entry.index}}`} title="套用（保留 stash）"
            onClick={() => void run(() => gitApi.stashApply(projectId, { repoId: repo.id, index: entry.index, expected: entry.oid, pop: false, restoreIndex }))}><ArchiveRestore size={14} /></button>
          <button disabled={busy} aria-label={`套用並移除 stash@{${entry.index}}`} title="Pop（套用成功才移除）"
            onClick={() => void run(() => gitApi.stashApply(projectId, { repoId: repo.id, index: entry.index, expected: entry.oid, pop: true, restoreIndex }))}>Pop</button>
          <button disabled={busy} aria-label={`刪除 stash@{${entry.index}}`} title="刪除 stash" onClick={() => setDanger({ kind: 'drop', entry })}><Trash2 size={14} /></button>
        </span>
      </li>)}</ul>
      <button className="danger" disabled={busy} onClick={() => setDanger({ kind: 'clear' })}>清除全部 stash…</button>
    </>}
    {!stashes.length && <p className="git-muted">沒有 stash。</p>}
    {danger && <DangerDialog
      title={danger.kind === 'drop' ? `刪除 stash@{${danger.entry.index}}？` : `清除 ${repo.name} 的全部 stash？`}
      confirmLabel={danger.kind === 'drop' ? '刪除 stash' : `清除 ${stashes.length} 個 stash`}
      acknowledge={danger.kind === 'drop' ? '我了解此 stash 會從清單移除' : `我了解 ${stashes.length} 個 stash 會全部移除`}
      impact={danger.kind === 'drop' ? <p>{repo.name}：「{danger.entry.message}」會從 stash 清單移除。</p>
        : <ul>{stashes.map(entry => <li key={entry.oid}>{entry.message}</li>)}</ul>}
      recovery="自動建立復原點保存 stash commit，可在「復原點」放回 stash 清單（順序可能不同）。"
      onClose={() => setDanger(null)}
      onConfirm={async () => {
        const result = danger.kind === 'drop'
          ? await gitApi.stashDrop(projectId, { repoId: repo.id, index: danger.entry.index, expected: danger.entry.oid })
          : await gitApi.stashClear(projectId, { repoId: repo.id, expected: stashes.map(entry => entry.oid) });
        onOutcome(result); load();
      }} />}
  </div>;
}
