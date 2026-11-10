import { useRef, useState, type RefObject } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import type { KanbanCard, Project } from '../types';
import { projectInitials } from '../project-identity';
import { AgentIcon } from './AgentIcon';
import { dateLabel } from './History';
import type { KanbanBoards } from './useKanbanBoards';

export function relativeCardTime(value: string) {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] = Math.abs(seconds) < 60 ? ['second', 1]
    : Math.abs(seconds) < 3600 ? ['minute', 60] : Math.abs(seconds) < 86400 ? ['hour', 3600]
      : Math.abs(seconds) < 2592000 ? ['day', 86400] : Math.abs(seconds) < 31536000 ? ['month', 2592000] : ['year', 31536000];
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}
/** Live state worth reading on a card: input, error or work in progress. Idle and stopped sessions stay quiet. */
export function liveStatus(card: KanbanCard, status: KanbanBoards['status']) {
  const states = card.sessions.map(status);
  return states.find(state => state.attention) ?? states.find(state => state.kind === 'working');
}
export function KanbanCardMetadata({ card, status, project, color }: {
  card: KanbanCard; status: KanbanBoards['status']; project?: Project; color?: string;
}) {
  const kinds = [...new Set(card.sessions.map(link => link.session.kind))];
  const names = kinds.map(kind => agentNames[kind]).join(', ');
  const live = liveStatus(card, status);
  const branches = [...new Set(card.sessions.flatMap(link => link.branch ? [link.branch] : []))];
  return <div className="kanban-card-metadata">
    <div className="kanban-card-meta">
      {project && <span className="project-initials" style={{ ['--pane-project' as string]: color }} title={project.name}>
        {projectInitials(project.name)}<span className="organization-sr-only"> {project.name}</span></span>}
      {kinds.length > 0 && <span className="kanban-card-agents" role="img" aria-label={names} title={names}>
        {kinds.slice(0, 3).map(kind => <AgentIcon key={kind} kind={kind} name={agentNames[kind]} />)}
        {kinds.length > 3 && <span className="kanban-agent-more">+{kinds.length - 3}</span>}
      </span>}
      {live && <span className={`kanban-status attention-${live.kind}`} title={live.text}>
        <span className="kanban-status-dot" aria-hidden="true" />{live.shortText}</span>}
      <time dateTime={card.updatedAt} title={t('Updated {{time}}', { time: dateLabel(card.updatedAt) })}>{relativeCardTime(card.updatedAt)}</time>
    </div>
    {branches.map(branch => <span className="kanban-branch" key={branch} title={branch}><GitBranch size={12} aria-hidden="true" />{branch}</span>)}
  </div>;
}
export function KanbanQuickAdd({ busy, onCreate }: { busy: boolean; onCreate: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = () => { setEditing(false); setTitle(''); requestAnimationFrame(() => trigger.current?.focus()); };
  return <div className="kanban-quick-add">
    <button ref={trigger} hidden={editing} disabled={busy} onClick={() => setEditing(true)}><Plus size={13} aria-hidden="true" />{t('New task')}</button>
    {editing && <form onSubmit={async event => {
      event.preventDefault();
      if (!busy && title.trim() && await onCreate(title.trim())) cancel();
    }}><input autoFocus aria-label={t('Task title')} value={title} disabled={busy} maxLength={500}
      onChange={event => setTitle(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      }} /><button type="submit" disabled={busy || !title.trim()}>{t('Create task')}</button></form>}
  </div>;
}
export function KanbanUndo({ data, root }: { data: KanbanBoards; root: RefObject<HTMLElement | null> }) {
  if (!data.undo || (data.undo.origin?.isConnected && data.undo.origin !== root.current)) return null;
  return <div className="kanban-undo" role="status" key={data.undo.message}>{data.undo.message}<button disabled={data.busy} onClick={() => void data.undoLast()}>{t('Undo')}</button></div>;
}
