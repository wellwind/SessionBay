import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Columns3, GitBranch, GripVertical, Plus, Settings2 } from 'lucide-react';
import { api, errorMessage } from '../api';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import { paneRuntimeStatusText } from '../pane-runtime-status';
import { paneAttention } from '../workspace-overview';
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanSession, KanbanStage, Pane, Project, Workspace } from '../types';
import { Dialog } from './Dialog';
import { dateLabel } from './History';
import { KanbanMoveMenu } from './KanbanMoveMenu';
import { useRuntimeActivity } from './RuntimeActivity';
import { useAnimatedReorder } from './useAnimatedReorder';
import { useKanbanCardDrag } from './useKanbanCardDrag';
import './project-board.css';
import './workspace-organization.css';

export const columnName = (column: KanbanColumn) => column.name ?? t(column.defaultName ?? 'Untitled column');
const cardTitle = (card: KanbanCard) => card.title || t('Untitled task');
const stageNames: Record<KanbanStage, string> = {
  unsorted: t('Unsorted'), todo: t('Todo'), doing: t('In progress'), review: t('Review'), done: t('Done'),
};
const noopSubscribe = () => () => {};
const ordered = <T extends { position: number }>(items: T[]) => [...items].sort((a, b) => a.position - b.position);

function sessionPane(link: KanbanSession, panes: Pane[]) {
  const session = link.session;
  return panes.find(pane => pane.sessionId === session.id) ?? panes.find(pane =>
    !pane.sessionId && pane.kind === session.kind && pane.resumeId === session.externalId && pane.cwd === session.cwd);
}

export function ProjectBoard({ project, workspace, refreshToken = 0 }: {
  project: Project; workspace: Workspace; refreshToken?: number;
}) {
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), generation = useRef(0), alive = useRef(true);
  const [announcement, setAnnouncement] = useState('');
  const [query, setQuery] = useState(''), [agent, setAgent] = useState(''), [attention, setAttention] = useState(false);
  const [settings, setSettings] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const root = useRef<HTMLElement>(null);
  const help = useId();
  const eligible = project.curated && !project.workspaceOnly;
  const read = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api.kanbanBoard(project.id);
      if (alive.current && generation.current === current) { setBoard(next); setError(''); }
    } catch (cause) {
      if (alive.current && generation.current === current) setError(errorMessage(cause));
    } finally {
      if (alive.current && generation.current === current) setLoading(false);
    }
  }, [project.id]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!eligible) { setLoading(false); return; }
    if (!lock.current) void read();
    const refresh = () => { if (!lock.current && document.visibilityState !== 'hidden') void read(); };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [eligible, read, refreshToken]);
  const mutate = async (action: () => Promise<unknown>, message?: string, focusCard?: string) => {
    if (lock.current || !eligible) return false;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lock.current = true;
    generation.current++;
    setBusy(true); setError('');
    try {
      await action();
      const next = await api.kanbanBoard(project.id);
      if (!alive.current) return false;
      setBoard(next);
      if (message) setAnnouncement(message);
      return true;
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
      return false;
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        requestAnimationFrame(() => {
          if (!root.current) return;
          if (document.activeElement !== focused && document.activeElement !== document.body) return;
          const card = focusCard ? [...root.current.querySelectorAll<HTMLElement>('[data-kanban-card]')]
            .find(element => element.dataset.kanbanCard === focusCard) : null;
          if (card) card.querySelector<HTMLButtonElement>('.kanban-card-handle')?.focus();
          else if (focused?.isConnected && !focused.matches(':disabled')) focused.focus();
        });
      }
    }
  };
  const columns = ordered(board?.columns ?? []);
  const cards = ordered(board?.cards ?? []);
  const inColumn = (id: string, excluding?: string) => cards.filter(card => card.columnId === id && card.id !== excluding);
  const moveCard = (id: string, columnId: string, position: number) => {
    const card = cards.find(card => card.id === id), column = columns.find(column => column.id === columnId);
    if (!card || !column || busy || (card.columnId === columnId && card.position === position)) return;
    void mutate(() => api.moveKanbanCard(id, columnId, position),
      t('Moved "{{title}}" to {{column}}, position {{position}}.', { title: cardTitle(card), column: columnName(column), position: position + 1 }), id);
  };
  const moveColumn = (id: string, targetId: string, after: boolean) => {
    const source = columns.find(column => column.id === id);
    if (!source || id === targetId || busy) return;
    const remaining = columns.filter(column => column.id !== id);
    const position = remaining.findIndex(column => column.id === targetId) + Number(after);
    remaining.splice(position, 0, source);
    void mutate(() => api.reorderKanbanColumns(project.id, remaining.map(column => column.id)),
      t('Moved column "{{name}}" to position {{position}}.', { name: columnName(source), position: position + 1 }));
  };
  const columnReorder = useAnimatedReorder(columns, 'x', '.kanban-columns', moveColumn);
  const cardDrag = useKanbanCardDrag(root, JSON.stringify([cards.map(card => [card.id, card.columnId, card.position]), query, agent, attention, busy]), (id, drop) => {
    const remaining = inColumn(drop.columnId, id);
    const position = drop.targetId ? remaining.findIndex(card => card.id === drop.targetId) + Number(drop.after) : remaining.length;
    if (position >= 0) moveCard(id, drop.columnId, position);
  });
  const store = useRuntimeActivity();
  const panes = Object.values(workspace.panes);
  const observed = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => panes.map(pane => store?.paneAgentState(pane.id, pane.runtimeId) ?? '').join('\u0001'), () => '');
  const states = observed.split('\u0001');
  const status = (link: KanbanSession) => {
    const pane = sessionPane(link, panes);
    const observations = pane ? (states[panes.indexOf(pane)] ?? '').split('|') : [];
    const kind = pane ? paneAttention(pane, observations) : 'other';
    const text = pane ? observations.map(value => paneRuntimeStatusText(pane, false, value)).find(Boolean)
      || paneRuntimeStatusText(pane, false, '') || t('Running') : t('Not running');
    return { text, attention: kind === 'input' || kind === 'error', kind };
  };
  const shown = cards.filter(card => !card.archived && (!agent || card.sessions.some(link => link.session.kind === agent))
    && (!attention || card.sessions.some(link => status(link).attention))
    && (!query.trim() || [card.title, card.notes, ...card.sessions.map(link => link.session.title)]
      .some(text => text.toLocaleLowerCase(locale()).includes(query.trim().toLocaleLowerCase(locale())))));
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
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      reorderCard(card, event.key === 'ArrowUp' ? -1 : 1);
    } else {
      const next = columns[columns.findIndex(column => column.id === card.columnId) + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (next) moveCard(card.id, next.id, inColumn(next.id).length);
    }
  };
  if (!eligible) return <div className="empty-state"><p>{t('Add this directory to Projects to enable a board.')}</p></div>;
  if (loading) return <div className="empty-state" role="status">{t('Loading board…')}</div>;
  return <section className="project-board" ref={root} aria-label={t('Project board')} aria-busy={busy}>
    {error && <div className="kanban-error" role="alert">{error}<button disabled={busy} onClick={() => void read()}>{t('Try again')}</button></div>}
    {!board?.enabled ? <div className="empty-state"><Columns3 size={30} aria-hidden="true" /><h2>{t('Plan work on a board')}</h2>
      <p>{t('Enable a board for this project. New sessions will appear in Unsorted; existing history stays as it is.')}</p>
      <button className="primary" disabled={busy} onClick={() => void mutate(() => api.setKanbanBoardEnabled(project.id, true))}>{t('Enable board')}</button></div> : <>
      <header className="kanban-toolbar">
        <label>{t('Search board')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Title, notes or session title')} /></label>
        <label>{t('Agent')}<select value={agent} onChange={event => setAgent(event.target.value)}>
          <option value="">{t('All agents')}</option>{Object.entries(agentNames).map(([kind, name]) => <option value={kind} key={kind}>{name}</option>)}</select></label>
        <label className="kanban-attention"><input type="checkbox" checked={attention} onChange={event => setAttention(event.target.checked)} />{t('Needs attention')}</label>
        <button className="secondary" disabled={busy} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />{t('Add column')}</button>
      </header>
      <span className="organization-sr-only" id={help}>{t('Drag cards to reorder or move between columns. Use Alt+Up/Down to reorder, Alt+Left/Right to change columns, or the Move to menu. Press Escape to cancel dragging.')}</span>
      <span className="organization-sr-only" role="status" aria-live="polite">{announcement}</span>
      {shown.length === 0 && cards.some(card => !card.archived) && <p className="small-muted">{t('No tasks match the filters.')}</p>}
      <div className="kanban-columns" aria-label={t('Board columns')}>
        {columns.map((column, index) => {
          const items = shown.filter(card => card.columnId === column.id);
          const drop = cardDrag.preview;
          return <div key={column.id} data-kanban-column={column.id} className={`kanban-column ${columnReorder.className(column.id)}${drop?.columnId === column.id && !drop.targetId ? ' kanban-drop-column' : ''}`}
            style={columnReorder.style(column.id)} ref={element => columnReorder.ref(column.id, element)}>
            <div className="kanban-column-header" ref={element => columnReorder.targetRef(column.id, element)}>
              <button className="icon-button project-drag" disabled={busy} aria-label={t('Reorder {{name}}', { name: columnName(column) })}
                title={t('Drag to reorder; Alt+Left/Right to move')} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                {...columnReorder.handlers(column.id)} onKeyDown={event => columnKey(event, index)}><GripVertical size={14} aria-hidden="true" /></button>
              <h3 title={columnName(column)}>{columnName(column)}</h3><span className="small-muted">{items.length}</span>
              <button className="icon-button" disabled={busy} aria-label={t('Column settings: {{name}}', { name: columnName(column) })} onClick={() => setSettings(column.id)}><Settings2 size={14} aria-hidden="true" /></button>
            </div>
            <div className="kanban-card-list" role="list" aria-label={columnName(column)}>
              {items.map(card => <div role="listitem" data-kanban-card={card.id} key={card.id}
                className={`kanban-card${drop?.targetId === card.id ? drop.after ? ' kanban-drop-after' : ' kanban-drop-before' : ''}${drop?.id === card.id ? ' kanban-dragging' : ''}`}>
                <div className="kanban-card-head"><button className="icon-button kanban-card-handle" disabled={busy}
                  aria-label={t('Move task {{title}}', { title: cardTitle(card) })} aria-describedby={help} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                  {...cardDrag.handlers(card.id)} onKeyDown={event => cardKey(event, card)}><GripVertical size={14} aria-hidden="true" /></button>
                  <h4>{cardTitle(card)}</h4></div>
                <div className="kanban-card-agents">{card.sessions.map(link => {
                  const live = status(link);
                  return <span key={link.session.id} className={`kanban-status attention-${live.kind}`} title={link.session.title}>{agentNames[link.session.kind]} · {live.text}</span>;
                })}</div>
                {[...new Set(card.sessions.flatMap(link => link.branch ? [link.branch] : []))].map(branch => <span className="kanban-branch" key={branch} title={branch}><GitBranch size={12} aria-hidden="true" />{branch}</span>)}
                <footer><time dateTime={card.updatedAt} title={t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}>{dateLabel(card.updatedAt)}</time>
                  <KanbanMoveMenu title={cardTitle(card)} disabled={busy} options={[
                    { id: 'up', label: t('Move up'), disabled: shown.filter(item => item.columnId === column.id).indexOf(card) === 0,
                      action: () => reorderCard(card, -1) },
                    { id: 'down', label: t('Move down'), disabled: items.indexOf(card) === items.length - 1,
                      action: () => reorderCard(card, 1) },
                    ...columns.map(target => ({ id: target.id, label: columnName(target), disabled: target.id === column.id,
                      action: () => moveCard(card.id, target.id, inColumn(target.id).length) })),
                  ]} />
                </footer>
              </div>)}
              {items.length === 0 && <p className="kanban-empty">{t('No tasks')}</p>}
            </div>
          </div>;
        })}
      </div>
      {adding && <AddColumn busy={busy} onClose={() => { if (!lock.current) setAdding(false); }} onAdd={async (name, stage) => {
        if (await mutate(() => api.createKanbanColumn(project.id, name, stage))) setAdding(false);
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
    {Object.entries(stageNames).map(([stage, name]) => <option value={stage} key={stage}>{name}</option>)}
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
