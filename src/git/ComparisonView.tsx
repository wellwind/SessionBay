import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DiffView } from './DiffView';
import type { DiffPreferences } from './DiffView';
import type { ChangedFile, DiffSource } from './types';
import { pathKey, sourceLabel } from './types';
import { ChangeBadge, splitPath } from './GitChanges';

const letterChange = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged' } as const;

/** Read-only file list plus diff for a commit or any two endpoints. */
export function ComparisonView({ projectId, repoId, repoName, source, parents, preferences, onPreferences, onSource }: {
  projectId: string; repoId: string; repoName: string; source: DiffSource; parents?: string[];
  preferences: DiffPreferences; onPreferences: (next: DiffPreferences) => void; onSource: (source: DiffSource) => void;
}) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const key = JSON.stringify(source);
  useEffect(() => {
    let cancelled = false;
    setFiles(null); setError('');
    gitApi.changedFiles(projectId, repoId, source).then(result => {
      if (cancelled) return;
      setFiles(result.files); setTruncated(result.truncated);
      setSelected(current => current && result.files.some(file => pathKey(file.path) === current) ? current : result.files[0] ? pathKey(result.files[0].path) : null);
    }).catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
    // `key` captures the full source value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, repoId, key]);
  const file = files?.find(item => pathKey(item.path) === selected);
  return <div className="git-comparison">
    <div className="git-comparison-files">
      <p className="git-comparison-source">{sourceLabel(source)}</p>
      {source.kind === 'commit' && parents && parents.length > 1 && <label className="git-field">比較 parent
        <select value={source.parent ?? ''} onChange={event => onSource({ ...source, parent: Number(event.target.value) })}>
          {source.parent === null && <option value="">請選擇 parent</option>}
          {parents.map((parent, index) => <option key={parent} value={index + 1}>parent {index + 1} · {parent.slice(0, 7)}</option>)}
        </select></label>}
      {source.kind === 'compare' && <span className="git-segmented" role="group" aria-label="比較方式">
        <button aria-pressed={!source.mergeBase} onClick={() => onSource({ ...source, mergeBase: false })}>直接比較</button>
        <button aria-pressed={source.mergeBase} onClick={() => onSource({ ...source, mergeBase: true })}>自 merge-base</button>
      </span>}
      {error && <p className="git-error" role="alert">{error}</p>}
      {!files && !error && <p className="git-muted" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取變更檔案…</p>}
      {files && !files.length && <p className="git-muted">兩端之間沒有檔案變更。</p>}
      {truncated && <p className="git-notice">檔案過多，只列出前 {files?.length} 個。</p>}
      {files && <ul className="git-file-list" aria-label="變更檔案">{files.map(item => {
        const { name, directory } = splitPath(item.path.path);
        const active = pathKey(item.path) === selected;
        return <li key={pathKey(item.path)} className={`git-change${active ? ' selected' : ''}`}>
          <button className="git-change-open" aria-current={active || undefined} title={item.path.path}
            aria-label={`${item.path.path}${item.oldPath ? `，原路徑 ${item.oldPath.path}` : ''}`} onClick={() => setSelected(pathKey(item.path))}>
            <ChangeBadge change={letterChange[item.status as keyof typeof letterChange] ?? 'modified'} />
            <span className="git-change-name">{name}</span><span className="git-change-dir">{item.oldPath ? `${item.oldPath.path} → ` : ''}{directory}</span>
          </button></li>;
      })}</ul>}
    </div>
    <div className="git-comparison-diff">
      {file ? <DiffView key={pathKey(file.path)} projectId={projectId} repoId={repoId} repoName={repoName} path={file.path} oldPath={file.oldPath}
        source={source} untracked={false} revision={undefined} preferences={preferences} onPreferences={onPreferences} onChanged={() => undefined} />
        : <p className="git-muted git-pad">選擇左側檔案檢視差異。</p>}
    </div>
  </div>;
}
