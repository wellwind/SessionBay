import { AlertTriangle, ArrowDown, ArrowUp, FolderGit2, GitBranch, Link2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { RepoInfo, RepoStatus } from './types';
import { branchLabel, operationLabel } from './types';
import { t } from '../i18n';

export function repoChangeCount(status: RepoStatus | undefined) {
  return status?.entries.length ?? 0;
}

/** Explicit repository choice; every row shows its own branch and change summary. */
export function GitRepoSelector({ repos, statuses, errors, selectedId, onSelect }: {
  repos: RepoInfo[]; statuses: Record<string, RepoStatus>; errors: Record<string, string>;
  selectedId: string | null; onSelect: (id: string) => void;
}) {
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = repos.findIndex(repo => repo.id === selectedId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? repos.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + repos.length) % repos.length;
    onSelect(repos[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return <div className="git-repo-list" role="radiogroup" aria-label={t('Choose repository')} onKeyDown={keys}>
    {repos.map(repo => {
      const status = statuses[repo.id];
      const selected = repo.id === selectedId;
      const changes = repoChangeCount(status);
      return <button key={repo.id} role="radio" aria-checked={selected} tabIndex={selected || (!selectedId && repo === repos[0]) ? 0 : -1}
        className={`git-repo${selected ? ' selected' : ''}`} title={repo.root} onClick={() => onSelect(repo.id)}>
        <FolderGit2 size={15} aria-hidden="true" />
        <span className="git-repo-text">
          <span className="git-repo-name">{repo.name}
            {repo.linkedWorktree && <span className="git-chip" title={t('linked worktree; shares {{dir}}', { dir: repo.commonDir })}><Link2 size={11} aria-hidden="true" />worktree</span>}
          </span>
          <span className="git-repo-path">{repo.enclosesProject ? t('{{root}} (the project is in a subfolder)', { root: repo.root }) : repo.relativePath || t('Project root')}</span>
          <span className="git-repo-meta">
            {errors[repo.id] ? <span className="git-danger"><AlertTriangle size={11} aria-hidden="true" />{t('Could not read status')}</span>
              : status ? <>
                <span><GitBranch size={11} aria-hidden="true" />{status.branch.unborn ? t('{{head}} (no commits yet)', { head: status.branch.head ?? 'HEAD' }) : branchLabel(status.branch)}</span>
                {status.branch.ahead > 0 && <span aria-label={t('Ahead {{count}}', { count: status.branch.ahead })}><ArrowUp size={11} aria-hidden="true" />{status.branch.ahead}</span>}
                {status.branch.behind > 0 && <span aria-label={t('Behind {{count}}', { count: status.branch.behind })}><ArrowDown size={11} aria-hidden="true" />{status.branch.behind}</span>}
                <span>{changes ? t('{{count}} changes', { count: `${changes}${status.truncated ? '+' : ''}` }) : t('No changes')}</span>
                {status.operation && <span className="git-warning">{operationLabel[status.operation]}</span>}
              </> : <span>{t('Loading…')}</span>}
          </span>
        </span>
      </button>;
    })}
  </div>;
}
