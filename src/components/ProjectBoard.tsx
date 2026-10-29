import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Columns3, GripVertical } from 'lucide-react';
import { api } from '../api';
import { projectColor, projectColorSlots, projectInitials } from '../project-identity';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import type { KanbanCard, KanbanColumn, KanbanStage, Project, Session, Workspace } from '../types';
import { KanbanCardDetails } from './KanbanCardDetails';
import { Dialog } from './Dialog';
import { dateLabel } from './History';
import { KanbanMenu } from './KanbanMenu';
import { KanbanCardMetadata, KanbanQuickAdd, KanbanUndo, relativeCardTime } from './KanbanShared';
import { KanbanScroll } from './KanbanScroll';
import { useKanbanBoards, columnName, cardTitle, ordered, type KanbanBoards } from './useKanbanBoards';
export { columnName } from './useKanbanBoards';
import { useAnimatedReorder } from './useAnimatedReorder';
import { useKanbanCardDrag } from './useKanbanCardDrag';
import './project-board.css';
import './workspace-organization.css';

const stageNames = {
  unsorted: 'Unsorted', todo: 'Todo', doing: 'In progress', review: 'Review', done: 'Done',
} as const;
type BoardProps = {
  workspace: Workspace; refreshToken?: number; model?: KanbanBoards;
  onStart?: (card: KanbanCard, project: Project) => void;
  onResume?: (session: Session) => void; onHistoryChanged?: () => Promise<void>;
} & ({ project: Project; projects?: never } | { project?: never; projects: Project[] });

/** Shared project board and cross-project stage overview; all edits use catalog commands. */
export function ProjectBoard({ project, projects, workspace, refreshToken = 0, onStart, onResume, onHistoryChanged, model }: BoardProps) {
  const overview = projects !== undefined;
  const eligible = overview || !!(project?.curated && !project.workspaceOnly);
  const local = useKanbanBoards(workspace, project?.id, eligible && !model, refreshToken);
  const data = model ?? local;
  const { snapshots, loading, error, busy, lock, announcement, read, mutate, status } = data;
  const enabled = snapshots.filter(board => board.enabled && (!overview || projects.some(project => project.id === board.projectId && project.curated && !project.workspaceOnly)));
  const board = overview ? undefined : snapshots[0];
  const colorSlots = projectColorSlots((projects ?? [project]).map(project => project.id));
  const [projectFilter, setProjectFilter] = useState('');
  const [query, setQuery] = useState(''), [agent, setAgent] = useState(''), [attention, setAttention] = useState(false);
  const [settings, setSettings] = useState<string | null>(null);
  const [details, setLocalDetails] = useState<string | null>(null), [archived, setArchived] = useState(false);
  const setDetails = (id: string | null) => { setLocalDetails(id); data.setSelectedId(id); };
  const [newTask, setNewTask] = useState(false), [policy, setPolicy] = useState(false);
  const [merge, setMerge] = useState<{ source: string; target: string } | null>(null);
  const [groupBy, setGroupBy] = useState('none');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [mergeSection, setMergeSection] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const root = useRef<HTMLElement>(null);
  const help = useId();
  const search = useDeferredValue(query.trim().toLocaleLowerCase(locale()));
  const columns: KanbanColumn[] = overview
    ? (Object.keys(stageNames) as KanbanStage[]).map((stage, position) => ({
      id: stage, stage, position, projectId: '', name: null, defaultName: stageNames[stage], systemRole: null,
    })) : ordered(board?.columns ?? []);
  const cards = overview ? enabled.flatMap(board => ordered(board.columns).flatMap(column =>
    ordered(board.cards.filter(card => card.columnId === column.id))))
    : ordered(board?.cards ?? []);
  const cardColumnId = (card: KanbanCard) => overview
    ? enabled.find(board => board.projectId === card.projectId)?.columns.find(column => column.id === card.columnId)?.stage
    : card.columnId;
  const owner = (card: KanbanCard) => project ?? projects.find(project => project.id === card.projectId)!;
  const destination = (card: KanbanCard, stage: KanbanStage) =>
    ordered(enabled.find(board => board.projectId === card.projectId)?.columns ?? []).find(column => column.stage === stage);
  const inColumn = (id: string, excluding?: string) => cards.filter(card => cardColumnId(card) === id && card.id !== excluding);
  const moveCard = (id: string, columnId: string, position: number) => {
    const card = cards.find(card => card.id === id), column = columns.find(column => column.id === columnId);
    if (!card || !column || busy) return;
    if (overview) {
      const target = destination(card, column.stage);
      const source = enabled.find(board => board.projectId === card.projectId);
      if (!target || !source || cardColumnId(card) === columnId) return;
      // Resolve only within the card's board, including hidden/archived destination cards.
      columnId = target.id;
      position = source.cards.filter(item => item.columnId === target.id && item.id !== id).length;
    } else if (card.columnId === columnId && card.position === position) return;
    if (column.stage === 'done') setExpanded(previous => ({ ...previous, [`${overview && groupBy === 'project' ? card.projectId : ''}:${column.id}`]: true }));
    void data.move(card, { ...column, id: columnId }, position, root.current);
  };
  const moveColumn = (id: string, targetId: string, after: boolean) => {
    const source = columns.find(column => column.id === id);
    if (!project || !source || id === targetId || busy) return;
    const remaining = columns.filter(column => column.id !== id);
    const position = remaining.findIndex(column => column.id === targetId) + Number(after);
    remaining.splice(position, 0, source);
    void mutate(() => api.reorderKanbanColumns(project.id, remaining.map(column => column.id)),
      t('Moved column "{{name}}" to position {{position}}.', { name: columnName(source), position: position + 1 }));
  };
  const columnReorder = useAnimatedReorder(columns.filter(column => column.systemRole !== 'unsorted'), 'x', '.kanban-columns', moveColumn);
  const cardDrag = useKanbanCardDrag(root, JSON.stringify([cards.map(card => [card.id, cardColumnId(card), card.position]), query, agent, attention, busy, archived, projectFilter]), (id, drop) => {
    if (overview) { moveCard(id, drop.columnId, 0); return; }
    if (drop.merge && drop.targetId) { setMerge({ source: id, target: drop.targetId }); return; }
    const remaining = inColumn(drop.columnId, id);
    const position = drop.targetId ? remaining.findIndex(card => card.id === drop.targetId) + Number(drop.after) : remaining.length;
    if (position >= 0) moveCard(id, drop.columnId, position);
  }, !overview, !busy);
  const shown = cards.filter(card => card.archived === archived && (!overview || !projectFilter || card.projectId === projectFilter) && (!agent || card.sessions.some(link => link.session.kind === agent))
    && (!attention || card.sessions.some(link => status(link).attention))
    && (!search || [card.title, card.notes, ...card.sessions.map(link => link.session.title)]
      .some(text => text.toLocaleLowerCase(locale()).includes(search))));
  const attentionCount = cards.filter(card => !card.archived && card.sessions.some(link => status(link).attention)).length;
  const columnKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const next = columns[index + (event.key === 'ArrowLeft' ? -1 : 1)];
    if (next) moveColumn(columns[index].id, next.id, event.key === 'ArrowRight');
  };
  const reorderCard = (card: KanbanCard, direction: number) => {
    const siblings = shown.filter(item => item.columnId === card.columnId);
    const next = siblings[siblings.indexOf(card) + direction];
    if (next) moveCard(card.id, card.columnId, inColumn(card.columnId, card.id).indexOf(next) + Number(direction === 1));
  };
  const cardKey = (event: KeyboardEvent<HTMLButtonElement>, card: KanbanCard) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (overview && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      reorderCard(card, event.key === 'ArrowUp' ? -1 : 1);
    } else {
      const next = columns[columns.findIndex(column => column.id === cardColumnId(card)) + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (next) moveCard(card.id, next.id, inColumn(next.id).length);
    }
  };
  const dismissMerge = () => {
    if (lock.current) return;
    const source = merge?.source;
    setMerge(null);
    requestAnimationFrame(() => {
      const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(card => card.dataset.kanbanCard === source);
      card?.querySelector<HTMLElement>('.kanban-card-open')?.focus();
    });
  };
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey ||
        !(event.target instanceof Element) || !root.current?.contains(event.target) ||
        event.target.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="dialog"]')) return;
      if (event.key === '/') { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key.toLowerCase() === 'n' && !busy) { event.preventDefault(); setNewTask(true); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [busy]);
  const renderCard = (card: KanbanCard, inbox = false) => {
    const drop = cardDrag.preview;
    const needsAttention = card.sessions.some(link => status(link).attention);
    return <div role="listitem" data-kanban-card={card.id} key={card.id} {...cardDrag.handlers(card.id)}
      onClick={event => { if (!busy && !(event.target as Element).closest('button')) { setMergeSection(false); setDetails(card.id); } }}
      className={`kanban-card${needsAttention ? ' kanban-needs-attention' : ''}${data.selectedId === card.id ? ' kanban-selected' : ''}${!overview && drop?.targetId === card.id ? drop.merge ? ' kanban-drop-merge' : drop.after ? ' kanban-drop-after' : ' kanban-drop-before' : ''}${drop?.id === card.id ? ' kanban-dragging' : ''}`}>
      {overview && groupBy === 'none' && <div className="kanban-project" style={{ ['--pane-project' as string]: projectColor(card.projectId, colorSlots) }} title={owner(card).name}>
        <span className="project-initials" aria-hidden="true">{projectInitials(owner(card).name)}</span><span>{owner(card).name}</span></div>}
      <div className="kanban-card-head"><button className="icon-button kanban-card-handle" disabled={busy}
        aria-label={t('Move task {{title}}', { title: cardTitle(card) })} aria-describedby={help}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight" onKeyDown={event => cardKey(event, card)}><GripVertical size={14} aria-hidden="true" /></button>
        <h4><button className="kanban-card-open" disabled={busy} onClick={() => { setMergeSection(false); setDetails(card.id); }} onKeyDown={event => cardKey(event, card)} title={cardTitle(card)}>{cardTitle(card)}</button></h4>
        {needsAttention && <AlertTriangle size={14} aria-label={t('Needs attention')} />}
      </div>
      <KanbanCardMetadata card={card} status={status} />
      <footer><time dateTime={card.updatedAt} title={t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}>{relativeCardTime(card.updatedAt)}</time>
      {inbox && !archived && <div className="kanban-inbox-actions"><button className="secondary" disabled={busy || !columns.some(column => column.stage === 'todo')} onClick={() => {
        const todo = columns.find(column => column.stage === 'todo'); if (todo) moveCard(card.id, todo.id, inColumn(todo.id).length);
      }}>{t('→ Todo')}</button><button className="secondary" disabled={busy} onClick={() => { setMergeSection(true); setDetails(card.id); }}>{t('Merge…')}</button></div>}</footer>
      {!overview && drop?.targetId === card.id && drop.merge && <div className="kanban-merge-overlay">{t('Release to merge')}</div>}
    </div>;
  };
  const columnMenu = (column: KanbanColumn): ReactNode => <KanbanMenu label={t('Column settings: {{name}}', { name: columnName(column) })} disabled={busy}>
    <button onClick={() => setSettings(column.id)}>{t('Rename…')}</button>
    <StageSelect value={column.stage} disabled={busy || !!column.systemRole} onChange={stage => void mutate(() => api.setKanbanColumnStage(column.id, stage))} />
    <button disabled={columns.indexOf(column) === 0} onClick={() => moveColumn(column.id, columns[columns.indexOf(column) - 1].id, false)}>{t('Move left')}</button>
    <button disabled={columns.indexOf(column) === columns.length - 1} onClick={() => moveColumn(column.id, columns[columns.indexOf(column) + 1].id, true)}>{t('Move right')}</button>
    <button disabled={!!column.systemRole} onClick={() => setSettings(column.id)}>{t('Delete…')}</button>
  </KanbanMenu>;
  const renderColumn = (column: KanbanColumn, lane?: Project) => {
    const items = shown.filter(card => cardColumnId(card) === column.id && (!lane || card.projectId === lane.id));
    const inbox = !overview && column.systemRole === 'unsorted';
    const drop = cardDrag.preview;
    const expandKey = `${lane?.id ?? ''}:${column.id}`;
    const visible = column.stage === 'done' && !expanded[expandKey] ? items.slice(0, 5) : items;
    return <div key={column.id} data-kanban-column={column.id} className={`${inbox ? 'kanban-inbox' : 'kanban-column'} ${columnReorder.className(column.id)}${drop?.columnId === column.id && (overview || !drop.targetId) ? ' kanban-drop-column' : ''}`}
      style={inbox ? undefined : columnReorder.style(column.id)} ref={!overview && !inbox ? element => columnReorder.ref(column.id, element) : undefined}>
      <div className="kanban-column-header" ref={!overview && !inbox ? element => columnReorder.targetRef(column.id, element) : undefined}>
        {!overview && !inbox && <button className="icon-button project-drag" disabled={busy} aria-label={t('Reorder {{name}}', { name: columnName(column) })}
          title={t('Drag to reorder; Alt+Left/Right to move')} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
          {...columnReorder.handlers(column.id)} onKeyDown={event => columnKey(event, columns.indexOf(column))}><GripVertical size={14} aria-hidden="true" /></button>}
        <span className={`kanban-stage-dot stage-${column.stage}`} aria-hidden="true" /><h3 title={columnName(column)}>{columnName(column)}</h3>
        <span className="small-muted">{inbox ? items.length ? t('{{count}} new sessions', { count: items.length }) : t('Inbox is clear') : items.length}</span>
        {!overview && columnMenu(column)}
      </div>
      <div className="kanban-card-list" role="list" aria-label={columnName(column)}>
        {visible.map(card => renderCard(card, inbox))}
        {items.length === 0 && !inbox && <p className="kanban-empty">{t('Drag tasks here or add one')}</p>}
      </div>
      {column.stage === 'done' && items.length > 5 && <button onClick={() => setExpanded(previous => ({ ...previous, [expandKey]: !previous[expandKey] }))}>
        {expanded[expandKey] ? t('Show less') : t('Show {{count}} more', { count: items.length - 5 })}</button>}
      {column.stage === 'done' && board?.autoArchiveDays && <p className="small-muted">{t('Archived automatically after {{count}} days', { count: board.autoArchiveDays })}</p>}
      {!overview && !archived && !inbox && <KanbanQuickAdd busy={busy} onCreate={title => mutate(() => api.createKanbanCard(column.id, title, ''))} />}
    </div>;
  };
  if (!eligible) return <div className="empty-state"><p>{t('Add this directory to Projects to enable a board.')}</p></div>;
  if (loading) return <div className="empty-state" role="status">{t('Loading board…')}</div>;
  return <section className="project-board" ref={root} data-kanban-surface tabIndex={-1} aria-label={overview ? t('All boards') : t('Project board')} aria-busy={busy}>
    {error && <div className="kanban-error" role="alert">{error}<button disabled={busy} onClick={() => void read()}>{t('Try again')}</button></div>}
    {overview && enabled.length === 0 ? <div className="empty-state"><Columns3 size={30} aria-hidden="true" /><h2>{t('No enabled boards')}</h2><p>{t('Enable a board from a project’s Board tab to see its tasks here.')}</p></div> : !overview && !board?.enabled ? <div className="empty-state"><Columns3 size={30} aria-hidden="true" /><h2>{t('Plan work on a board')}</h2>
      <p>{t('Enable a board for this project. New sessions will appear in Unsorted; existing history stays as it is.')}</p>
      <button className="primary" disabled={busy} onClick={() => void mutate(() => api.setKanbanBoardEnabled(project!.id, true))}>{t('Enable board')}</button></div> : <>
      <header className="kanban-toolbar">
        <label className="kanban-search">{t('Search board')}<input ref={searchInput} aria-label={t('Search board')} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Title, notes or session title')} /><kbd>/</kbd></label>
        <KanbanMenu label={t('Filter')} trigger={t('Filter')}>
          {overview && <label className="field-label">{t('Project')}<select value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
            <option value="">{t('All projects')}</option>{projects.filter(project => enabled.some(board => board.projectId === project.id)).map(project =>
              <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
          <label className="field-label">{t('Agent')}<select value={agent} onChange={event => setAgent(event.target.value)}>
            <option value="">{t('All agents')}</option>{Object.entries(agentNames).map(([kind, name]) => <option value={kind} key={kind}>{name}</option>)}</select></label>
        </KanbanMenu>
        {agent && <button className="secondary kanban-filter-chip" onClick={() => setAgent('')} aria-label={t('Remove agent filter')}>{agentNames[agent as keyof typeof agentNames]} ×</button>}
        {projectFilter && <button className="secondary kanban-filter-chip" onClick={() => setProjectFilter('')} aria-label={t('Remove project filter')}>{projects?.find(project => project.id === projectFilter)?.name} ×</button>}
        <button className="secondary" aria-pressed={attention} onClick={() => setAttention(!attention)}>{t('Needs attention')} <span>{attentionCount}</span></button>
        <div className="kanban-toolbar-spacer" />
        {overview ? <label>{t('Group by')}<select value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="none">{t('None')}</option><option value="project">{t('Project')}</option></select></label> : <>
          <div className="kanban-segmented"><button aria-pressed={!archived} onClick={() => setArchived(false)}>{t('Board')}</button>
            <button aria-pressed={archived} onClick={() => setArchived(true)}>{t('Archived ({{count}})', { count: cards.filter(card => card.archived).length })}</button></div>
          <KanbanMenu label={t('Board actions')} disabled={busy}><button onClick={() => setPolicy(true)}>{t('Auto-archive…')}</button><button onClick={() => setAdding(true)}>{t('Add column…')}</button></KanbanMenu>
        </>}
        <button className="primary" disabled={busy} onClick={() => setNewTask(true)}>{t('New task')}</button>
      </header>
      <span className="organization-sr-only" id={help}>{overview ? t('Drag cards to change stage within their project. Use Alt+Left/Right or the column selector in task details. Press Escape to cancel dragging.') : t('Drag cards to reorder or move between columns. Use Alt+Up/Down to reorder, Alt+Left/Right to change columns, or the column selector in task details. Drop on the center of another card to merge. Press Escape to cancel dragging.')}</span>
      <span className="organization-sr-only" role="status" aria-live="polite">{!data.announcementOrigin || data.announcementOrigin === root.current ? announcement : ''}</span>
      {shown.length === 0 && cards.some(card => !card.archived) && <p className="small-muted">{t('No tasks match the filters.')}</p>}
      {!overview && columns.filter(column => column.systemRole === 'unsorted').map(column => renderColumn(column))}
      {overview && groupBy === 'project' ? <div className="kanban-lanes">{projects.filter(project => enabled.some(board => board.projectId === project.id) && (!projectFilter || project.id === projectFilter)).map(project =>
        <section className="kanban-swimlane" key={project.id} aria-label={project.name}><h3>{project.name}</h3><KanbanScroll count={columns.length}>{columns.map(column => renderColumn(column, project))}</KanbanScroll></section>)}</div>
        : <KanbanScroll count={columns.filter(column => overview || column.systemRole !== 'unsorted').length}>
          {columns.filter(column => overview || column.systemRole !== 'unsorted').map(column => renderColumn(column))}
        </KanbanScroll>}
      {!details && <KanbanUndo data={data} root={root} />}
      {details && cards.some(card => card.id === details) && <KanbanCardDetails key={details} card={cards.find(card => card.id === details)!}
        project={owner(cards.find(card => card.id === details)!)} done={columns.find(column => column.id === cardColumnId(cards.find(card => card.id === details)!))?.stage === 'done'}
        busy={busy} error={error} mutate={mutate} status={status} feedback={<KanbanUndo data={data} root={root} />}
        columnCards={ordered(snapshots.find(board => board.projectId === cards.find(card => card.id === details)!.projectId)?.cards.filter(card => card.columnId === cards.find(card => card.id === details)!.columnId) ?? [])}
        onPosition={position => {
          const card = cards.find(card => card.id === details)!;
          const column = snapshots.find(board => board.projectId === card.projectId)!.columns.find(column => column.id === card.columnId)!;
          void data.move(card, column, position, root.current);
        }} initialMerge={mergeSection} columns={overview ? ordered(enabled.find(board => board.projectId === cards.find(card => card.id === details)!.projectId)?.columns ?? []) : columns}
        onMove={column => {
          const card = cards.find(card => card.id === details)!;
          const source = snapshots.find(board => board.projectId === card.projectId)!;
          if (column.stage === 'done') setExpanded(previous => ({ ...previous, [`${overview && groupBy === 'project' ? card.projectId : ''}:${overview ? column.stage : column.id}`]: true }));
          void data.move(card, column, source.cards.filter(item => item.columnId === column.id && item.id !== card.id).length, root.current);
        }} onArchive={() => data.archive(details, root.current)}
        mergeTargets={cards.filter(card => card.id !== details && !card.archived && card.projectId === cards.find(card => card.id === details)!.projectId)} onMerge={target => { setDetails(null); setMerge({ source: details, target }); }} onClose={() => { if (!lock.current) {
          setDetails(null);
          requestAnimationFrame(() => {
            const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(card => card.dataset.kanbanCard === details);
            (card?.querySelector<HTMLElement>('.kanban-card-open') ?? searchInput.current)?.focus();
          });
        } }}
        onStart={onStart ? card => { setDetails(null); onStart(card, owner(card)); } : undefined}
        onResume={onResume ? session => { setDetails(null); onResume(session); } : undefined} onHistoryChanged={onHistoryChanged} />}
      {newTask && <NewTask columns={overview ? enabled.flatMap(board => ordered(board.columns)) : columns} projects={projects} busy={busy} error={error} onClose={() => { if (!lock.current) setNewTask(false); }} onCreate={async (column, title, notes) => {
        let created: KanbanCard | undefined;
        if (await mutate(async () => { created = await api.createKanbanCard(column, title, notes); })) { setNewTask(false); setDetails(created!.id); }
      }} />}
      {policy && <ArchivePolicy days={board?.autoArchiveDays ?? null} busy={busy} error={error} onClose={() => { if (!lock.current) setPolicy(false); }}
        onSave={async days => { if (await mutate(() => api.setKanbanAutoArchive(project!.id, days))) setPolicy(false); }} />}
      {merge && cards.some(card => card.id === merge.source) && cards.some(card => card.id === merge.target) && <Dialog title={t('Merge tasks?')} onClose={dismissMerge}>
        <p>{t('Merge "{{source}}" into "{{target}}"? Sessions and notes move to the target; the source task is deleted.', { source: cardTitle(cards.find(card => card.id === merge.source)!), target: cardTitle(cards.find(card => card.id === merge.target)!) })}</p>
        {error && <p className="inline-warning" role="alert">{error}</p>}
        <div className="dialog-actions"><button disabled={busy} onClick={dismissMerge}>{t('Cancel')}</button><button className="primary" data-dialog-confirm disabled={busy} onClick={async () => {
          if (await mutate(() => api.mergeKanbanCards(merge.source, merge.target), undefined, merge.target)) setMerge(null);
        }}>{t('Merge tasks')}</button></div>
      </Dialog>}
      {adding && <AddColumn busy={busy} onClose={() => { if (!lock.current) setAdding(false); }} onAdd={async (name, stage) => {
        if (await mutate(() => api.createKanbanColumn(project!.id, name, stage))) setAdding(false);
      }} error={error} />}
      {settings && columns.some(column => column.id === settings) && <ColumnSettings key={settings} column={columns.find(column => column.id === settings)!} columns={columns} busy={busy} error={error}
        onClose={() => { if (!lock.current) setSettings(null); }}
        onRename={name => mutate(() => api.renameKanbanColumn(settings, name))}
        onStage={stage => void mutate(() => api.setKanbanColumnStage(settings, stage))}
        onMove={direction => { const index = columns.findIndex(column => column.id === settings); const next = columns[index + direction]; if (next) moveColumn(settings, next.id, direction === 1); }}
        onDelete={async target => { if (await mutate(() => api.deleteKanbanColumn(settings, target))) setSettings(null); }} />}
    </>}
  </section>;
}

function AddColumn({ busy, onClose, onAdd, error }: { busy: boolean; onClose: () => void; onAdd: (name: string, stage: KanbanStage) => Promise<void>; error: string }) {
  const [name, setName] = useState(''), [stage, setStage] = useState<KanbanStage>('doing');
  return <Dialog title={t('Add column')} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void onAdd(name.trim(), stage); }}>
    <label className="field-label">{t('Column name')}<input value={name} maxLength={500} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <StageSelect value={stage} disabled={busy} onChange={setStage} />
    {error && <p className="inline-warning" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy || !name.trim()}>{t('Add column')}</button></div>
  </form></Dialog>;
}
function StageSelect({ value, disabled, onChange }: { value: KanbanStage; disabled: boolean; onChange: (stage: KanbanStage) => void }) {
  return <label className="field-label">{t('Stage')}<select value={value} disabled={disabled} onChange={event => onChange(event.target.value as KanbanStage)}>
    {Object.entries(stageNames).map(([stage, name]) => <option value={stage} key={stage}>{t(name)}</option>)}
  </select></label>;
}
function ColumnSettings({ column, columns, busy, error, onClose, onRename, onStage, onMove, onDelete }: {
  column: KanbanColumn; columns: KanbanColumn[]; busy: boolean; error: string; onClose: () => void;
  onRename: (name: string) => Promise<boolean>; onStage: (stage: KanbanStage) => void;
  onMove: (direction: number) => void; onDelete: (target: string) => Promise<void>;
}) {
  const [name, setName] = useState(columnName(column));
  const [target, setTarget] = useState('');
  const index = columns.indexOf(column);
  return <Dialog title={t('Column settings: {{name}}', { name: columnName(column) })} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void onRename(name.trim()); }}>
      <label className="field-label">{t('Column name')}<input value={name} maxLength={500} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <div className="dialog-actions"><button className="secondary" disabled={busy || !name.trim() || name === columnName(column)}>{t('Rename column')}</button></div>
    </form>
    <StageSelect value={column.stage} disabled={busy || !!column.systemRole} onChange={onStage} />
    {column.systemRole && <p className="small-muted">{t('System columns have a fixed stage and cannot be deleted.')}</p>}
    <div className="dialog-actions"><button disabled={busy || index === 0} onClick={() => onMove(-1)}>{t('Move left')}</button><button disabled={busy || index === columns.length - 1} onClick={() => onMove(1)}>{t('Move right')}</button></div>
    {!column.systemRole && <div className="kanban-delete-column"><p>{t('Choose where all tasks go before deleting this column. Archived tasks move too.')}</p>
      <label className="field-label">{t('Move tasks to')}<select value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
        <option value="">{t('Choose a column')}</option>{columns.filter(item => item.id !== column.id).map(item => <option key={item.id} value={item.id}>{columnName(item)}</option>)}
      </select></label><button className="danger" disabled={busy || !target} onClick={() => void onDelete(target)}>{t('Delete column')}</button></div>}
    {error && <p role="alert" className="inline-warning">{error}</p>}
  </Dialog>;
}

function NewTask({ columns, projects, busy, error, onClose, onCreate }: { columns: KanbanColumn[]; projects?: Project[]; busy: boolean; error: string; onClose: () => void; onCreate: (column: string, title: string, notes: string) => Promise<void> }) {
  const [column, setColumn] = useState(columns.find(column => column.stage === 'todo')?.id ?? columns[0]?.id ?? '');
  const [title, setTitle] = useState(''), [notes, setNotes] = useState('');
  return <Dialog title={t('New task')} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!busy && column) void onCreate(column, title, notes); }}>
    <label className="field-label">{t('Task title')}<input value={title} maxLength={500} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
    <label className="field-label">{t('Notes')}<textarea rows={4} value={notes} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
    <label className="field-label">{t('Column')}<select value={column} disabled={busy} onChange={event => setColumn(event.target.value)}>{columns.map(column => <option key={column.id} value={column.id}>{projects ? `${projects.find(project => project.id === column.projectId)?.name} · ` : ''}{columnName(column)}</option>)}</select></label>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy || !column}>{t('Create task')}</button></div>
  </form></Dialog>;
}
function ArchivePolicy({ days, busy, error, onClose, onSave }: { days: number | null; busy: boolean; error: string; onClose: () => void; onSave: (days: number | null) => Promise<void> }) {
  const [enabled, setEnabled] = useState(days !== null), [value, setValue] = useState(String(days ?? 30));
  return <Dialog title={t('Auto-archive')} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!busy) void onSave(enabled ? Number(value) : null); }}>
    <p>{t('Archive Done tasks after this many days without task changes. Sessions are kept. Off by default.')}</p>
    <label className="kanban-attention"><input type="checkbox" disabled={busy} checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('Enable auto-archive')}</label>
    <label className="field-label">{t('Days')}<input type="number" min={1} max={36500} required disabled={busy || !enabled} value={value} onChange={event => setValue(event.target.value)} /></label>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy}>{t('Save changes')}</button></div>
  </form></Dialog>;
}
