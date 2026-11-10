import { useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Crosshair, Play } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import type { KanbanCard, Project, Session } from '../types';
import type { ActivityContribution } from './ActivityShell';
import { Dialog } from './Dialog';
import { KanbanCardDetails } from './KanbanCardDetails';
import { KanbanCardMetadata, KanbanQuickAdd, KanbanUndo } from './KanbanShared';
import { cardStage, cardTitle, latestSession, ordered, stageColumn, type KanbanBoards } from './useKanbanBoards';
import './project-board.css';
import './workspace-organization.css';

const UP_NEXT = 3;
type BoardActivityProps = {
  project: Project; data: KanbanBoards; onOpenBoard: () => void;
  onStart?: (card: KanbanCard, project: Project) => void;
  onResume?: (session: Session) => void; onHistoryChanged?: () => Promise<void>;
  /** Brings an already open terminal forward; returns false when no pane shows the session. */
  onFocusPane?: (paneId: string) => void;
};
export function createBoardActivity({ project, data, shortcut, ...props }: Omit<BoardActivityProps, 'project'> & {
  project?: Project; shortcut?: string;
}): ActivityContribution {
  return { id: 'board', label: t('Focus'), icon: Crosshair, shortcut,
    available: !!project?.curated && !project.workspaceOnly,
    badge: data.attentionCount || undefined,
    renderSidebar: () => project ? <BoardActivity key={project.id} project={project} data={data} {...props} /> : null };
}

/** What needs you next in this project: sessions waiting for input, work in progress and the top of Todo. */
export function BoardActivity({ project, data, onOpenBoard, onStart, onResume, onHistoryChanged, onFocusPane }: BoardActivityProps) {
  const root = useRef<HTMLElement>(null);
  const [selected, setLocalSelected] = useState<string | null>(null);
  const setSelected = (id: string | null) => { setLocalSelected(id); data.setSelectedId(id); };
  const [merge, setMerge] = useState<{ source: string; target: string } | null>(null);
  const board = data.snapshots.find(item => item.projectId === project.id);
  const cards = ordered(board?.columns ?? []).flatMap(column => ordered(board?.cards.filter(card => card.columnId === column.id) ?? []));
  const active = cards.filter(card => !card.archived);
  const stageOf = (card: KanbanCard) => cardStage(board, card);
  const waiting = active.filter(card => card.sessions.some(link => data.status(link).attention));
  const working = active.filter(card => !waiting.includes(card) && stageOf(card) !== 'done' && stageOf(card) !== 'unsorted'
    && (stageOf(card) === 'doing' || card.sessions.some(link => data.status(link).kind === 'working')));
  const upNext = active.filter(card => stageOf(card) === 'todo' && !waiting.includes(card) && !working.includes(card));
  const suggestions = active.filter(card => stageOf(card) === 'unsorted').length;
  const todo = stageColumn(board, 'todo');
  const start = onStart ? async (card: KanbanCard) => {
    setSelected(null);
    const doing = stageColumn(board, 'doing');
    if (doing && (stageOf(card) === 'todo' || stageOf(card) === 'unsorted'))
      await data.move(card, doing, (board?.cards.filter(item => item.columnId === doing.id && item.id !== card.id).length ?? 0), root.current);
    // The panel follows the current project; a start that finishes after a switch is dropped.
    if (root.current?.isConnected) onStart(card, project);
  } : undefined;
  const goTo = (card: KanbanCard) => {
    const link = card.sessions.find(item => data.status(item).attention) ?? card.sessions.find(item => data.status(item).paneId);
    const paneId = link && data.status(link).paneId;
    if (paneId && onFocusPane) onFocusPane(paneId);
    else if (link) onResume?.(link.session);
  };
  const action = (card: KanbanCard, kind: 'waiting' | 'working' | 'next') => {
    if (kind === 'waiting') return <button className="secondary" onClick={() => goTo(card)}>{t('Go to terminal')}<ArrowRight size={13} aria-hidden="true" /></button>;
    const latest = latestSession(card);
    if (kind === 'working' && latest && onResume && !latest.resumeDisabledReason) {
      const open = card.sessions.some(link => data.status(link).paneId);
      return <button className="secondary" disabled={data.busy} onClick={() => open ? goTo(card) : onResume(latest)}>{open ? t('Go to terminal') : t('Resume')}</button>;
    }
    return start && <button className="secondary" disabled={data.busy} onClick={() => void start(card)}><Play size={12} aria-hidden="true" />{t('Start')}</button>;
  };
  const section = (title: string, items: KanbanCard[], kind: 'waiting' | 'working' | 'next', empty?: ReactNode) =>
    <section className={`focus-section focus-${kind}`} aria-label={title}>
      <h3>{title}<span className="kanban-count">{items.length}</span></h3>
      {items.length ? <ul>{items.map(card => <li key={card.id} data-kanban-card={card.id}
        className={`focus-card${kind === 'waiting' ? ' kanban-needs-attention' : ''}${data.selectedId === card.id ? ' kanban-selected' : ''}`}>
        <button className="kanban-card-open" disabled={data.busy} onClick={() => setSelected(card.id)}>{cardTitle(card)}</button>
        <KanbanCardMetadata card={card} status={data.status} />
        <div className="focus-card-actions">{action(card, kind)}</div>
      </li>)}</ul> : empty}
    </section>;
  const card = cards.find(item => item.id === selected);
  return <section ref={root} className="board-activity" data-kanban-surface aria-label={t('Focus')} aria-busy={data.busy}>
    <header><strong title={project.name}>{project.name}</strong><button className="secondary" onClick={onOpenBoard}>{t('Open board')}<ArrowRight size={13} aria-hidden="true" /></button></header>
    <div className="board-activity-groups">{data.loading ? <p role="status">{t('Loading board…')}</p> : !board?.enabled ? <div className="board-activity-enable">
      <p>{t('Plan agent work as tasks. New sessions are suggested for filing; existing history stays as it is.')}</p>
      <button className="primary" disabled={data.busy} onClick={() => void data.mutate(() => api.setKanbanBoardEnabled(project.id, true))}>{t('Enable board')}</button>
    </div> : <>
      {waiting.length > 0 && section(t('Needs you'), waiting, 'waiting')}
      {section(t('In progress'), working, 'working', <p className="focus-empty">{t('Nothing in progress. Start a task below.')}</p>)}
      {section(t('Up next'), upNext.slice(0, UP_NEXT), 'next', <p className="focus-empty">{t('Todo is empty.')}</p>)}
      {upNext.length > UP_NEXT && <button className="link-button focus-more" onClick={onOpenBoard}>{t('{{count}} more in Todo', { count: upNext.length - UP_NEXT })}</button>}
      {todo && <KanbanQuickAdd busy={data.busy} onCreate={title => data.mutate(() => api.createKanbanCard(todo.id, title, ''))} />}
      {suggestions > 0 && <button className="link-button focus-suggestions" onClick={onOpenBoard}>{t('{{count}} sessions are not in a task yet', { count: suggestions })} →</button>}
    </>}</div>
    <span className="organization-sr-only" role="status" aria-live="polite">{!data.announcementOrigin || data.announcementOrigin === root.current ? data.announcement : ''}</span>
    {data.error && <p role="alert" className="inline-warning">{data.error}</p>}
    {!selected && <KanbanUndo data={data} root={root} />}
    {card && <KanbanCardDetails key={card.id} card={card} project={project} columns={ordered(board?.columns ?? [])}
      busy={data.busy} error={data.error} mutate={data.mutate} save={data.saveCard} status={data.status} feedback={<KanbanUndo data={data} root={root} />}
      onMove={column => void data.move(card, column, board?.cards.filter(item => item.columnId === column.id && item.id !== card.id).length ?? 0, root.current)}
      onArchive={() => data.archive(card.id, root.current)}
      onClose={() => { if (!data.lock.current) {
        setSelected(null);
        requestAnimationFrame(() => {
          const element = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(item => item.dataset.kanbanCard === card.id);
          (element?.querySelector<HTMLElement>('.kanban-card-open') ?? root.current?.querySelector<HTMLElement>('header button'))?.focus();
        });
      } }} onStart={start} onResume={onResume ? session => { setSelected(null); onResume(session); } : undefined} onHistoryChanged={onHistoryChanged}
      mergeTargets={active.filter(target => target.id !== card.id)} onMerge={target => { setSelected(null); setMerge({ source: card.id, target }); }} />}
    {merge && cards.some(item => item.id === merge.source) && cards.some(item => item.id === merge.target) && <Dialog title={t('Merge tasks?')} onClose={() => { if (!data.busy) setMerge(null); }}>
      <p>{t('Merge "{{source}}" into "{{target}}"? Sessions and notes move to the target; the source task is deleted.', {
        source: cardTitle(cards.find(item => item.id === merge.source)!), target: cardTitle(cards.find(item => item.id === merge.target)!),
      })}</p>
      {data.error && <p role="alert">{data.error}</p>}
      <div className="dialog-actions"><button disabled={data.busy} onClick={() => setMerge(null)}>{t('Cancel')}</button>
        <button className="primary" data-dialog-confirm disabled={data.busy} onClick={async () => {
          if (await data.mutate(() => api.mergeKanbanCards(merge.source, merge.target), undefined, merge.target)) setMerge(null);
        }}>{t('Merge tasks')}</button></div>
    </Dialog>}
  </section>;
}
