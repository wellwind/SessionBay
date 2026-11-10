import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowLeft, ChevronDown, Columns3, Plus, X } from 'lucide-react';
import { api } from '../api';
import { projectColor, projectColorSlots } from '../project-identity';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import type { KanbanCard, KanbanStage, Project, Session, Workspace } from '../types';
import { KanbanCardDetails } from './KanbanCardDetails';
import { Dialog } from './Dialog';
import { KanbanMenu } from './KanbanMenu';
import { KanbanCardMetadata, KanbanQuickAdd, KanbanUndo, liveStatus } from './KanbanShared';
import { KanbanScroll } from './KanbanScroll';
import {
  boardStages, cardStage, cardTitle, columnName, ordered, stageColumn, stageNames, useKanbanBoards,
  type BoardStage, type KanbanBoards,
} from './useKanbanBoards';
export { columnName } from './useKanbanBoards';
import { useKanbanCardDrag } from './useKanbanCardDrag';
import './project-board.css';
import './workspace-organization.css';

const DONE_PREVIEW = 5;
const LEAVE_MS = 180;
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
type BoardProps = {
  workspace: Workspace; refreshToken?: number; model?: KanbanBoards;
  onStart?: (card: KanbanCard, project: Project) => void;
  onResume?: (session: Session) => void; onHistoryChanged?: () => Promise<void>;
  /** Projects offered by the scope switcher; choosing null shows every project. */
  scopes?: Project[]; onScope?: (project: Project | null) => void;
} & ({ project: Project; projects?: never } | { project?: never; projects: Project[] });

/** One board for a project or every project: four fixed stages, with unfiled sessions offered as suggestions. */
export function ProjectBoard({ project, projects, workspace, refreshToken = 0, onStart, onResume, onHistoryChanged, model, scopes, onScope }: BoardProps) {
  const overview = projects !== undefined;
  const eligible = overview || !!(project?.curated && !project.workspaceOnly);
  const local = useKanbanBoards(workspace, project?.id, eligible && !model, refreshToken);
  const data = model ?? local;
  const { snapshots, loading, error, busy, lock, announcement, read, mutate, status } = data;
  const owners = projects ?? (project ? [project] : []);
  const enabled = snapshots.filter(board => board.enabled && (!overview || owners.some(owner => owner.id === board.projectId && owner.curated && !owner.workspaceOnly)));
  const board = overview ? undefined : snapshots[0];
  const colorSlots = projectColorSlots(owners.map(owner => owner.id));
  const [query, setQuery] = useState(''), [agent, setAgent] = useState(''), [attention, setAttention] = useState(false);
  const [details, setLocalDetails] = useState<string | null>(null), [archived, setArchived] = useState(false);
  const setDetails = (id: string | null) => { setLocalDetails(id); data.setSelectedId(id); };
  const [newTask, setNewTask] = useState(false), [policy, setPolicy] = useState(false);
  const [renaming, setRenaming] = useState<BoardStage | null>(null);
  const [merge, setMerge] = useState<{ source: string; target: string } | null>(null);
  const [groupBy, setGroupBy] = useState('none');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [suggestionsOpen, setSuggestionsOpen] = useState(true), [dismissAll, setDismissAll] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const searchInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const help = useId(), suggestionsId = useId();
  const search = useDeferredValue(query.trim().toLocaleLowerCase(locale()));

  const boardOf = (card: KanbanCard) => enabled.find(item => item.projectId === card.projectId);
  const stageOf = (card: KanbanCard) => cardStage(boardOf(card), card);
  const owner = (card: KanbanCard) => owners.find(item => item.id === card.projectId)!;
  const cards = enabled.flatMap(item => ordered(item.columns).flatMap(column => ordered(item.cards.filter(card => card.columnId === column.id))));
  const stageLabel = (stage: KanbanStage) => {
    const column = !overview ? stageColumn(board, stage) : undefined;
    return column ? columnName(column) : t(stageNames[stage]);
  };
  const needsAttention = (card: KanbanCard) => card.sessions.some(link => status(link).attention);
  const matches = (card: KanbanCard) => (!agent || card.sessions.some(link => link.session.kind === agent))
    && (!attention || needsAttention(card))
    && (!search || [card.title, card.notes, ...card.sessions.map(link => link.session.title)]
      .some(text => text.toLocaleLowerCase(locale()).includes(search)));
  const active = cards.filter(card => !card.archived);
  const suggestions = active.filter(card => stageOf(card) === 'unsorted');
  const shown = cards.filter(card => card.archived === archived && (archived || stageOf(card) !== 'unsorted') && matches(card));
  const archivedCount = cards.filter(card => card.archived).length;
  const attentionCount = active.filter(needsAttention).length;
  // Catalog order of a stage column, including archived and filtered cards.
  const siblings = (card: KanbanCard, stage: KanbanStage) => {
    const column = stageColumn(boardOf(card), stage);
    return ordered(boardOf(card)?.cards.filter(item => item.columnId === column?.id && item.id !== card.id) ?? []);
  };
  const moveTo = async (card: KanbanCard, stage: KanbanStage, position?: number) => {
    const column = stageColumn(boardOf(card), stage);
    if (!column || busy) return;
    const at = position ?? siblings(card, stage).length;
    if (card.columnId === column.id && card.position === at) return;
    if (stage === 'done') setExpanded(previous => ({ ...previous, [`${overview && groupBy === 'project' ? card.projectId : ''}:done`]: true }));
    await data.move(card, column, at, root.current);
  };
  // Removed rows fade and fold before the catalog change re-renders the list.
  const leave = async (id: string, action: () => Promise<unknown>) => {
    setLeaving(previous => new Set(previous).add(id));
    if (!reducedMotion()) await new Promise(done => setTimeout(done, LEAVE_MS));
    try { await action(); } finally { setLeaving(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  };
  const start = onStart ? async (card: KanbanCard) => {
    setDetails(null);
    const stage = stageOf(card);
    // Starting is an explicit user action, so it is the one automatic move: planned work becomes In progress.
    if (stage === 'todo' || stage === 'unsorted') await moveTo(card, 'doing');
    if (root.current?.isConnected) onStart(card, owner(card));
  } : undefined;
  const cardDrag = useKanbanCardDrag(root, JSON.stringify([cards.map(card => [card.id, card.columnId, card.position]), query, agent, attention, busy, archived]), (id, drop) => {
    const card = cards.find(item => item.id === id);
    const stage = drop.columnId as BoardStage;
    if (!card || !boardStages.includes(stage)) return;
    const target = drop.targetId ? cards.find(item => item.id === drop.targetId) : undefined;
    if (!target || target.projectId !== card.projectId) { void moveTo(card, stage); return; }
    const index = siblings(card, stage).findIndex(item => item.id === target.id);
    void moveTo(card, stage, index < 0 ? undefined : index + Number(drop.after));
  }, !busy && !archived);
  const cardKey = (event: KeyboardEvent<HTMLButtonElement>, card: KanbanCard) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || archived) return;
    event.preventDefault(); event.stopPropagation();
    const stage = stageOf(card) as BoardStage;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const visible = shown.filter(item => stageOf(item) === stage && item.projectId === card.projectId);
      const next = visible[visible.indexOf(card) + direction];
      if (next) void moveTo(card, stage, siblings(card, stage).indexOf(next) + Number(direction === 1));
    } else {
      const next = boardStages[boardStages.indexOf(stage) + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (next) void moveTo(card, next);
    }
  };
  const focusCard = (id: string | undefined) => requestAnimationFrame(() => {
    const element = [...(root.current?.querySelectorAll<HTMLElement>('[data-kanban-card]') ?? [])].find(item => item.dataset.kanbanCard === id);
    (element?.querySelector<HTMLElement>('.kanban-card-open, .kanban-suggestion-title') ?? searchInput.current)?.focus();
  });
  const dismissMerge = () => { if (lock.current) return; const source = merge?.source; setMerge(null); focusCard(source); };
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

  const renderCard = (card: KanbanCard) => {
    const drop = cardDrag.preview;
    const color = overview ? projectColor(card.projectId, colorSlots) : undefined;
    return <div role="listitem" data-kanban-card={card.id} key={card.id} {...cardDrag.handlers(card.id)}
      style={color ? { ['--pane-project' as string]: color } : undefined}
      onClick={event => { if (!busy && !(event.target as Element).closest('button')) setDetails(card.id); }}
      className={`kanban-card${overview ? ' kanban-card-project' : ''}${needsAttention(card) ? ' kanban-needs-attention' : ''}${data.selectedId === card.id ? ' kanban-selected' : ''}${drop?.targetId === card.id ? drop.after ? ' kanban-drop-after' : ' kanban-drop-before' : ''}${drop?.id === card.id ? ' kanban-dragging' : ''}`}>
      <div className="kanban-card-head">
        <h4><button className="kanban-card-open" disabled={busy} onClick={() => setDetails(card.id)} onKeyDown={event => cardKey(event, card)}
          aria-describedby={help} aria-keyshortcuts={archived ? undefined : 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight'}>{cardTitle(card)}</button></h4>
        {needsAttention(card) && <AlertTriangle size={14} aria-label={t('Needs attention')} />}
      </div>
      <KanbanCardMetadata card={card} status={status} project={overview ? owner(card) : undefined} color={color} />
    </div>;
  };
  const columnMenu = (stage: BoardStage) => <KanbanMenu label={t('Column actions: {{name}}', { name: stageLabel(stage) })} disabled={busy}>
    <button onClick={() => setRenaming(stage)}>{t('Rename…')}</button>
  </KanbanMenu>;
  const renderColumn = (stage: BoardStage, lane?: Project) => {
    const items = shown.filter(card => stageOf(card) === stage && (!lane || card.projectId === lane.id));
    const drop = cardDrag.preview;
    const expandKey = `${lane?.id ?? ''}:${stage}`;
    const visible = stage === 'done' && !expanded[expandKey] ? items.slice(0, DONE_PREVIEW) : items;
    const quickAdd = !overview && stageColumn(board, stage);
    return <div key={stage} data-kanban-column={stage}
      className={`kanban-column${drop?.columnId === stage && !drop.targetId ? ' kanban-drop-column' : ''}`}>
      <div className="kanban-column-header">
        <span className={`kanban-stage-dot stage-${stage}`} aria-hidden="true" /><h3 title={stageLabel(stage)}>{stageLabel(stage)}</h3>
        <span className="kanban-count">{items.length}</span>
        {!overview && columnMenu(stage)}
      </div>
      <div className="kanban-card-list" role="list" aria-label={stageLabel(stage)}>
        {visible.map(renderCard)}
        {items.length === 0 && <p className="kanban-empty">{stage === 'todo' && !overview ? t('Plan the next piece of work here') : t('Drag tasks here')}</p>}
      </div>
      {stage === 'done' && items.length > DONE_PREVIEW && <button className="link-button kanban-show-more" onClick={() => setExpanded(previous => ({ ...previous, [expandKey]: !previous[expandKey] }))}>
        {expanded[expandKey] ? t('Show less') : t('Show {{count}} more', { count: items.length - DONE_PREVIEW })}</button>}
      {stage === 'done' && !lane && (archivedCount > 0 || !!board?.autoArchiveDays) && <footer className="kanban-column-footer">
        {board?.autoArchiveDays && <span className="small-muted">{t('Archived automatically after {{count}} days', { count: board.autoArchiveDays })}</span>}
        {archivedCount > 0 && <button className="link-button" onClick={() => setArchived(true)}>{t('Archived ({{count}})', { count: archivedCount })} →</button>}
      </footer>}
      {quickAdd && <KanbanQuickAdd busy={busy} onCreate={title => mutate(() => api.createKanbanCard(quickAdd.id, title, ''))} />}
    </div>;
  };
  const targetsFor = (card: KanbanCard) => active.filter(item => item.projectId === card.projectId && item.id !== card.id && stageOf(item) !== 'unsorted')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const addToTask = (card: KanbanCard, target: KanbanCard) => leave(card.id, () => mutate(async () => {
    // Attach instead of merging so the task keeps its own title and notes.
    for (const link of card.sessions) await api.attachKanbanSession(target.id, link.session.id);
    await api.deleteKanbanCard(card.id, 'detach');
  }, t('Added to "{{title}}".', { title: cardTitle(target) })));
  const dismiss = (card: KanbanCard) => leave(card.id, () => mutate(() => api.deleteKanbanCard(card.id, 'detach'), t('Dismissed "{{title}}".', { title: cardTitle(card) })));
  const visibleSuggestions = suggestions.filter(matches);
  const renderSuggestions = () => <section className="kanban-suggestions" aria-labelledby={suggestionsId}>
    <header>
      <button className="kanban-suggestions-toggle" aria-expanded={suggestionsOpen} aria-controls={`${suggestionsId}-list`} onClick={() => setSuggestionsOpen(!suggestionsOpen)}>
        <ChevronDown size={14} aria-hidden="true" /><span id={suggestionsId}>{t('{{count}} sessions are not in a task yet', { count: suggestions.length })}</span>
      </button>
      {suggestionsOpen && <button className="link-button" disabled={busy} onClick={() => setDismissAll(true)}>{t('Dismiss all')}</button>}
    </header>
    <ul id={`${suggestionsId}-list`} hidden={!suggestionsOpen}>
      {visibleSuggestions.map(card => {
        const targets = targetsFor(card), live = liveStatus(card, status);
        const color = overview ? projectColor(card.projectId, colorSlots) : undefined;
        return <li key={card.id} data-kanban-card={card.id} className={`kanban-suggestion${leaving.has(card.id) ? ' kanban-leaving' : ''}`}
          style={color ? { ['--pane-project' as string]: color } : undefined}><div className="kanban-suggestion-row">
          <KanbanCardMetadata card={{ ...card, sessions: card.sessions.map(link => ({ ...link, branch: null })) }} status={status} project={overview ? owner(card) : undefined} color={color} />
          <button className="kanban-suggestion-title" disabled={busy} onClick={() => setDetails(card.id)} title={cardTitle(card)}>{cardTitle(card)}</button>
          {live && <span className="organization-sr-only">{live.shortText}</span>}
          <div className="kanban-suggestion-actions">
            <KanbanMenu label={t('Add "{{title}}" to a task', { title: cardTitle(card) })} trigger={t('Add to task…')} disabled={busy || !targets.length}>
              {targets.map(target => <button key={target.id} onClick={() => void addToTask(card, target)}>{cardTitle(target)}</button>)}
            </KanbanMenu>
            <button className="secondary" disabled={busy || !stageColumn(boardOf(card), 'todo')} onClick={() => void leave(card.id, () => moveTo(card, 'todo'))}>{t('Make it a task')}</button>
            <button className="icon-button" disabled={busy} aria-label={t('Dismiss "{{title}}"', { title: cardTitle(card) })} title={t('Dismiss')} onClick={() => void dismiss(card)}><X size={14} aria-hidden="true" /></button>
          </div>
        </div></li>;
      })}
      {visibleSuggestions.length === 0 && <li className="small-muted kanban-suggestion-empty">{t('No suggestions match the filters.')}</li>}
    </ul>
  </section>;
  const scopeSelect = onScope && scopes && <label className="kanban-scope"><span className="organization-sr-only">{t('Board scope')}</span>
    <select aria-label={t('Board scope')} value={project?.id ?? ''} onChange={event => onScope(scopes.find(item => item.id === event.target.value) ?? null)}>
      <option value="">{t('All projects')}</option>
      {scopes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>;
  const detailsCard = details ? cards.find(card => card.id === details) : undefined;

  if (!eligible) return <div className="empty-state"><p>{t('Add this directory to Projects to enable a board.')}</p></div>;
  if (loading) return <div className="empty-state" role="status">{t('Loading board…')}</div>;
  return <section className="project-board" ref={root} data-kanban-surface tabIndex={-1} aria-label={overview ? t('All boards') : t('Project board')} aria-busy={busy}>
    {error && <div className="kanban-error" role="alert">{error}<button disabled={busy} onClick={() => void read()}>{t('Try again')}</button></div>}
    {overview && enabled.length === 0 ? <div className="empty-state">{scopeSelect}<Columns3 size={30} aria-hidden="true" /><h2>{t('No enabled boards')}</h2><p>{t('Open a project and choose Board to start planning its tasks.')}</p></div>
      : !overview && !board?.enabled ? <div className="empty-state">{scopeSelect}<Columns3 size={30} aria-hidden="true" /><h2>{t('Plan agent work as tasks')}</h2>
        <p>{t('Write down what you want done, start an agent from the task, and follow every session it creates. New sessions are suggested for filing; existing history stays as it is.')}</p>
        <button className="primary" disabled={busy} onClick={() => void mutate(() => api.setKanbanBoardEnabled(project!.id, true))}>{t('Enable board')}</button></div> : <>
        <header className="kanban-toolbar">
          {scopeSelect}
          {archived && <button className="secondary" onClick={() => { setArchived(false); requestAnimationFrame(() => searchInput.current?.focus()); }}><ArrowLeft size={14} aria-hidden="true" />{t('Back to board')}</button>}
          <label className="kanban-search"><input ref={searchInput} aria-label={t('Search board')} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search tasks, notes or sessions')} /><kbd aria-hidden="true">/</kbd></label>
          <KanbanMenu label={t('Filter')} trigger={t('Filter')}>
            <label className="field-label">{t('Agent')}<select value={agent} onChange={event => setAgent(event.target.value)}>
              <option value="">{t('All agents')}</option>{Object.entries(agentNames).map(([kind, name]) => <option value={kind} key={kind}>{name}</option>)}</select></label>
          </KanbanMenu>
          {agent && <button className="secondary kanban-filter-chip" onClick={() => setAgent('')} aria-label={t('Remove agent filter')}>{agentNames[agent as keyof typeof agentNames]} ×</button>}
          {(attentionCount > 0 || attention) && <button className="secondary kanban-attention-toggle" aria-pressed={attention} onClick={() => setAttention(!attention)}>
            <AlertTriangle size={14} aria-hidden="true" />{t('Needs attention')} <span className="kanban-count">{attentionCount}</span></button>}
          <div className="kanban-toolbar-spacer" />
          {overview && !archived && <label className="kanban-group-by">{t('Group by')}<select value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="none">{t('None')}</option><option value="project">{t('Project')}</option></select></label>}
          {!overview && <KanbanMenu label={t('Board actions')} disabled={busy}><button onClick={() => setPolicy(true)}>{t('Auto-archive…')}</button></KanbanMenu>}
          {!archived && <button className="primary" disabled={busy} onClick={() => setNewTask(true)}><Plus size={14} aria-hidden="true" />{t('New task')}</button>}
        </header>
        <span className="organization-sr-only" id={help}>{overview ? t('Drag cards to change stage within their project, or use Alt+Left/Right. Press Escape to cancel dragging.') : t('Drag cards to reorder or change stage. Use Alt+Up/Down to reorder, Alt+Left/Right to change stage, or the Stage menu in task details. Press Escape to cancel dragging.')}</span>
        <span className="organization-sr-only" role="status" aria-live="polite">{!data.announcementOrigin || data.announcementOrigin === root.current ? announcement : ''}</span>
        {!archived && suggestions.length > 0 && renderSuggestions()}
        {shown.length === 0 && (archived ? archivedCount > 0 : active.some(card => stageOf(card) !== 'unsorted')) && <p className="small-muted">{t('No tasks match the filters.')}</p>}
        {archived ? <div className="kanban-archived"><h3>{t('Archived tasks')}</h3>
          <div className="kanban-archived-list" role="list" aria-label={t('Archived tasks')}>{shown.map(renderCard)}</div>
          {archivedCount === 0 && <p className="kanban-empty">{t('No archived tasks.')}</p>}</div>
          : overview && groupBy === 'project' ? <div className="kanban-lanes">{owners.filter(item => enabled.some(entry => entry.projectId === item.id)).map(item =>
            <section className="kanban-swimlane" key={item.id} aria-label={item.name} style={{ ['--pane-project' as string]: projectColor(item.id, colorSlots) }}>
              <h3><span className="kanban-lane-dot" aria-hidden="true" />{item.name}</h3>
              <KanbanScroll count={boardStages.length}>{boardStages.map(stage => renderColumn(stage, item))}</KanbanScroll></section>)}</div>
            : <KanbanScroll count={boardStages.length}>{boardStages.map(stage => renderColumn(stage))}</KanbanScroll>}
        {!details && <KanbanUndo data={data} root={root} />}
        {detailsCard && <KanbanCardDetails key={detailsCard.id} card={detailsCard} project={owner(detailsCard)}
          columns={ordered(boardOf(detailsCard)?.columns ?? [])} busy={busy} error={error} mutate={mutate} save={data.saveCard} status={status}
          feedback={<KanbanUndo data={data} root={root} />}
          onMove={column => void moveTo(detailsCard, column.stage)} onArchive={() => data.archive(detailsCard.id, root.current)}
          mergeTargets={active.filter(card => card.id !== detailsCard.id && card.projectId === detailsCard.projectId)}
          onMerge={target => { setDetails(null); setMerge({ source: detailsCard.id, target }); }}
          onClose={() => { if (!lock.current) { setDetails(null); focusCard(detailsCard.id); } }}
          onStart={start} onResume={onResume ? session => { setDetails(null); onResume(session); } : undefined} onHistoryChanged={onHistoryChanged} />}
        {newTask && <NewTask projects={owners.filter(item => enabled.some(entry => entry.projectId === item.id))} overview={overview} busy={busy} error={error}
          onClose={() => { if (!lock.current) setNewTask(false); }} onCreate={async (projectId, stage, title, notes) => {
            const column = stageColumn(enabled.find(item => item.projectId === projectId), stage);
            if (!column) return;
            let created: KanbanCard | undefined;
            if (await mutate(async () => { created = await api.createKanbanCard(column.id, title, notes); })) { setNewTask(false); setDetails(created!.id); }
          }} />}
        {policy && <ArchivePolicy days={board?.autoArchiveDays ?? null} busy={busy} error={error} onClose={() => { if (!lock.current) setPolicy(false); }}
          onSave={async days => { if (await mutate(() => api.setKanbanAutoArchive(project!.id, days))) setPolicy(false); }} />}
        {renaming && stageColumn(board, renaming) && <RenameColumn key={renaming} name={stageLabel(renaming)} busy={busy} error={error}
          onClose={() => { if (!lock.current) setRenaming(null); }}
          onRename={async name => { if (await mutate(() => api.renameKanbanColumn(stageColumn(board, renaming)!.id, name))) setRenaming(null); }} />}
        {dismissAll && <Dialog title={t('Dismiss all suggestions?')} onClose={() => { if (!lock.current) setDismissAll(false); }}>
          <p>{t('These sessions leave the board and will not be suggested again. Their history is kept, and you can still add one to a task with Attach from history.')}</p>
          {error && <p className="inline-warning" role="alert">{error}</p>}
          <div className="dialog-actions"><button disabled={busy} onClick={() => setDismissAll(false)}>{t('Cancel')}</button>
            <button className="primary" data-dialog-confirm disabled={busy} onClick={async () => {
              if (await mutate(async () => { for (const card of suggestions) await api.deleteKanbanCard(card.id, 'detach'); })) setDismissAll(false);
            }}>{t('Dismiss all')}</button></div>
        </Dialog>}
        {merge && cards.some(card => card.id === merge.source) && cards.some(card => card.id === merge.target) && <Dialog title={t('Merge tasks?')} onClose={dismissMerge}>
          <p>{t('Merge "{{source}}" into "{{target}}"? Sessions and notes move to the target; the source task is deleted.', { source: cardTitle(cards.find(card => card.id === merge.source)!), target: cardTitle(cards.find(card => card.id === merge.target)!) })}</p>
          {error && <p className="inline-warning" role="alert">{error}</p>}
          <div className="dialog-actions"><button disabled={busy} onClick={dismissMerge}>{t('Cancel')}</button><button className="primary" data-dialog-confirm disabled={busy} onClick={async () => {
            if (await mutate(() => api.mergeKanbanCards(merge.source, merge.target), undefined, merge.target)) setMerge(null);
          }}>{t('Merge tasks')}</button></div>
        </Dialog>}
      </>}
  </section>;
}

function RenameColumn({ name: initial, busy, error, onClose, onRename }: { name: string; busy: boolean; error: string; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  return <Dialog title={t('Rename column')} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void onRename(name.trim()); }}>
    <label className="field-label">{t('Column name')}<input value={name} maxLength={500} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <p className="small-muted">{t('Columns are fixed to four stages so every board reads the same way. Only the name changes.')}</p>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy || !name.trim() || name === initial}>{t('Rename column')}</button></div>
  </form></Dialog>;
}
function NewTask({ projects, overview, busy, error, onClose, onCreate }: {
  projects: Project[]; overview: boolean; busy: boolean; error: string; onClose: () => void;
  onCreate: (projectId: string, stage: BoardStage, title: string, notes: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [stage, setStage] = useState<BoardStage>('todo');
  const [title, setTitle] = useState(''), [notes, setNotes] = useState('');
  return <Dialog title={t('New task')} onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!busy && projectId) void onCreate(projectId, stage, title, notes); }}>
    <label className="field-label">{t('Title')}<input value={title} maxLength={500} disabled={busy} placeholder={t('Untitled task')} onChange={event => setTitle(event.target.value)} /></label>
    <label className="field-label">{t('Notes')}<textarea rows={4} value={notes} disabled={busy} placeholder={t('What should the agent do? Notes are pasted into the terminal when you start.')} onChange={event => setNotes(event.target.value)} /></label>
    <div className="kanban-form-row">
      {overview && <label className="field-label">{t('Project')}<select value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}>
        {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <label className="field-label">{t('Stage')}<select value={stage} disabled={busy} onChange={event => setStage(event.target.value as BoardStage)}>
        {boardStages.map(item => <option key={item} value={item}>{t(stageNames[item])}</option>)}</select></label>
    </div>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={busy || !projectId}>{t('Create task')}</button></div>
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
