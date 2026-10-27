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
import { t } from '../i18n';

function SidePane({ side }: { side: ConflictSide }) {
  return <section className="git-conflict-side" aria-label={side.label}>
    <header><strong>{side.label}</strong>{side.detail && <span className="git-muted"> {side.detail}</span>}</header>
    {!side.present ? <p className="git-muted git-pad">{t('This side does not have the file (deleted or not added yet).')}</p>
      : side.text === null ? <p className="git-muted git-pad">{t('Non-text content ({{size}} bytes); no content diff is shown.', { size: side.size })}</p>
        : <pre className="git-conflict-text">{side.text}</pre>}
  </section>;
}

const choiceText: Record<ResolveChoice, string> = {
  ours: t('Use'), theirs: t('Use'), base: t('Use the common ancestor version'), delete: t('Delete this file'), keepWorkTree: t('Keep the current working tree file'),
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
      setToken(saved.token); setDirty(false); setNotice(t('Result saved; not marked as resolved yet.'));
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
    : <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Loading conflict…')}</p>}</div>;
  const blockButtons: [BlockChoice, string][] = [['ours', t('Use "{{side}}"', { side: file.ours.label })], ['theirs', t('Use "{{side}}"', { side: file.theirs.label })],
    ['both', t('Both (ours first)')], ['bothReverse', t('Both (theirs first)')], ...(blocks.some(block => block.base) ? [['base', t('Use common ancestor')] as [BlockChoice, string]] : [])];
  return <div className="git-conflict">
    <div className="git-doc-toolbar">
      <span className="git-doc-title"><strong>{t('Conflict {{file}}', { file: path.path })}</strong>
        <span className="git-muted"> · {repoName}{file.operation ? ` · ${operationLabel[file.operation]}` : ''}</span></span>
      <button className="git-icon-button" aria-label={t('Reload conflict')} title={dirty ? t('There are unsaved edits') : t('Reload')} disabled={busy}
        onClick={() => { void (dirty ? confirmAction(t('Discard the unsaved result and reload?')) : Promise.resolve(true)).then(ok => { if (ok) void load(); }); }}><RefreshCw size={14} /></button>
    </div>
    <p className="git-muted git-conflict-note">{t('"Ours" and "theirs" follow what the current operation actually means; they do not necessarily mean your latest changes.')}{!file.unmerged && t(' This file is no longer in conflict.')}</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    {notice && <p className="git-success" role="status">{notice}</p>}
    <div className="git-conflict-sides">
      <SidePane side={file.base} /><SidePane side={file.ours} /><SidePane side={file.theirs} />
    </div>
    {file.textual && file.unmerged ? <section className="git-conflict-result" aria-label={t('Merge result')}>
      <div className="git-row">
        <strong>{file.result.label}</strong>
        <span className="git-muted">{blocks.length ? t('{{count}} conflict blocks left', { count: blocks.length }) : t('No conflict markers')}{dirty ? t(' · unsaved') : ''}</span>
        <button onClick={() => edit(chooseAll(result, 'ours'))} disabled={!blocks.length}>{t('Use ours for all')}</button>
        <button onClick={() => edit(chooseAll(result, 'theirs'))} disabled={!blocks.length}>{t('Use theirs for all')}</button>
      </div>
      {blocks.map((block, index) => <div key={`${block.start}:${index}`} className="git-row git-conflict-block" role="group" aria-label={t('Conflict block {{number}}', { number: index + 1 })}>
        <button className="git-link" onClick={() => focusBlock(index)}>{t('Block {{number}} (line {{line}})', { number: index + 1, line: block.start + 1 })}</button>
        {blockButtons.map(([choice, label]) => <button key={choice} onClick={() => edit(chooseBlock(result, index, choice))}>{label}</button>)}
      </div>)}
      <textarea ref={editor} className="git-conflict-editor" aria-label={t('Merge result content')} spellCheck={false} value={result} onChange={event => edit(event.target.value)} />
      <div className="git-row">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} aria-hidden="true" />{t('Save result')}</button>
        {blocks.length > 0 && !dirty && <label className="git-check"><input type="checkbox" checked={keepMarkers} onChange={event => setKeepMarkers(event.target.checked)} />{t('I want to keep the conflict markers')}</label>}
        <button disabled={busy || dirty || (blocks.length > 0 && !keepMarkers)} title={dirty ? t('Save the result first') : blocks.length ? t('Conflict markers remain') : undefined}
          onClick={() => void resolve()}><CheckCircle2 size={14} aria-hidden="true" />{t('Mark as resolved')}</button>
      </div>
    </section> : file.unmerged && <section className="git-conflict-result" aria-label={t('Whole-file resolution')}>
      <p>{t('Choose the result for the whole file')}{file.textual ? '' : t(' (non-text, delete or add conflict)')}{t(':')}</p>
      <div className="git-row">
        {file.ours.present && <button onClick={() => setPending({ choice: 'ours', newPath: '' })}>{t('Use "{{side}}"', { side: file.ours.label })}</button>}
        {file.theirs.present && <button onClick={() => setPending({ choice: 'theirs', newPath: '' })}>{t('Use "{{side}}"', { side: file.theirs.label })}</button>}
        {file.base.present && <button onClick={() => setPending({ choice: 'base', newPath: '' })}>{t('Use common ancestor')}</button>}
        {file.result.present && <button onClick={() => setPending({ choice: 'keepWorkTree', newPath: '' })}>{t('Keep working tree file')}</button>}
        <button className="danger" onClick={() => setPending({ choice: 'delete', newPath: '' })}>{t('Delete file')}</button>
      </div>
    </section>}
    {pending && <Dialog title={t('Confirm conflict resolution')} onClose={() => { if (!busy) setPending(null); }}>
      <p>{pending.choice === 'ours' || pending.choice === 'theirs' ? t('{{action}} the "{{side}}" version of {{path}} and mark it resolved.', { action: choiceText[pending.choice], side: file[pending.choice].label, path: path.path }) : t('{{action}}: {{path}}, and mark it resolved.', { action: choiceText[pending.choice], path: path.path })}</p>
      {pending.choice === 'delete' && <p className="git-warning">{t('The file will be removed from the working tree and the index.')}</p>}
      {(pending.choice === 'ours' || pending.choice === 'theirs' || pending.choice === 'base') && <label className="git-field">{t('Save to a new path instead (optional; the original path is removed)')}
        <input value={pending.newPath} onChange={event => setPending({ ...pending, newPath: event.target.value })} placeholder={path.path} /></label>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => setPending(null)}>{t('Cancel')}</button>
        <button data-dialog-confirm className={pending.choice === 'delete' ? 'danger' : 'primary'} disabled={busy} onClick={() => void resolveWith(pending.choice, pending.newPath)}>{t('Confirm')}</button>
      </div>
    </Dialog>}
  </div>;
}
