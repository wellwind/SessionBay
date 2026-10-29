import { useRef, useState } from 'react';
import { api } from '../api';
import { agentNames } from '../agents';
import { t } from '../i18n';
import { gitApi } from '../git/git-api';
import type { RepoInfo } from '../git/types';
import type { KanbanCard, KanbanSession, KanbanSessionDisposition, Project, Session } from '../types';
import { Dialog } from './Dialog';
import { dateLabel } from './History';

export type KanbanMutation = (action: () => Promise<unknown>, message?: string, focusCard?: string) => Promise<boolean>;
export function KanbanCardDetails({ card, project, done, busy, error, mutate, onClose, onStart, onResume, status, onHistoryChanged, mergeTargets, onMerge }: {
  card: KanbanCard; project: Project; done: boolean; busy: boolean; error: string; mutate: KanbanMutation;
  onClose: () => void; onStart?: (card: KanbanCard) => void; onResume?: (session: Session) => void;
  mergeTargets: KanbanCard[]; onMerge: (target: string) => void;
  status: (link: KanbanSession) => { text: string }; onHistoryChanged?: () => Promise<void>;
}) {
  const [title, setTitle] = useState(card.title), [notes, setNotes] = useState(card.notes);
  const [mode, setMode] = useState<'edit' | 'delete' | 'recycle' | 'discard'>('edit');
  const [mergeTarget, setMergeTarget] = useState('');
  const [history, setHistory] = useState<Session[] | null>(null), [historyId, setHistoryId] = useState('');
  const [disposition, setDisposition] = useState<KanbanSessionDisposition>('unsorted');
  const [queue, setQueue] = useState<Session[]>([]);
  const [worktree, setWorktree] = useState(false), [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoId, setRepoId] = useState(''), [branch, setBranch] = useState('');
  const createdWorktree = useRef<string | null>(null);
  const dirty = title !== card.title || notes !== card.notes;
  const blocked = busy || dirty;
  if (mode === 'discard') return <Dialog key={mode} title={t('Discard task changes?')} onClose={() => setMode('edit')}>
    <p>{t('The title and notes have unsaved changes.')}</p>
    <div className="dialog-actions"><button onClick={() => setMode('edit')}>{t('Cancel')}</button><button className="danger" data-dialog-confirm onClick={onClose}>{t('Discard changes')}</button></div>
  </Dialog>;
  const save = () => mutate(() => api.editKanbanCard(card.id, title, notes));
  if (mode === 'delete') return <Dialog key={mode} title={t('Delete task?')} onClose={() => { if (!busy) setMode('edit'); }}>
    <p>{t('Only the task is deleted. Its sessions and agent files are kept.')}</p>
    <label className="field-label">{t('Attached sessions')}<select value={disposition} disabled={busy} onChange={event => setDisposition(event.target.value as KanbanSessionDisposition)}>
      <option value="unsorted">{t('Return to Unsorted')}</option><option value="detach">{t('Leave the board')}</option>
    </select></label>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={() => setMode('edit')}>{t('Cancel')}</button>
      <button className="danger" data-dialog-confirm disabled={busy} onClick={async () => { if (await mutate(() => api.deleteKanbanCard(card.id, disposition))) onClose(); }}>{t('Delete task')}</button></div>
  </Dialog>;
  if (mode === 'recycle' && queue.length) {
    const session = queue[0];
    return <Dialog key={mode} title={t('Move to the recycle bin?')} onClose={() => { if (!busy) setMode('edit'); }}>
      <p>{t('"{{title}}" will be hidden from Session Bay history and search; you can restore it from the recycle bin later.', { title: session.title || session.externalId })}</p>
      <p className="small-muted">{t('Confirm each session separately. Remaining: {{count}}', { count: queue.length })}</p>
      {error && <p role="alert" className="inline-warning">{error}</p>}
      <div className="dialog-actions"><button disabled={busy} onClick={() => setMode('edit')}>{t('Cancel')}</button>
        <button disabled={busy} onClick={() => { setQueue(queue.slice(1)); if (queue.length === 1) setMode('edit'); }}>{t('Skip')}</button>
        <button className="primary" data-dialog-confirm disabled={busy || !session.trashIdentity} onClick={async () => {
          if (!session.trashIdentity) return;
          let moved = false;
          await mutate(async () => {
            await api.trashSession(session.id, session.trashIdentity!);
            moved = true;
            await onHistoryChanged?.();
          });
          if (moved) { setQueue(queue.slice(1)); if (queue.length === 1) setMode('edit'); }
        }}>{t('Move to recycle bin')}</button></div>
      {!session.trashIdentity && <p className="inline-warning">{t('Refresh history before recycling this session.')}</p>}
    </Dialog>;
  }
  return <Dialog key={mode} title={t('Task details')} wide onClose={() => { if (!busy) { if (dirty) setMode('discard'); else onClose(); } }}>
    <div className="kanban-details">
      <form onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
        <label className="field-label">{t('Task title')}<input maxLength={500} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <label className="field-label">{t('Notes')}<textarea rows={6} value={notes} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
        <div className="dialog-actions"><button className="primary" disabled={busy || !dirty}>{t('Save changes')}</button></div>
      </form>
      {dirty && <p className="small-muted">{t('Save changes before starting work or changing this task.')}</p>}
      <div className="kanban-detail-times"><span>{t('Created {{time}}', { time: dateLabel(card.createdAt) })}</span><span>{t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}</span></div>
      {card.worktreePath && <p className="kanban-detail-path">{t('Worktree: {{path}}', { path: card.worktreePath })}</p>}
      <div className="dialog-actions">
        {!card.archived && <button className="primary" disabled={blocked || !onStart} onClick={() => onStart?.(card)}>{t('Start work')}</button>}
        {card.archived && <button disabled={blocked} onClick={async () => { if (await mutate(() => api.archiveKanbanCard(card.id, false))) onClose(); }}>{t('Restore task')}</button>}
        {!card.archived && !card.worktreePath && <button disabled={blocked} onClick={() => { setWorktree(!worktree); if (!worktree) void mutate(async () => { const found = await gitApi.discover(project.id); if (found.state !== 'ready') throw new Error(found.message); setRepos(found.repos); setRepoId(found.repos[0]?.id ?? ''); }); }}>{t('Create worktree for task')}</button>}
      </div>
      {worktree && <form className="kanban-worktree-form" onSubmit={event => {
        event.preventDefault();
        if (blocked || !repoId || !branch.trim()) return;
        void mutate(async () => {
          // Retain a successfully created checkout if catalog binding fails; retry only the binding.
          createdWorktree.current ??= (await gitApi.worktreeAdd(project.id, { repoId, branch: branch.trim(), create: true, base: null, path: null })).path;
          await api.bindKanbanWorktree(card.id, createdWorktree.current);
          setWorktree(false); createdWorktree.current = null; setBranch('');
        });
      }}>
        <label className="field-label">{t('Repository')}<select disabled={busy || !!createdWorktree.current} value={repoId} onChange={event => setRepoId(event.target.value)}>{repos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
        <label className="field-label">{t('Branch name')}<input required disabled={busy || !!createdWorktree.current} value={branch} onChange={event => setBranch(event.target.value)} /></label>
        <button disabled={blocked || !repoId || !branch.trim()}>{t('Create worktree')}</button>
      </form>}
      {!card.archived && <div className="kanban-attach-history">
        <button disabled={blocked} onClick={() => void mutate(async () => {
          const result = await api.sessions({ projectId: project.id, offset: 0, limit: 100 });
          setHistory(result.items); setHistoryId('');
        })}>{t('Attach from history')}</button>
        {history && <form onSubmit={event => {
          event.preventDefault();
          if (!blocked && historyId) void mutate(async () => { await api.attachKanbanSession(card.id, historyId); setHistory(null); });
        }}>
          <label className="field-label">{t('Session')}<select disabled={blocked} value={historyId} onChange={event => setHistoryId(event.target.value)}>
            <option value="">{t('Choose a session')}</option>{history.filter(session => !card.sessions.some(link => link.session.id === session.id)).map(session => <option key={session.id} value={session.id}>{agentNames[session.kind]} · {session.title || session.externalId}</option>)}
          </select></label><button disabled={blocked || !historyId}>{t('Attach session')}</button>
          <p className="small-muted">{t('Showing up to 100 recent sessions in this project. Attaching moves a session from its previous task.')}</p>
        </form>}
      </div>}
      <h3>{t('Attached sessions')}</h3>
      {!card.sessions.length && <p className="small-muted">{t('No sessions attached. Start work to attach a new session.')}</p>}
      <ul className="kanban-detail-sessions">{card.sessions.map(link => <li key={link.session.id}>
        <div><strong>{link.session.title || link.session.externalId}</strong><p className="small-muted">{agentNames[link.session.kind]} · {status(link).text}</p>{link.branch && <span className="kanban-detail-path">{link.branch}</span>}</div>
        <div className="kanban-session-actions"><button disabled={blocked || !onResume || !!link.session.resumeDisabledReason} title={link.session.resumeDisabledReason ?? undefined} onClick={() => onResume?.(link.session)}>{t('Resume')}</button>
          <button disabled={blocked || card.archived} onClick={() => void mutate(() => api.splitKanbanSession(card.id, link.session.id))}>{t('Split into new task')}</button></div>
      </li>)}</ul>
      {!card.archived && mergeTargets.length > 0 && <details className="kanban-merge-form"><summary>{t('Merge tasks')}</summary>
        <label className="field-label">{t('Merge into task')}<select value={mergeTarget} disabled={blocked} onChange={event => setMergeTarget(event.target.value)}>
          <option value="">{t('Choose a task')}</option>{mergeTargets.map(target => <option key={target.id} value={target.id}>{target.title || t('Untitled task')}</option>)}</select></label>
        <button disabled={blocked || !mergeTarget} onClick={() => onMerge(mergeTarget)}>{t('Merge tasks')}</button>
      </details>}
      {done && !card.archived && <div className="kanban-done-actions">
        <h3>{t('Done actions')}</h3>
        <div className="dialog-actions"><button disabled={blocked} onClick={async () => { if (await mutate(() => api.archiveKanbanCard(card.id, true))) onClose(); }}>{t('Archive task')}</button>
          <button className="danger" disabled={blocked} onClick={() => setMode('delete')}>{t('Delete task')}</button>
          <button className="danger" disabled={blocked || !card.sessions.length} onClick={() => { setQueue(card.sessions.map(link => link.session)); setMode('recycle'); }}>{t('Recycle attached sessions…')}</button></div>
      </div>}
      {error && <p className="inline-warning" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
