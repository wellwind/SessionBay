import { useState } from 'react';
import { CloudUpload, RefreshCw, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, Refs, RemoteTag, RepoInfo, Tag } from './types';

type Danger = { kind: 'deleteLocal'; tag: Tag } | { kind: 'deleteRemote'; tag: RemoteTag } | { kind: 'forcePush'; tag: Tag; remoteOid: string } | null;

/** Local and remote tags are separate; every push names one tag. */
export function TagsPanel({ projectId, repo, refs, onOutcome }: {
  projectId: string; repo: RepoInfo; refs: Refs | null; onOutcome: (outcome: Outcome | { error: string }) => void;
}) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState('');
  const [sign, setSign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState('');
  const [remoteTags, setRemoteTags] = useState<RemoteTag[] | null>(null);
  const [danger, setDanger] = useState<Danger>(null);
  const remoteName = remote || refs?.remotes[0]?.name || '';
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    try { onOutcome(await action()); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); }
  };
  const checkRemote = async () => {
    if (!remoteName) return;
    setBusy(true);
    try { setRemoteTags(await gitApi.remoteTags(projectId, repo.id, remoteName)); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); }
  };
  const published = (tag: Tag) => {
    if (!remoteTags) return null;
    const found = remoteTags.find(item => item.name === tag.name);
    return !found ? 'missing' : found.oid === tag.oid ? 'same' : 'different';
  };
  const tags = refs?.tags ?? [];
  return <div className="git-form">
    {refs && refs.remotes.length > 0 && <div className="git-row">
      <select aria-label="Tag 遠端" value={remoteName} onChange={event => { setRemote(event.target.value); setRemoteTags(null); }}>
        {refs.remotes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <button disabled={busy} onClick={() => void checkRemote()}><RefreshCw size={14} aria-hidden="true" />檢查遠端 tag</button>
    </div>}
    <ul className="git-file-list" aria-label="Tags">{tags.map(tag => {
      const state = published(tag);
      return <li key={tag.name} className="git-change">
        <span className="git-change-open" title={tag.message || undefined}>
          <span className="git-change-name">{tag.name}</span>
          <span className="git-change-dir">{tag.annotated ? 'annotated' : 'lightweight'} → {tag.target.slice(0, 7)}
            {state === 'same' ? ' · 已發布' : state === 'missing' ? ' · 未發布' : state === 'different' ? ' · 遠端指向不同' : ''}</span>
        </span>
        <span className="git-change-actions">
          {remoteName && state !== 'same' && <button disabled={busy} aria-label={`推送 tag ${tag.name} 到 ${remoteName}`} title={`只推送 ${tag.name}`}
            onClick={() => {
              const remoteTag = remoteTags?.find(item => item.name === tag.name);
              if (remoteTag && remoteTag.oid !== tag.oid) setDanger({ kind: 'forcePush', tag, remoteOid: remoteTag.oid });
              else void run(() => gitApi.pushTag(projectId, { repoId: repo.id, remote: remoteName, name: tag.name, force: false }));
            }}><CloudUpload size={14} /></button>}
          <button disabled={busy} aria-label={`刪除本機 tag ${tag.name}`} title="刪除本機 tag" onClick={() => setDanger({ kind: 'deleteLocal', tag })}><Trash2 size={14} /></button>
        </span>
      </li>;
    })}</ul>
    {!tags.length && <p className="git-muted">沒有 tag。</p>}
    {remoteTags && remoteTags.filter(item => !tags.some(tag => tag.name === item.name)).map(item => <div key={item.name} className="git-row">
      <span className="git-muted">只在 {remoteName}：{item.name}</span>
      <button disabled={busy} aria-label={`刪除 ${remoteName} 上的 tag ${item.name}`} onClick={() => setDanger({ kind: 'deleteRemote', tag: item })}><Trash2 size={14} /></button>
    </div>)}
    <form className="git-form git-inline-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) return;
      void run(() => gitApi.createTag(projectId, { repoId: repo.id, name: name.trim(), target: target.trim() || null, message: message.trim() || null, sign }))
        .then(() => { setName(''); setMessage(''); });
    }}>
      <label className="git-field">新 tag 名稱<input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="git-field">指向（預設 HEAD）<input value={target} onChange={event => setTarget(event.target.value)} /></label>
      <label className="git-field">訊息（填寫則建立 annotated tag）<textarea rows={2} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={sign} disabled={!message.trim()} onChange={event => setSign(event.target.checked)} />
        簽章（依本機 Git 簽章設定；未設定時會失敗）</label>
      <button type="submit" disabled={busy || !name.trim()}>建立 tag</button>
      <p className="git-muted">建立 tag 只在本機；推送需在清單中逐一選取。</p>
    </form>
    {danger?.kind === 'deleteLocal' && <DangerDialog title={`刪除本機 tag ${danger.tag.name}？`} confirmLabel="刪除本機 tag"
      acknowledge="我了解只刪除本機 tag，遠端不受影響"
      impact={<p>{repo.name} 的本機 tag <code>{danger.tag.name}</code>（{danger.tag.oid.slice(0, 7)}）會被刪除。已發布到遠端的同名 tag 不會被刪除。</p>}
      recovery="自動建立復原點，保存 tag 物件，可在「復原點」重新建立。"
      onClose={() => setDanger(null)}
      onConfirm={async () => onOutcome(await gitApi.deleteTag(projectId, { repoId: repo.id, name: danger.tag.name, expected: danger.tag.oid }))} />}
    {danger?.kind === 'deleteRemote' && <DangerDialog title={`刪除 ${remoteName} 上的 tag ${danger.tag.name}？`} confirmLabel="刪除遠端 tag"
      acknowledge={`我了解 ${remoteName} 上的 tag 會被刪除，其他人可能已在使用`}
      impact={<p>遠端 <strong>{remoteName}</strong> 的 tag <code>{danger.tag.name}</code>（{danger.tag.oid.slice(0, 7)}）會被刪除；已取得此 tag 的其他 clone 不會自動移除。本機 tag 不變。</p>}
      recovery={null}
      onClose={() => setDanger(null)}
      onConfirm={async () => { onOutcome(await gitApi.deleteRemoteTag(projectId, { repoId: repo.id, remote: remoteName, name: danger.tag.name, expected: danger.tag.oid })); await checkRemote(); }} />}
    {danger?.kind === 'forcePush' && <DangerDialog title={`移動已發布的 tag ${danger.tag.name}？`} confirmLabel="強制推送 tag"
      acknowledge="我了解遠端 tag 會改指向新的物件"
      impact={<p>{remoteName} 上的 <code>{danger.tag.name}</code> 目前指向 {danger.remoteOid.slice(0, 7)}，會改為 {danger.tag.oid.slice(0, 7)}。已取得舊 tag 的人不會自動更新，可能造成版本混淆。</p>}
      recovery={null}
      onClose={() => setDanger(null)}
      onConfirm={async () => { onOutcome(await gitApi.pushTag(projectId, { repoId: repo.id, remote: remoteName, name: danger.tag.name, force: true })); await checkRemote(); }} />}
  </div>;
}
