import { useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { agentNames } from '../agents';
import { t } from '../i18n';
import { gitApi } from '../git/git-api';
import type { RepoInfo } from '../git/types';
import type { KanbanCard, KanbanColumn, KanbanSession, KanbanSessionDisposition, Project, Session } from '../types';
import { Dialog } from './Dialog';
import { dateLabel } from './History';
import { KanbanMenu } from './KanbanMenu';
import { columnName } from './useKanbanBoards';

export type KanbanMutation = (action: () => Promise<unknown>, message?: string, focusCard?: string) => Promise<boolean>;
export function KanbanCardDetails({ card, project, done, busy, error, mutate, onClose, onStart, onResume, status, onHistoryChanged, mergeTargets, onMerge, columns, onMove, onArchive, columnCards, onPosition, feedback, initialMerge = false }: {
  card: KanbanCard; project: Project; done: boolean; busy: boolean; error: string; mutate: KanbanMutation;
  onClose: () => void; onStart?: (card: KanbanCard) => void; onResume?: (session: Session) => void;
  feedback?: ReactNode;
  columnCards: KanbanCard[]; onPosition: (position: number) => void;
  columns: KanbanColumn[]; onMove: (column: KanbanColumn) => void; onArchive: () => Promise<boolean>; initialMerge?: boolean;
  mergeTargets: KanbanCard[]; onMerge: (target: string) => void;
  status: (link: KanbanSession) => { text: string }; onHistoryChanged?: () => Promise<void>;
}) {
  const [title, setTitle] = useState(card.title), [notes, setNotes] = useState(card.notes);
  const [mode, setMode] = useState<'edit' | 'delete' | 'recycle' | 'discard'>('edit');
  const [showMerge, setShowMerge] = useState(initialMerge);
  const [mergeTarget, setMergeTarget] = useState('');
  const [history, setHistory] = useState<Session[] | null>(null), [historyId, setHistoryId] = useState('');
  const [disposition, setDisposition] = useState<KanbanSessionDisposition>('unsorted');
  const [queue, setQueue] = useState<Session[]>([]);
  const [worktree, setWorktree] = useState(false), [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoId, setRepoId] = useState(''), [branch, setBranch] = useState('');
  const createdWorktree = useRef<string | null>(null);
  const dirty = title !== card.title || notes !== card.notes;
  const blocked = busy || dirty;
  const latestSession = [...card.sessions].sort((a, b) => new Date(b.session.updatedAt).getTime() - new Date(a.session.updatedAt).getTime())[0]?.session;
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
  return <Dialog key={mode} title={t('Task details')} drawer headerActions={<label className="kanban-stage-select"><span>{t('Stage')}</span><select value={card.columnId} disabled={blocked || card.archived} onChange={event => { const target = columns.find(column => column.id === event.target.value); if (target) onMove(target); }}>{columns.map(column => <option key={column.id} value={column.id}>{columnName(column)}</option>)}</select></label>} headerEnd={<KanbanMenu label={t('Task actions')} disabled={busy}>
        <label className="field-label">{t('Position')}<select disabled={blocked || card.archived} value={columnCards.findIndex(item => item.id === card.id)}
          onChange={event => onPosition(Number(event.target.value))}>{columnCards.map((item, index) => <option key={item.id} value={index}>{index + 1}</option>)}</select></label>{!card.archived && !card.worktreePath && <button disabled={blocked} onClick={() => { setWorktree(true); if (!worktree) void mutate(async () => { const found = await gitApi.discover(project.id); if (found.state !== 'ready') throw new Error(found.message); setRepos(found.repos); setRepoId(found.repos[0]?.id ?? ''); }); }}>{t('Create worktree for task')}</button>}
        {!card.archived && mergeTargets.length > 0 && <button disabled={blocked} onClick={() => setShowMerge(true)}>{t('Merge…')}</button>}
        {done && !card.archived && <button disabled={blocked} onClick={async () => { if (await onArchive()) onClose(); }}>{t('Archive task')}</button>}
        <button disabled={blocked} onClick={() => setMode('delete')}>{t('Delete task')}</button>
        <button disabled={blocked || !card.sessions.length} onClick={() => { setQueue(card.sessions.map(link => link.session)); setMode('recycle'); }}>{t('Recycle attached sessions…')}</button>
      </KanbanMenu>} onClose={() => { if (!busy) { if (dirty) setMode('discard'); else onClose(); } }}>
    <div className="kanban-details">
      <label className="field-label">{t('Task title')}<input data-dialog-initial-focus maxLength={500} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <div className="dialog-actions kanban-primary-actions">
        {!card.archived && <button className="primary" disabled={busy || !onStart} onClick={async () => {
          if (!dirty || await save()) onStart?.({ ...card, title, notes });
        }}>{dirty ? t('Save and start') : t('Start work')}</button>}
        {latestSession && <button className="secondary" disabled={blocked || !onResume || !!latestSession.resumeDisabledReason}
          onClick={() => onResume?.(latestSession)}>{t('Resume latest session')}</button>}
        {card.archived && <button disabled={blocked} onClick={async () => { if (await mutate(() => api.archiveKanbanCard(card.id, false))) onClose(); }}>{t('Restore task')}</button>}
      </div>
      <form className="kanban-notes-form" onSubmit={event => { event.preventDefault(); if (!busy && dirty) void save(); }}>
        <label className="field-label">{t('Notes')}<textarea rows={6} value={notes} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
        <div className="dialog-actions"><button className="secondary" disabled={busy || !dirty}>{t('Save')}</button></div>
      </form>
      {card.worktreePath && <p className="kanban-detail-path">{t('Worktree: {{path}}', { path: card.worktreePath })}</p>}
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
      <div className="kanban-sessions-header"><h3>{t('Attached sessions')}</h3>
      {!card.archived && <button className="secondary" disabled={blocked} onClick={() => void mutate(async () => {
          const result = await api.sessions({ projectId: project.id, offset: 0, limit: 100 });
          setHistory(result.items); setHistoryId('');
        })}>{t('Attach from history')}</button>}</div>
      {!card.archived && <div className="kanban-attach-history">
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
      {!card.sessions.length && <p className="small-muted">{t('No sessions attached. Start work to attach a new session.')}</p>}
      <ul className="kanban-detail-sessions">{card.sessions.map(link => <li key={link.session.id}>
        <div><strong>{link.session.title || link.session.externalId}</strong><p className="small-muted">{agentNames[link.session.kind]} · {status(link).text}</p>{link.branch && <span className="kanban-detail-path">{link.branch}</span>}</div>
        <div className="kanban-session-actions"><button className="secondary" disabled={blocked || !onResume || !!link.session.resumeDisabledReason} title={link.session.resumeDisabledReason ?? undefined} onClick={() => onResume?.(link.session)}>{t('Resume')}</button>
          <button className="secondary" disabled={blocked || card.archived} onClick={() => void mutate(() => api.splitKanbanSession(card.id, link.session.id))}>{t('Split into new task')}</button></div>
      </li>)}</ul>
      {!card.archived && mergeTargets.length > 0 && <details className="kanban-merge-form" open={showMerge} onToggle={event => setShowMerge(event.currentTarget.open)}><summary>{t('Merge tasks')}</summary>
        <label className="field-label">{t('Merge into task')}<select value={mergeTarget} disabled={blocked} onChange={event => setMergeTarget(event.target.value)}>
          <option value="">{t('Choose a task')}</option>{mergeTargets.map(target => <option key={target.id} value={target.id}>{target.title || t('Untitled task')}</option>)}</select></label>
        <button disabled={blocked || !mergeTarget} onClick={() => onMerge(mergeTarget)}>{t('Merge tasks')}</button>
      </details>}
      <div className="kanban-detail-times"><span>{t('Created {{time}}', { time: dateLabel(card.createdAt) })}</span><span>{t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}</span></div>
      {error && <p className="inline-warning" role="alert">{error}</p>}
      {feedback}
    </div>
  </Dialog>;
}
