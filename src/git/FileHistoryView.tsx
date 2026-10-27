import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, ScrollText } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { FileRevision, RepoPath } from './types';
import { formatTime } from './types';
import { RefChips } from './RefChips';
import { t } from '../i18n';

/** Commits touching one file, following renames; each opens its diff. */
export function FileHistoryView({ projectId, repoId, repoName, path, onOpenDiff, onBlame }: {
  projectId: string; repoId: string; repoName: string; path: RepoPath;
  onOpenDiff: (revision: FileRevision) => void; onBlame: (path: RepoPath, rev: string) => void;
}) {
  const [revisions, setRevisions] = useState<FileRevision[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const page = await gitApi.fileHistory(projectId, repoId, path, offset, 100);
      setRevisions(previous => offset ? [...previous, ...page.revisions] : page.revisions);
      setHasMore(page.hasMore); setError('');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }, [projectId, repoId, path]);
  useEffect(() => { void load(0); }, [load]);
  return <div className="git-file-history">
    <div className="git-doc-toolbar"><span className="git-doc-title"><strong>{t('History {{file}}', { file: path.path })}</strong><span className="git-muted"> · {t('{{repo}} (follows renames)', { repo: repoName })}</span></span></div>
    {error && <p className="git-error" role="alert">{error}</p>}
    <ul className="git-revision-list" aria-label={t('History of {{path}}', { path: path.path })}>
      {revisions.map(revision => <li key={revision.commit.oid} className="git-change">
        <button className="git-change-open" onClick={() => onOpenDiff(revision)} aria-label={t('{{subject}}, {{path}}', { subject: revision.commit.subject, path: revision.path.path })}>
          <code>{revision.commit.oid.slice(0, 7)}</code>
          <span className="git-change-name"><RefChips refs={revision.commit.refs} />{revision.commit.subject}</span>
          <span className="git-change-dir">{revision.path.path !== path.path ? `${revision.path.path} · ` : ''}{revision.commit.author} · {formatTime(revision.commit.authoredAt)}</span>
        </button>
        <span className="git-change-actions"><button aria-label={t('Blame at {{commit}}', { commit: revision.commit.oid.slice(0, 7) })} title={t('Blame at this revision')}
          onClick={() => onBlame(revision.path, revision.commit.oid)}><ScrollText size={14} /></button></span>
      </li>)}
    </ul>
    {loading && <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Loading history…')}</p>}
    {!loading && !revisions.length && !error && <p className="git-muted git-pad">{t('This file has no committed history.')}</p>}
    {hasMore && !loading && <button className="git-load-more" onClick={() => void load(revisions.length)}>{t('Load more')}</button>}
  </div>;
}
