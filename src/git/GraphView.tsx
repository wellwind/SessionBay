import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { emptyLanes, layout } from './graph-lanes';
import type { GraphRow, LaneState } from './graph-lanes';
import { CommitPanel } from './CommitPanel';
import type { DiffPreferences } from './DiffView';
import type { CommitDetail, LogCommit, LogFilter } from './types';
import type { ReactNode } from 'react';
import { formatTime } from './types';
import { RefChips } from './RefChips';

export const PAGE = 200;
const LANE = 14, ROW = 26;

/** One row of lane lines; colors follow lanes and the node marks the commit. */
export function GraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
  const x = (lane: number) => lane * LANE + LANE / 2;
  const mid = ROW / 2;
  return <svg className="git-graph-cell" width={width * LANE} height={ROW} aria-hidden="true">
    {row.above.map(({ lane, intoCommit }) => <line key={`a${lane}`} className={`lane-${lane % 6}`}
      x1={x(lane)} y1={0} x2={intoCommit ? x(row.column) : x(lane)} y2={mid} />)}
    {row.below.map(({ lane, continues, fromCommit }) => <g key={`b${lane}`} className={`lane-${lane % 6}`}>
      {continues && <line x1={x(lane)} y1={mid} x2={x(lane)} y2={ROW} />}
      {fromCommit && <line x1={x(row.column)} y1={mid} x2={x(lane)} y2={ROW} />}
    </g>)}
    <circle className={`lane-${row.column % 6}`} cx={x(row.column)} cy={mid} r={merge ? 4.5 : 3.5} />
  </svg>;
}

export function GraphView({ projectId, repoId, repoName, headOid, preferences, onPreferences, onOpenComparison, commitActions }: {
  projectId: string; repoId: string; repoName: string; headOid: string | null;
  preferences: DiffPreferences; onPreferences: (next: DiffPreferences) => void;
  onOpenComparison: (commit: string) => void;
  commitActions?: (detail: CommitDetail) => ReactNode;
}) {
  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [rows, setRows] = useState<GraphRow[]>([]);
  const lanes = useRef<LaneState>(emptyLanes());
  const [hasMore, setHasMore] = useState(false);
  const [filtered, setFiltered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ text: '', author: '', path: '' });
  const [filter, setFilter] = useState<LogFilter>({});
  const [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  const seen = useRef(new Set<string>());
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(async function load(reset: boolean, offset: number): Promise<void> {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const page = await gitApi.log(projectId, repoId, filter, offset, PAGE);
      if (current !== generation.current) return;
      if (!reset && page.commits.some(commit => seen.current.has(commit.oid))) {
        // History moved between pages (new commits shift offsets): start over
        // rather than show duplicates or mis-drawn lanes.
        void load(true, 0);
        return;
      }
      if (reset) seen.current = new Set();
      for (const commit of page.commits) seen.current.add(commit.oid);
      const start = reset ? emptyLanes() : lanes.current;
      const result = layout(page.commits, start);
      lanes.current = result.state;
      setCommits(previous => reset ? page.commits : [...previous, ...page.commits]);
      setRows(previous => reset ? result.rows : [...previous, ...result.rows]);
      setHasMore(page.hasMore); setFiltered(page.filtered);
      if (reset) setSelected(current => current && page.commits.some(commit => commit.oid === current) ? current : null);
    } catch (failure) {
      if (current === generation.current) setError(errorMessage(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [projectId, repoId, filter]);
  useEffect(() => { void load(true, 0); }, [load, headOid]);

  const width = useMemo(() => Math.max(1, ...rows.map(row => row.width)), [rows]);
  const index = commits.findIndex(commit => commit.oid === selected);
  const move = (next: number) => {
    const commit = commits[Math.max(0, Math.min(commits.length - 1, next))];
    if (!commit) return;
    setSelected(commit.oid);
    list.current?.querySelector<HTMLElement>(`[data-oid="${commit.oid}"]`)?.focus();
  };
  const selectedCommit = commits[index];

  return <div className="git-graph-view">
    <form className="git-doc-toolbar" onSubmit={event => {
      event.preventDefault();
      setFilter({ text: draft.text.trim() || undefined, author: draft.author.trim() || undefined, path: draft.path.trim() ? { path: draft.path.trim() } : null });
    }}>
      <span className="git-doc-title"><strong>歷史</strong><span className="git-muted"> · {repoName}</span></span>
      <label className="git-search"><Search size={13} aria-hidden="true" /><input type="search" aria-label="搜尋 commit 訊息" placeholder="訊息" value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      <label className="git-search"><input aria-label="作者篩選" placeholder="作者" value={draft.author} onChange={event => setDraft({ ...draft, author: event.target.value })} /></label>
      <label className="git-search"><input aria-label="路徑篩選" placeholder="路徑" value={draft.path} onChange={event => setDraft({ ...draft, path: event.target.value })} /></label>
      <button type="submit">篩選</button>
      {(filter.text || filter.author || filter.path) && <button type="button" onClick={() => { setDraft({ text: '', author: '', path: '' }); setFilter({}); }}>清除</button>}
      <button type="button" className="git-icon-button" aria-label="重新載入歷史" title="重新載入歷史" onClick={() => void load(true, 0)}><RefreshCw size={14} /></button>
    </form>
    {filtered && <p className="git-notice">篩選結果以清單呈現；篩選會略過部分祖先，因此不繪製分支線。</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="git-graph-split">
      <div ref={list} className="git-graph-list" role="listbox" aria-label="Commit 歷史" aria-busy={loading}
        onScroll={event => {
          const element = event.currentTarget;
          if (hasMore && !loading && element.scrollTop + element.clientHeight > element.scrollHeight - ROW * 20) void load(false, commits.length);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); move(index + 1); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); move(index - 1); }
          else if (event.key === 'Home') { event.preventDefault(); move(0); }
          else if (event.key === 'End') { event.preventDefault(); move(commits.length - 1); }
        }}>
        {commits.map((commit, position) => <div key={commit.oid} data-oid={commit.oid} role="option" aria-selected={commit.oid === selected}
          tabIndex={commit.oid === selected || (!selected && position === 0) ? 0 : -1} className={`git-graph-row${commit.oid === selected ? ' selected' : ''}`}
          onClick={() => setSelected(commit.oid)} onDoubleClick={() => onOpenComparison(commit.oid)}>
          {!filtered && rows[position] && <GraphCell row={rows[position]} width={width} merge={commit.parents.length > 1} />}
          <span className="git-graph-subject"><RefChips refs={commit.refs} />{commit.refs.some(ref => ref.kind === 'head') && <span className="git-ref head">HEAD</span>}{commit.subject}</span>
          <span className="git-graph-meta">{commit.author}</span>
          <span className="git-graph-meta">{formatTime(commit.authoredAt)}</span>
          <code className="git-graph-meta">{commit.oid.slice(0, 7)}</code>
        </div>)}
        {!loading && !commits.length && !error && <p className="git-muted git-pad">{filtered ? '沒有符合篩選的 commit。' : '此 repository 尚無 commit。'}</p>}
        {loading && <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取歷史…</p>}
        {hasMore && !loading && <button className="git-load-more" onClick={() => void load(false, commits.length)}>載入更多 commit</button>}
      </div>
      {selectedCommit && <CommitPanel key={selectedCommit.oid} projectId={projectId} repoId={repoId} repoName={repoName} commit={selectedCommit.oid}
        preferences={preferences} onPreferences={onPreferences} onSelectCommit={oid => {
          if (commits.some(commit => commit.oid === oid)) move(commits.findIndex(commit => commit.oid === oid));
          else onOpenComparison(oid);
        }} onOpen={() => onOpenComparison(selectedCommit.oid)} actions={commitActions} />}
    </div>
  </div>;
}
