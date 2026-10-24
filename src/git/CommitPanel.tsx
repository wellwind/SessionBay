import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { ComparisonView } from './ComparisonView';
import type { DiffPreferences } from './DiffView';
import type { CommitDetail, DiffSource } from './types';
import { formatTime } from './types';
import { RefChips } from './RefChips';

/** Commit message, people, parents and the files it changed. */
export function CommitPanel({ projectId, repoId, repoName, commit, preferences, onPreferences, onSelectCommit, onOpen, actions }: {
  projectId: string; repoId: string; repoName: string; commit: string;
  preferences: DiffPreferences; onPreferences: (next: DiffPreferences) => void;
  onSelectCommit: (oid: string) => void; onOpen?: () => void;
  /** Owner-supplied actions such as reset or revert. */
  actions?: (detail: CommitDetail) => ReactNode;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState<DiffSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    gitApi.commitDetail(projectId, repoId, commit).then(next => {
      if (cancelled) return;
      setDetail(next);
      // Merge commits always compare against an explicitly shown parent.
      setSource({ kind: 'commit', commit: next.oid, parent: next.parents.length > 1 ? 1 : null });
    }).catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
  }, [projectId, repoId, commit]);
  if (error) return <div className="git-commit-panel"><p className="git-error" role="alert">{error}</p></div>;
  if (!detail || !source) return <div className="git-commit-panel"><p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取 commit…</p></div>;
  const [subject, ...body] = detail.message.split('\n');
  return <div className="git-commit-panel" aria-label={`commit ${detail.oid.slice(0, 7)}`}>
    <div className="git-commit-head">
      <div className="git-commit-message"><strong>{subject}</strong><RefChips refs={detail.refs} />
        {body.join('\n').trim() && <pre className="git-message">{body.join('\n').trim()}</pre>}</div>
      <dl className="git-facts">
        <dt>Commit</dt><dd><code title={detail.oid}>{detail.oid.slice(0, 12)}</code></dd>
        <dt>作者</dt><dd>{detail.author} &lt;{detail.email}&gt; · {formatTime(detail.authoredAt)}</dd>
        {(detail.committer !== detail.author || detail.committedAt !== detail.authoredAt) && <><dt>提交者</dt><dd>{detail.committer} · {formatTime(detail.committedAt)}</dd></>}
        <dt>Parent</dt><dd>{detail.parents.length ? detail.parents.map((parent, index) =>
          <button key={parent} className="git-link" onClick={() => onSelectCommit(parent)}>{index + 1}: {parent.slice(0, 7)}</button>) : '（root commit）'}</dd>
      </dl>
      <div className="git-commit-actions">{actions?.(detail)}</div>
      {onOpen && <button className="git-icon-button" aria-label="在分頁開啟此 commit" title="在分頁開啟此 commit" onClick={onOpen}><ExternalLink size={14} /></button>}
    </div>
    <ComparisonView projectId={projectId} repoId={repoId} repoName={repoName} source={source} parents={detail.parents}
      preferences={preferences} onPreferences={onPreferences} onSource={setSource} />
  </div>;
}
