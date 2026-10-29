import { useRef, useState, type RefObject } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import { agentNames } from '../agents';
import { locale, t } from '../i18n';
import type { KanbanCard } from '../types';
import type { KanbanBoards } from './useKanbanBoards';

export function relativeCardTime(value: string) {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] = Math.abs(seconds) < 60 ? ['second', 1]
    : Math.abs(seconds) < 3600 ? ['minute', 60] : Math.abs(seconds) < 86400 ? ['hour', 3600]
      : Math.abs(seconds) < 2592000 ? ['day', 86400] : Math.abs(seconds) < 31536000 ? ['month', 2592000] : ['year', 31536000];
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}
export function KanbanCardMetadata({ card, status }: { card: KanbanCard; status: KanbanBoards['status'] }) {
  return <div className="kanban-card-metadata">
    <div className="kanban-card-agents">{card.sessions.map(link => {
      const live = status(link);
      return <span key={link.session.id} className={`kanban-status attention-${live.kind}`} title={`${agentNames[link.session.kind]} · ${live.text}`}>
        <span className="kanban-status-dot" aria-hidden="true" />{agentNames[link.session.kind]} · {live.shortText}
      </span>;
    })}</div>
    {[...new Set(card.sessions.flatMap(link => link.branch ? [link.branch] : []))].map(branch =>
      <span className="kanban-branch" key={branch} title={branch}><GitBranch size={12} aria-hidden="true" />{branch}</span>)}
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
  return <div className="kanban-undo" role="status">{data.undo.message}<button disabled={data.busy} onClick={() => void data.undoLast()}>{t('Undo')}</button></div>;
}
