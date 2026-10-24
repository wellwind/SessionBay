import { useEffect, useMemo, useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { Blame, RepoPath } from './types';
import { formatTime } from './types';

/** Line authorship; each group links to its commit and to the prior version. */
export function BlameView({ projectId, repoId, repoName, path, rev, onOpenCommit, onBlame, onHistory }: {
  projectId: string; repoId: string; repoName: string; path: RepoPath; rev: string | null;
  onOpenCommit: (oid: string) => void; onBlame: (path: RepoPath, rev: string | null) => void; onHistory: (path: RepoPath) => void;
}) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setBlame(null); setError('');
    gitApi.blame(projectId, repoId, path, rev).then(next => { if (!cancelled) setBlame(next); })
      .catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
  }, [projectId, repoId, path, rev]);
  const groups = useMemo(() => blame?.lines.map((line, index) => index === 0 || blame.lines[index - 1].oid !== line.oid) ?? [], [blame]);
  return <div className="git-blame">
    <div className="git-doc-toolbar">
      <span className="git-doc-title"><strong>Blame {path.path}</strong><span className="git-muted"> · {repoName} · {rev ? rev.slice(0, 12) : '工作目錄'}</span></span>
      {rev && <button onClick={() => onBlame(path, null)}>回到工作目錄版本</button>}
      <button onClick={() => onHistory(path)}><History size={14} aria-hidden="true" />檔案歷史</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
    {!blame && !error && <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取 blame…</p>}
    {blame?.truncated && <p className="git-notice">檔案過長，只顯示前 {blame.lines.length} 行。</p>}
    {blame && <div className="git-blame-body" role="group" aria-label={`${path.path} 的 blame`}>
      {blame.lines.map((line, index) => {
        const commit = blame.commits[line.oid];
        return <div key={index} className={`git-blame-line${groups[index] ? ' first' : ''}`}>
          <span className="git-blame-info">{groups[index] && commit && (commit.uncommitted
            ? <span className="git-muted">尚未 commit</span>
            : <>
              <button className="git-link" title={`${commit.summary}\n${commit.author} · ${formatTime(commit.authoredAt)}`} onClick={() => onOpenCommit(line.oid)}>
                <code>{line.oid.slice(0, 7)}</code> {commit.author}</button>
              <span className="git-muted">{formatTime(commit.authoredAt).split(' ')[0]}</span>
              {commit.previous && <button className="git-link" title="檢視此行先前的版本" aria-label={`在 ${commit.previous[0].slice(0, 7)} 前一版 blame`}
                onClick={() => onBlame(commit.previous![1], commit.previous![0])}>↶</button>}
            </>)}</span>
          <span className="git-line-no">{line.line}</span>
          <code className="git-line-text">{line.text}</code>
        </div>;
      })}
    </div>}
  </div>;
}
