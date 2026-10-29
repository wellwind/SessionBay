import { useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ChevronDown, Columns3 } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import type { KanbanCard, Project, Session } from '../types';
import type { ActivityContribution } from './ActivityShell';
import { Dialog } from './Dialog';
import { KanbanCardDetails } from './KanbanCardDetails';
import { KanbanCardMetadata, KanbanQuickAdd, KanbanUndo } from './KanbanShared';
import { cardTitle, columnName, ordered, type KanbanBoards } from './useKanbanBoards';
import { useKanbanCardDrag } from './useKanbanCardDrag';
import './project-board.css';
import './workspace-organization.css';

type BoardActivityProps = {
  project: Project; data: KanbanBoards; onOpenBoard: () => void;
  onStart?: (card: KanbanCard, project: Project) => void;
  onResume?: (session: Session) => void; onHistoryChanged?: () => Promise<void>;
};
export function createBoardActivity({ project, data, shortcut, ...props }: Omit<BoardActivityProps, 'project'> & {
  project?: Project; shortcut?: string;
}): ActivityContribution {
  return { id: 'board', label: t('Board'), icon: Columns3, shortcut,
    available: !!project?.curated && !project.workspaceOnly,
    badge: data.attentionCount || undefined,
    renderSidebar: () => project ? <BoardActivity key={project.id} project={project} data={data} {...props} /> : null };
}

export function BoardActivity({ project, data, onOpenBoard, onStart, onResume, onHistoryChanged }: BoardActivityProps) {
  const root = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setLocalSelected] = useState<string | null>(null);
  const setSelected = (id: string | null) => { setLocalSelected(id); data.setSelectedId(id); };
  const [merge, setMerge] = useState<{ source: string; target: string } | null>(null);
  const board = data.snapshots.find(board => board.projectId === project.id);
  const columns = ordered(board?.columns ?? []), cards = ordered(board?.cards ?? []);
  const active = cards.filter(card => !card.archived);
  const siblings = (column: string, exclude?: string) => cards.filter(card => card.columnId === column && card.id !== exclude);
  const move = (id: string, columnId: string, position: number) => {
    const card = cards.find(card => card.id === id), column = columns.find(column => column.id === columnId);
    if (card && column && !data.busy) void data.move(card, column, position, root.current);
  };
  const drag = useKanbanCardDrag(root, JSON.stringify([active.map(card => [card.id, card.columnId, card.position]), collapsed, data.busy]), (id, drop) => {
    const remaining = siblings(drop.columnId, id);
    const position = drop.targetId ? remaining.findIndex(card => card.id === drop.targetId) + Number(drop.after) : remaining.length;
    if (position >= 0) move(id, drop.columnId, position);
  }, false, !data.busy);
  const key = (event: KeyboardEvent<HTMLButtonElement>, card: KanbanCard) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const visible = active.filter(item => item.columnId === card.columnId);
      const next = visible[visible.indexOf(card) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (next) move(card.id, card.columnId, siblings(card.columnId, card.id).indexOf(next) + Number(event.key === 'ArrowDown'));
    } else {
      const next = columns[columns.findIndex(column => column.id === card.columnId) + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (next) { setCollapsed(previous => ({ ...previous, [next.id]: false })); move(card.id, next.id, siblings(next.id).length); }
    }
  };
  const dismissMerge = () => {
    if (data.busy) return;
    const source = merge?.source;
    setMerge(null);
    requestAnimationFrame(() => {
      const element = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(element => element.dataset.kanbanCard === source);
      (element?.querySelector<HTMLElement>('.kanban-card-open') ?? root.current?.querySelector<HTMLElement>('.board-group-toggle'))?.focus();
    });
  };
  const card = cards.find(card => card.id === selected);
  return <section ref={root} className="board-activity" data-kanban-surface aria-label={t('Project board')} aria-busy={data.busy}>
    <header><strong>{project.name}</strong><button className="secondary" onClick={onOpenBoard}>{t('Open full board')}</button></header>
    <div className="board-activity-groups">{data.loading ? <p role="status">{t('Loading board…')}</p> : !board?.enabled ? <div className="board-activity-enable">
      <p>{t('Enable a board for this project. New sessions will appear in Unsorted; existing history stays as it is.')}</p>
      <button disabled={data.busy} onClick={() => void data.mutate(() => api.setKanbanBoardEnabled(project.id, true))}>{t('Enable board')}</button>
    </div> : columns.map(column => {
      const items = active.filter(card => card.columnId === column.id);
      const closed = collapsed[column.id] ?? column.stage === 'done';
      const preview = drag.preview;
      return <section key={column.id} data-kanban-column={column.id} className={`board-activity-group${preview?.columnId === column.id && !preview.targetId ? ' kanban-drop-column' : ''}`}>
        <button className="board-group-toggle" aria-expanded={!closed} aria-controls={`board-group-${column.id}`}
          onClick={() => setCollapsed(previous => ({ ...previous, [column.id]: !closed }))}>
          <ChevronDown size={14} aria-hidden="true" /><span className={`kanban-stage-dot stage-${column.stage}`} aria-hidden="true" />{columnName(column)}<span>{items.length}</span>
        </button>
        <div id={`board-group-${column.id}`} hidden={closed} role="list" aria-label={columnName(column)}>
          {items.map(card => <div role="listitem" key={card.id} data-kanban-card={card.id} {...drag.handlers(card.id)}
            onClick={event => { if (!data.busy && !(event.target as Element).closest('button')) setSelected(card.id); }}
            className={`kanban-card${data.selectedId === card.id ? ' kanban-selected' : ''}${card.sessions.some(link => data.status(link).attention) ? ' kanban-needs-attention' : ''}${preview?.targetId === card.id ? preview.after ? ' kanban-drop-after' : ' kanban-drop-before' : ''}`}>
            <button className="kanban-card-open" disabled={data.busy} onClick={() => setSelected(card.id)} onKeyDown={event => key(event, card)}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight">{cardTitle(card)}</button>
            {card.sessions.some(link => data.status(link).attention) && <AlertTriangle size={13} aria-label={t('Needs attention')} />}
            <KanbanCardMetadata card={card} status={data.status} />
          </div>)}
          {column.stage === 'todo' && <KanbanQuickAdd busy={data.busy} onCreate={title => data.mutate(() => api.createKanbanCard(column.id, title, ''))} />}
        </div>
      </section>;
    })}</div>
    <span className="organization-sr-only" role="status" aria-live="polite">{!data.announcementOrigin || data.announcementOrigin === root.current ? data.announcement : ''}</span>
    {data.error && <p role="alert" className="inline-warning">{data.error}</p>}
    {!selected && <KanbanUndo data={data} root={root} />}
    {card && <KanbanCardDetails key={card.id} card={card} project={project} done={columns.find(column => column.id === card.columnId)?.stage === 'done'}
      busy={data.busy} error={data.error} mutate={data.mutate} status={data.status} columns={columns} feedback={<KanbanUndo data={data} root={root} />}
      columnCards={siblings(card.columnId)} onPosition={position => move(card.id, card.columnId, position)}
      onMove={column => void data.move(card, column, siblings(column.id, card.id).length, root.current)} onArchive={() => data.archive(card.id, root.current)}
      onClose={() => { if (!data.lock.current) {
        setSelected(null);
        requestAnimationFrame(() => {
          const element = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(element => element.dataset.kanbanCard === card.id);
          (element && !element.closest('[hidden]') ? element.querySelector<HTMLElement>('.kanban-card-open') : root.current?.querySelector<HTMLElement>('.board-group-toggle'))?.focus();
        });
      } }} onStart={onStart ? card => { setSelected(null); onStart(card, project); } : undefined}
      onResume={onResume ? session => { setSelected(null); onResume(session); } : undefined} onHistoryChanged={onHistoryChanged}
      mergeTargets={active.filter(target => target.id !== card.id)} onMerge={target => { setSelected(null); setMerge({ source: card.id, target }); }} />}
    {merge && cards.some(card => card.id === merge.source) && cards.some(card => card.id === merge.target) && <Dialog title={t('Merge tasks?')} onClose={dismissMerge}>
      <p>{t('Merge "{{source}}" into "{{target}}"? Sessions and notes move to the target; the source task is deleted.', {
        source: cardTitle(cards.find(card => card.id === merge.source)!), target: cardTitle(cards.find(card => card.id === merge.target)!),
      })}</p>
      {data.error && <p role="alert">{data.error}</p>}
      <div className="dialog-actions"><button disabled={data.busy} onClick={dismissMerge}>{t('Cancel')}</button>
        <button className="primary" data-dialog-confirm disabled={data.busy} onClick={async () => {
          if (await data.mutate(() => api.mergeKanbanCards(merge.source, merge.target), undefined, merge.target)) setMerge(null);
        }}>{t('Merge tasks')}</button></div>
    </Dialog>}
  </section>;
}
