import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { api } from '../api';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import { gitApi } from '../git/git-api';
import type { RepoInfo } from '../git/types';
import type { KanbanCard, KanbanColumn, KanbanSession, KanbanSessionDisposition, Project, Session } from '../types';
import { AgentIcon } from './AgentIcon';
import { Dialog } from './Dialog';
import { dateLabel } from './History';
import { KanbanMenu } from './KanbanMenu';
import { cardTitle, columnName, latestSession } from './useKanbanBoards';

export type KanbanMutation = (action: () => Promise<unknown>, message?: string, focusCard?: string) => Promise<boolean>;
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
const SAVE_DELAY = 600;

/** Task drawer: title and notes save themselves; one primary action continues or starts the work. */
export function KanbanCardDetails({ card, project, columns, busy, error, mutate, save, status, onClose, onMove, onArchive, onStart, onResume,
  onHistoryChanged, mergeTargets, onMerge, feedback }: {
  card: KanbanCard; project: Project; columns: KanbanColumn[]; busy: boolean; error: string; mutate: KanbanMutation;
  save: (id: string, title: string, notes: string) => Promise<boolean>;
  status: (link: KanbanSession) => { text: string };
  onClose: () => void; onMove: (column: KanbanColumn) => void; onArchive: () => Promise<boolean>;
  onStart?: (card: KanbanCard) => void; onResume?: (session: Session) => void; onHistoryChanged?: () => Promise<void>;
  mergeTargets: KanbanCard[]; onMerge: (target: string) => void; feedback?: ReactNode;
}) {
  const [title, setTitle] = useState(card.title), [notes, setNotes] = useState(card.notes);
  const saved = useRef({ title: card.title, notes: card.notes });
  const pending = useRef<Promise<boolean> | null>(null);
  const draft = useRef({ title, notes });
  draft.current = { title, notes };
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [mode, setMode] = useState<'edit' | 'delete' | 'recycle'>('edit');
  const [showMerge, setShowMerge] = useState(false), [mergeTarget, setMergeTarget] = useState('');
  const [history, setHistory] = useState<Session[] | null>(null), [historyId, setHistoryId] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const historySearch = useDeferredValue(historyQuery.trim().toLocaleLowerCase(locale()));
  const [disposition, setDisposition] = useState<KanbanSessionDisposition>('unsorted');
  const [queue, setQueue] = useState<Session[]>([]);
  const [worktree, setWorktree] = useState(false), [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoId, setRepoId] = useState(''), [branch, setBranch] = useState('');
  const createdWorktree = useRef<string | null>(null);
  const dirty = title !== saved.current.title || notes !== saved.current.notes;
  const column = columns.find(column => column.id === card.columnId);
  const done = column?.stage === 'done';
  const latest = latestSession(card);
  const canContinue = !card.archived && !!latest && !!onResume && !latest.resumeDisabledReason;

  // Serialize saves so a slow write never lands after a newer one.
  const flush = async (): Promise<boolean> => {
    if (pending.current) await pending.current;
    const next = draft.current;
    if (next.title === saved.current.title && next.notes === saved.current.notes) return true;
    setSaveState('saving');
    const attempt = save(card.id, next.title, next.notes).then(ok => {
      if (ok) saved.current = next;
      setSaveState(ok ? 'saved' : 'failed');
      return ok;
    }).finally(() => { pending.current = null; });
    pending.current = attempt;
    return attempt;
  };
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void flush(), SAVE_DELAY);
    return () => clearTimeout(timer);
    // flush reads the latest draft through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, notes, dirty]);
  const close = async () => { if (!busy && await flush()) onClose(); };
  const start = async () => { if (await flush()) onStart?.({ ...card, title, notes }); };
  const resume = async (session: Session) => { if (await flush()) onResume?.(session); };

  if (mode === 'delete') return <Dialog key={mode} title={t('Delete task?')} onClose={() => { if (!busy) setMode('edit'); }}>
    <p>{t('Only the task is deleted. Its sessions and agent files are kept.')}</p>
    <label className="field-label">{t('Attached sessions')}<select value={disposition} disabled={busy} onChange={event => setDisposition(event.target.value as KanbanSessionDisposition)}>
      <option value="unsorted">{t('Suggest them again')}</option><option value="detach">{t('Leave the board')}</option>
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
  const stageOptions = columns.filter(item => item.stage !== 'unsorted' || item.id === card.columnId);
  const candidates = history?.filter(session => !card.sessions.some(link => link.session.id === session.id)
    && (!historySearch || `${agentNames[session.kind]} ${session.title} ${session.externalId}`.toLocaleLowerCase(locale()).includes(historySearch))) ?? [];
  return <Dialog key={mode} title={t('Task')} drawer
    headerActions={<label className="kanban-stage-select"><span className={`kanban-stage-dot stage-${column?.stage ?? 'todo'}`} aria-hidden="true" /><span className="organization-sr-only">{t('Stage')}</span>
      <select aria-label={t('Stage')} value={card.columnId} disabled={busy || card.archived} onChange={event => { const target = columns.find(column => column.id === event.target.value); if (target) onMove(target); }}>
        {stageOptions.map(column => <option key={column.id} value={column.id} disabled={column.stage === 'unsorted'}>{columnName(column)}</option>)}</select></label>}
    headerEnd={<KanbanMenu label={t('Task actions')} disabled={busy}>
      {!card.archived && mergeTargets.length > 0 && <button onClick={() => setShowMerge(true)}>{t('Merge into another task…')}</button>}
      {!card.archived && !card.worktreePath && <button onClick={() => { setWorktree(true); if (!worktree) void mutate(async () => { const found = await gitApi.discover(project.id); if (found.state !== 'ready') throw new Error(found.message); setRepos(found.repos); setRepoId(found.repos[0]?.id ?? ''); }); }}>{t('Create worktree for task')}</button>}
      {done && !card.archived && <button onClick={async () => { if (await flush() && await onArchive()) onClose(); }}>{t('Archive task')}</button>}
      <button disabled={!card.sessions.length} onClick={() => { setQueue(card.sessions.map(link => link.session)); setMode('recycle'); }}>{t('Recycle attached sessions…')}</button>
      <button className="danger-text" onClick={() => setMode('delete')}>{t('Delete task…')}</button>
    </KanbanMenu>} onClose={() => void close()}>
    <div className="kanban-details">
      <label className="field-label kanban-title-field">{t('Title')}<input data-dialog-initial-focus maxLength={500} value={title}
        placeholder={t('Untitled task')} onChange={event => setTitle(event.target.value)} /></label>
      <div className="kanban-notes-field">
        <div className="kanban-notes-label"><label htmlFor={`notes-${card.id}`}>{t('Notes')}</label>
          <span className={`kanban-save-state save-${saveState}`} role="status" aria-live="polite" key={dirty && saveState !== 'saving' ? 'editing' : saveState}>
            {saveState === 'saving' ? t('Saving…') : saveState === 'failed' ? <button className="link-button" onClick={() => void flush()}>{t('Not saved. Try again')}</button>
              : saveState === 'saved' && !dirty ? t('Saved') : ''}</span></div>
        <textarea id={`notes-${card.id}`} rows={6} value={notes} placeholder={t('What should the agent do? Notes are pasted into the terminal when you start.')}
          onChange={event => setNotes(event.target.value)} />
      </div>
      <div className="kanban-primary-actions">
        {card.archived ? <button className="primary" disabled={busy} onClick={async () => { if (await mutate(() => api.archiveKanbanCard(card.id, false))) onClose(); }}>{t('Restore task')}</button>
          : canContinue ? <div className="kanban-split-button">
            <button className="primary" disabled={busy} onClick={() => void resume(latest)}><Play size={14} aria-hidden="true" />{t('Continue with {{agent}}', { agent: agentNames[latest.kind] })}</button>
            <KanbanMenu label={t('More ways to start')} disabled={busy || !onStart} trigger={<ChevronDown size={14} aria-hidden="true" />} triggerClassName="primary kanban-split-toggle">
              <button onClick={() => void start()}>{t('Start a new session')}</button>
            </KanbanMenu></div>
            : <button className="primary" disabled={busy || !onStart} onClick={() => void start()}><Play size={14} aria-hidden="true" />{t('Start work')}</button>}
      </div>
      {showMerge && !card.archived && <form className="kanban-inline-form" onSubmit={event => { event.preventDefault(); if (mergeTarget) onMerge(mergeTarget); }}>
        <label className="field-label">{t('Merge into task')}<select value={mergeTarget} disabled={busy} onChange={event => setMergeTarget(event.target.value)}>
          <option value="">{t('Choose a task')}</option>{mergeTargets.map(target => <option key={target.id} value={target.id}>{cardTitle(target)}</option>)}</select></label>
        <div className="dialog-actions"><button type="button" onClick={() => setShowMerge(false)}>{t('Cancel')}</button><button className="primary" disabled={busy || !mergeTarget}>{t('Merge tasks')}</button></div>
      </form>}
      {card.worktreePath && <p className="kanban-detail-path">{t('Worktree: {{path}}', { path: card.worktreePath })}</p>}
      {worktree && <form className="kanban-inline-form" onSubmit={event => {
        event.preventDefault();
        if (busy || !repoId || !branch.trim()) return;
        void mutate(async () => {
          // Retain a successfully created checkout if catalog binding fails; retry only the binding.
          createdWorktree.current ??= (await gitApi.worktreeAdd(project.id, { repoId, branch: branch.trim(), create: true, base: null, path: null })).path;
          await api.bindKanbanWorktree(card.id, createdWorktree.current);
          setWorktree(false); createdWorktree.current = null; setBranch('');
        });
      }}>
        <label className="field-label">{t('Repository')}<select disabled={busy || !!createdWorktree.current} value={repoId} onChange={event => setRepoId(event.target.value)}>{repos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
        <label className="field-label">{t('Branch name')}<input required disabled={busy || !!createdWorktree.current} value={branch} onChange={event => setBranch(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" onClick={() => setWorktree(false)}>{t('Cancel')}</button><button className="primary" disabled={busy || !repoId || !branch.trim()}>{t('Create worktree')}</button></div>
      </form>}
      <div className="kanban-sessions-header"><h3>{t('Sessions')}<span className="kanban-count">{card.sessions.length}</span></h3>
        {!card.archived && <button className="secondary" disabled={busy} onClick={() => void mutate(async () => {
          const result = await api.sessions({ projectId: project.id, offset: 0, limit: 100 });
          setHistory(result.items); setHistoryId(''); setHistoryQuery('');
        })}>{t('Attach from history')}</button>}</div>
      {history && !card.archived && <form className="kanban-inline-form" onSubmit={event => {
        event.preventDefault();
        if (!busy && historyId) void mutate(async () => { await api.attachKanbanSession(card.id, historyId); setHistory(null); });
      }}>
        <input type="search" aria-label={t('Filter sessions')} placeholder={t('Filter sessions')} value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} />
        <label className="field-label">{t('Session')}<select disabled={busy} value={historyId} onChange={event => setHistoryId(event.target.value)}>
          <option value="">{t('Choose a session')}</option>{candidates.map(session => <option key={session.id} value={session.id}>{agentNames[session.kind]} · {session.title || session.externalId}</option>)}
        </select></label>
        <p className="small-muted">{t('Showing up to 100 recent sessions in this project. Attaching moves a session from its previous task.')}</p>
        <div className="dialog-actions"><button type="button" onClick={() => setHistory(null)}>{t('Cancel')}</button><button className="primary" disabled={busy || !historyId}>{t('Attach session')}</button></div>
      </form>}
      {!card.sessions.length && <p className="small-muted kanban-sessions-empty">{t('No sessions yet. Start work and the new session is attached here.')}</p>}
      <ul className="kanban-detail-sessions">{card.sessions.map(link => <li key={link.session.id}>
        <AgentIcon kind={link.session.kind} name={agentNames[link.session.kind]} />
        <div className="kanban-detail-session"><strong>{link.session.title || link.session.externalId}</strong>
          <p className="small-muted">{agentNames[link.session.kind]} · {status(link).text}</p>{link.branch && <span className="kanban-detail-path">{link.branch}</span>}</div>
        <div className="kanban-session-actions"><button className="secondary" disabled={busy || !onResume || !!link.session.resumeDisabledReason} title={link.session.resumeDisabledReason ?? undefined} onClick={() => void resume(link.session)}>{t('Resume')}</button>
          {!card.archived && <KanbanMenu label={t('Session actions: {{title}}', { title: link.session.title || link.session.externalId })} disabled={busy}>
            <button onClick={() => void mutate(() => api.splitKanbanSession(card.id, link.session.id))}>{t('Split into new task')}</button>
          </KanbanMenu>}</div>
      </li>)}</ul>
      <div className="kanban-detail-times"><span>{t('Created {{time}}', { time: dateLabel(card.createdAt) })}</span><span>{t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}</span></div>
      {error && <p className="inline-warning" role="alert">{error}</p>}
      {feedback}
    </div>
  </Dialog>;
}
