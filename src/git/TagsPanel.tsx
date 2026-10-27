import { useState } from 'react';
import { CloudUpload, RefreshCw, Trash2 } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Outcome, Refs, RemoteTag, RepoInfo, Tag } from './types';
import { t } from '../i18n';

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
      <select aria-label={t('Tag remote')} value={remoteName} onChange={event => { setRemote(event.target.value); setRemoteTags(null); }}>
        {refs.remotes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>
      <button disabled={busy} onClick={() => void checkRemote()}><RefreshCw size={14} aria-hidden="true" />{t('Check remote tags')}</button>
    </div>}
    <ul className="git-file-list" aria-label="Tags">{tags.map(tag => {
      const state = published(tag);
      return <li key={tag.name} className="git-change">
        <span className="git-change-open" title={tag.message || undefined}>
          <span className="git-change-name">{tag.name}</span>
          <span className="git-change-dir">{tag.annotated ? 'annotated' : 'lightweight'} → {tag.target.slice(0, 7)}
            {state === 'same' ? t(' · published') : state === 'missing' ? t(' · not published') : state === 'different' ? t(' · remote points elsewhere') : ''}</span>
        </span>
        <span className="git-change-actions">
          {remoteName && state !== 'same' && <button disabled={busy} aria-label={t('Push tag {{tag}} to {{remote}}', { tag: tag.name, remote: remoteName })} title={t('Push only {{tag}}', { tag: tag.name })}
            onClick={() => {
              const remoteTag = remoteTags?.find(item => item.name === tag.name);
              if (remoteTag && remoteTag.oid !== tag.oid) setDanger({ kind: 'forcePush', tag, remoteOid: remoteTag.oid });
              else void run(() => gitApi.pushTag(projectId, { repoId: repo.id, remote: remoteName, name: tag.name, force: false }));
            }}><CloudUpload size={14} /></button>}
          <button disabled={busy} aria-label={t('Delete local tag {{tag}}', { tag: tag.name })} title={t('Delete local tag')} onClick={() => setDanger({ kind: 'deleteLocal', tag })}><Trash2 size={14} /></button>
        </span>
      </li>;
    })}</ul>
    {!tags.length && <p className="git-muted">{t('No tags.')}</p>}
    {remoteTags && remoteTags.filter(item => !tags.some(tag => tag.name === item.name)).map(item => <div key={item.name} className="git-row">
      <span className="git-muted">{t('Only on {{remote}}: {{tag}}', { remote: remoteName, tag: item.name })}</span>
      <button disabled={busy} aria-label={t('Delete tag {{tag}} on {{remote}}', { tag: item.name, remote: remoteName })} onClick={() => setDanger({ kind: 'deleteRemote', tag: item })}><Trash2 size={14} /></button>
    </div>)}
    <form className="git-form git-inline-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) return;
      void run(() => gitApi.createTag(projectId, { repoId: repo.id, name: name.trim(), target: target.trim() || null, message: message.trim() || null, sign }))
        .then(() => { setName(''); setMessage(''); });
    }}>
      <label className="git-field">{t('New tag name')}<input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="git-field">{t('Points to (defaults to HEAD)')}<input value={target} onChange={event => setTarget(event.target.value)} /></label>
      <label className="git-field">{t('Message (creates an annotated tag)')}<textarea rows={2} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={sign} disabled={!message.trim()} onChange={event => setSign(event.target.checked)} />
        {t('Sign (uses your local Git signing config; fails if none is set)')}</label>
      <button type="submit" disabled={busy || !name.trim()}>{t('Create tag')}</button>
      <p className="git-muted">{t('Tags are created locally only; push each one from the list.')}</p>
    </form>
    {danger?.kind === 'deleteLocal' && <DangerDialog title={t('Delete local tag {{tag}}?', { tag: danger.tag.name })} confirmLabel={t('Delete local tag')}
      acknowledge={t('I understand only the local tag is deleted; the remote is not affected')}
      impact={<p>{t('Local tag {{tag}} ({{commit}}) in {{repo}} will be deleted. A tag with the same name on a remote is not deleted.', { repo: repo.name, tag: danger.tag.name, commit: danger.tag.oid.slice(0, 7) })}</p>}
      recovery={t('A recovery point saves the tag object, so you can recreate it from "Recovery points".')}
      onClose={() => setDanger(null)}
      onConfirm={async () => onOutcome(await gitApi.deleteTag(projectId, { repoId: repo.id, name: danger.tag.name, expected: danger.tag.oid }))} />}
    {danger?.kind === 'deleteRemote' && <DangerDialog title={t('Delete tag {{tag}} on {{remote}}?', { remote: remoteName, tag: danger.tag.name })} confirmLabel={t('Delete remote tag')}
      acknowledge={t('I understand the tag on {{remote}} will be deleted and others may already use it', { remote: remoteName })}
      impact={<p>{t('Tag {{tag}} ({{commit}}) on remote {{remote}} will be deleted. Other clones that already fetched it keep it. The local tag is unchanged.', { remote: remoteName, tag: danger.tag.name, commit: danger.tag.oid.slice(0, 7) })}</p>}
      recovery={null}
      onClose={() => setDanger(null)}
      onConfirm={async () => { onOutcome(await gitApi.deleteRemoteTag(projectId, { repoId: repo.id, remote: remoteName, name: danger.tag.name, expected: danger.tag.oid })); await checkRemote(); }} />}
    {danger?.kind === 'forcePush' && <DangerDialog title={t('Move published tag {{tag}}?', { tag: danger.tag.name })} confirmLabel={t('Force push tag')}
      acknowledge={t('I understand the remote tag will point to a new object')}
      impact={<p>{t('{{tag}} on {{remote}} points to {{from}} and will point to {{to}}. People who already fetched the old tag are not updated automatically, which can cause version confusion.', { remote: remoteName, tag: danger.tag.name, from: danger.remoteOid.slice(0, 7), to: danger.tag.oid.slice(0, 7) })}</p>}
      recovery={null}
      onClose={() => setDanger(null)}
      onConfirm={async () => { onOutcome(await gitApi.pushTag(projectId, { repoId: repo.id, remote: remoteName, name: danger.tag.name, force: true })); await checkRemote(); }} />}
  </div>;
}
