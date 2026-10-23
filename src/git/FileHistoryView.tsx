import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, ScrollText } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { FileRevision, RepoPath } from './types';
import { formatTime } from './types';
import { RefChips } from './RefChips';

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
    <div className="git-doc-toolbar"><span className="git-doc-title"><strong>歷史 {path.path}</strong><span className="git-muted"> · {repoName}（追蹤重新命名）</span></span></div>
    {error && <p className="git-error" role="alert">{error}</p>}
    <ul className="git-revision-list" aria-label={`${path.path} 的歷史`}>
      {revisions.map(revision => <li key={revision.commit.oid} className="git-change">
        <button className="git-change-open" onClick={() => onOpenDiff(revision)} aria-label={`${revision.commit.subject}，${revision.path.path}`}>
          <code>{revision.commit.oid.slice(0, 7)}</code>
          <span className="git-change-name"><RefChips refs={revision.commit.refs} />{revision.commit.subject}</span>
          <span className="git-change-dir">{revision.path.path !== path.path ? `${revision.path.path} · ` : ''}{revision.commit.author} · {formatTime(revision.commit.authoredAt)}</span>
        </button>
        <span className="git-change-actions"><button aria-label={`在 ${revision.commit.oid.slice(0, 7)} blame`} title="在此版本 blame"
          onClick={() => onBlame(revision.path, revision.commit.oid)}><ScrollText size={14} /></button></span>
      </li>)}
    </ul>
    {loading && <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取歷史…</p>}
    {!loading && !revisions.length && !error && <p className="git-muted git-pad">此檔案沒有已提交的歷史。</p>}
    {hasMore && !loading && <button className="git-load-more" onClick={() => void load(revisions.length)}>載入更多</button>}
  </div>;
}
