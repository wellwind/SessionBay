import { useState } from 'react';
import type { ReactNode } from 'react';
import { Minus, Plus, Undo2 } from 'lucide-react';
import type { Change, RepoStatus, StatusEntry } from './types';
import { changeLabel, conflictLabel, pathKey } from './types';
import { t } from '../i18n';

export type ChangeGroup = 'conflicts' | 'staged' | 'unstaged' | 'untracked';
export const groupTitle: Record<ChangeGroup, string> = {
  conflicts: t('Conflicts'), staged: t('Staged'), unstaged: t('Unstaged'), untracked: t('Untracked'),
};

export function groupEntries(status: RepoStatus): Record<ChangeGroup, StatusEntry[]> {
  const groups: Record<ChangeGroup, StatusEntry[]> = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const entry of status.entries) {
    if (entry.conflict) groups.conflicts.push(entry);
    else if (entry.untracked) groups.untracked.push(entry);
    else {
      if (entry.staged) groups.staged.push(entry);
      if (entry.unstaged) groups.unstaged.push(entry);
    }
  }
  return groups;
}

export function splitPath(path: string) {
  const index = path.lastIndexOf('/');
  return index < 0 ? { name: path, directory: '' } : { name: path.slice(index + 1), directory: path.slice(0, index) };
}

export function ChangeBadge({ change, conflict, untracked }: { change?: Change | null; conflict?: StatusEntry['conflict']; untracked?: boolean }) {
  if (conflict) return <span className="git-badge conflict" title={conflictLabel[conflict]}>!</span>;
  if (untracked) return <span className="git-badge added" title={t('Untracked')}>U</span>;
  if (!change) return null;
  return <span className={`git-badge ${change}`} title={changeLabel[change].text}>{changeLabel[change].letter}</span>;
}

/** One file row; the label always carries the change text, not color alone. */
export function ChangeRow({ entry, group, children, onOpen, selected }: {
  entry: StatusEntry; group: ChangeGroup; children?: ReactNode; onOpen?: () => void; selected?: boolean;
}) {
  const { name, directory } = splitPath(entry.path.path);
  const change = group === 'staged' ? entry.staged : group === 'unstaged' ? entry.unstaged : null;
  const description = entry.conflict ? conflictLabel[entry.conflict] : entry.untracked ? t('Untracked') : change ? changeLabel[change].text : '';
  const label = `${entry.path.path}${t(', {{description}}', { description })}${entry.origPath ? t(', from {{path}}', { path: entry.origPath.path }) : ''}${entry.submodule ? t(', submodule') : ''}`;
  return <li className={`git-change${selected ? ' selected' : ''}`} data-path={pathKey(entry.path)}>
    <button className="git-change-open" aria-label={label} title={entry.path.path} onClick={onOpen} disabled={!onOpen} aria-current={selected || undefined}>
      <ChangeBadge change={change} conflict={entry.conflict} untracked={entry.untracked} />
      <span className="git-change-name">{name}</span>
      <span className="git-change-dir">{entry.origPath ? `${entry.origPath.path} → ` : ''}{directory}</span>
      {entry.submodule && <span className="git-chip">{t('Submodule')}</span>}
    </button>
    {children && <span className="git-change-actions">{children}</span>}
  </li>;
}

export interface ChangeActions {
  busy: boolean;
  activeKey?: string | null;
  onOpen: (entry: StatusEntry, group: ChangeGroup) => void;
  onStage: (entries: StatusEntry[]) => void;
  onUnstage: (entries: StatusEntry[]) => void;
  onDiscard?: (entries: StatusEntry[]) => void;
}

/** Rows rendered per group before "show more"; group actions still cover every entry. */
export const CHANGE_PAGE = 200;
const CHANGE_MORE = 500;

export function GitChanges({ status, actions }: { status: RepoStatus; actions?: ChangeActions }) {
  const groups = groupEntries(status);
  const order: ChangeGroup[] = ['conflicts', 'staged', 'unstaged', 'untracked'];
  // Thousands of rows (each with buttons and icons) cost hundreds of MiB and
  // half-second tasks; render a window and grow it on request, per repository.
  const [shown, setShown] = useState<{ repoId: string; limits: Partial<Record<ChangeGroup, number>> }>({ repoId: status.repoId, limits: {} });
  const limits = shown.repoId === status.repoId ? shown.limits : {};
  if (!status.entries.length) return <p className="git-muted git-clean" role="status">{t('No changes in the working tree.')}</p>;
  const rowKey = (group: ChangeGroup, entry: StatusEntry) => `${group}:${pathKey(entry.path)}`;
  const limitFor = (group: ChangeGroup) => {
    const active = groups[group].findIndex(entry => actions?.activeKey === rowKey(group, entry));
    return Math.max(limits[group] ?? CHANGE_PAGE, active + 1);
  };
  const more = (group: ChangeGroup) => setShown({ repoId: status.repoId, limits: { ...limits, [group]: limitFor(group) + CHANGE_MORE } });
  return <div className="git-changes">
    {status.truncated && <p className="git-notice" role="status">{t('Too many changes; listing the first {{count}}.', { count: status.entries.length })}</p>}
    {order.filter(group => groups[group].length).map(group => <section key={group} className="git-change-group" aria-label={groupTitle[group]}>
      <h3>{groupTitle[group]}<span>{groups[group].length}</span>
        {actions && group !== 'conflicts' && <span className="git-group-actions">
          {group === 'staged'
            ? <button className="git-icon-button" disabled={actions.busy} aria-label={t('Unstage all')} title={t('Unstage all')} onClick={() => actions.onUnstage(groups.staged)}><Minus size={14} /></button>
            : <button className="git-icon-button" disabled={actions.busy} aria-label={t('Stage all {{group}}', { group: groupTitle[group] })} title={t('Stage all {{group}} files', { group: groupTitle[group] })} onClick={() => actions.onStage(groups[group])}><Plus size={14} /></button>}
        </span>}
      </h3>
      <ul>{groups[group].slice(0, limitFor(group)).map(entry => <ChangeRow key={rowKey(group, entry)} entry={entry} group={group}
        selected={actions?.activeKey === rowKey(group, entry)} onOpen={actions ? () => actions.onOpen(entry, group) : undefined}>
        {actions && group === 'staged' && <button disabled={actions.busy} aria-label={t('Unstage {{path}}', { path: entry.path.path })} title={t('Unstage')} onClick={() => actions.onUnstage([entry])}><Minus size={14} /></button>}
        {actions?.onDiscard && (group === 'unstaged' || group === 'untracked') && !entry.submodule && <button disabled={actions.busy}
          aria-label={t('Discard changes to {{path}}', { path: entry.path.path })} title={group === 'untracked' ? t('Delete untracked file (backed up first)') : t('Discard working tree changes (a recovery point is created first)')}
          onClick={() => actions.onDiscard?.([entry])}><Undo2 size={14} /></button>}
        {actions && (group === 'unstaged' || group === 'untracked') && <button disabled={actions.busy} aria-label={t('Stage {{path}}', { path: entry.path.path })} title={t('Stage whole file')} onClick={() => actions.onStage([entry])}><Plus size={14} /></button>}
      </ChangeRow>)}</ul>
      {groups[group].length > limitFor(group) && <button className="git-show-more" onClick={() => more(group)}>
        {t('Show {{count}} more ({{remaining}} remaining)', { count: Math.min(CHANGE_MORE, groups[group].length - limitFor(group)), remaining: groups[group].length - limitFor(group) })}</button>}
    </section>)}
  </div>;
}
