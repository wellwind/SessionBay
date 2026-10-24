import type { ReactNode } from 'react';
import type { Change, RepoStatus, StatusEntry } from './types';
import { changeLabel, conflictLabel, pathKey } from './types';

export type ChangeGroup = 'conflicts' | 'staged' | 'unstaged' | 'untracked';
export const groupTitle: Record<ChangeGroup, string> = {
  conflicts: '衝突', staged: '已暫存', unstaged: '未暫存', untracked: '未追蹤',
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
  if (untracked) return <span className="git-badge added" title="未追蹤">U</span>;
  if (!change) return null;
  return <span className={`git-badge ${change}`} title={changeLabel[change].text}>{changeLabel[change].letter}</span>;
}

/** One file row; the label always carries the change text, not color alone. */
export function ChangeRow({ entry, group, children, onOpen, selected }: {
  entry: StatusEntry; group: ChangeGroup; children?: ReactNode; onOpen?: () => void; selected?: boolean;
}) {
  const { name, directory } = splitPath(entry.path.path);
  const change = group === 'staged' ? entry.staged : group === 'unstaged' ? entry.unstaged : null;
  const description = entry.conflict ? conflictLabel[entry.conflict] : entry.untracked ? '未追蹤' : change ? changeLabel[change].text : '';
  const label = `${entry.path.path}，${description}${entry.origPath ? `，原路徑 ${entry.origPath.path}` : ''}${entry.submodule ? '，子模組' : ''}`;
  return <li className={`git-change${selected ? ' selected' : ''}`} data-path={pathKey(entry.path)}>
    <button className="git-change-open" aria-label={label} title={entry.path.path} onClick={onOpen} disabled={!onOpen} aria-current={selected || undefined}>
      <ChangeBadge change={change} conflict={entry.conflict} untracked={entry.untracked} />
      <span className="git-change-name">{name}</span>
      <span className="git-change-dir">{entry.origPath ? `${entry.origPath.path} → ` : ''}{directory}</span>
      {entry.submodule && <span className="git-chip">子模組</span>}
    </button>
    {children && <span className="git-change-actions">{children}</span>}
  </li>;
}

export function GitChanges({ status }: { status: RepoStatus }) {
  const groups = groupEntries(status);
  const order: ChangeGroup[] = ['conflicts', 'staged', 'unstaged', 'untracked'];
  if (!status.entries.length) return <p className="git-muted git-clean" role="status">工作目錄沒有變更。</p>;
  return <div className="git-changes">
    {status.truncated && <p className="git-notice" role="status">變更過多，只列出前 {status.entries.length} 項。</p>}
    {order.filter(group => groups[group].length).map(group => <section key={group} className="git-change-group" aria-label={groupTitle[group]}>
      <h3>{groupTitle[group]}<span>{groups[group].length}</span></h3>
      <ul>{groups[group].map(entry => <ChangeRow key={`${group}:${pathKey(entry.path)}`} entry={entry} group={group} />)}</ul>
    </section>)}
  </div>;
}
