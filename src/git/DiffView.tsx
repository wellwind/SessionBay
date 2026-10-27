import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { ChevronDown, ChevronUp, Columns2, LoaderCircle, Minus, Plus, Rows3, Search } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { buildRows, cellKey } from './diff-rows';
import type { Cell, Row } from './diff-rows';
import { highlight } from './diff-syntax';
import type { SyntaxMap } from './diff-syntax';
import type { Range } from './word-diff';
import type { DiffSource, FileDiff, LineRef, RepoPath } from './types';
import { sourceLabel } from './types';
import { t } from '../i18n';

export interface DiffPreferences { mode: 'inline' | 'split'; ignoreWhitespace: boolean }

export interface DiffViewProps {
  projectId: string; repoId: string; repoName: string;
  path: RepoPath; oldPath: RepoPath | null; source: DiffSource; untracked: boolean;
  /** Changes when the repository status changes, triggering a reload. */
  revision: string | undefined;
  preferences: DiffPreferences;
  onPreferences: (next: DiffPreferences) => void;
  onSource?: (source: DiffSource) => void;
  onChanged: () => void;
  /** Extra toolbar actions supplied by the owner (e.g. blame/history). */
  actions?: ReactNode;
}

type Segment = { text: string; className: string };
function segments(text: string, word: Range[] | null, syntax: [number, number, string][] | undefined, query: string): Segment[] {
  const marks = new Set<number>([0, text.length]);
  for (const [start, end] of word ?? []) { marks.add(start); marks.add(end); }
  for (const [start, end] of syntax ?? []) { marks.add(start); marks.add(end); }
  const found: Range[] = [];
  if (query) {
    const lower = text.toLowerCase(), needle = query.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0 && found.length < 200; at = lower.indexOf(needle, at + needle.length)) {
      found.push([at, at + needle.length]); marks.add(at); marks.add(at + needle.length);
    }
  }
  const points = [...marks].filter(point => point >= 0 && point <= text.length).sort((a, b) => a - b);
  const inside = (ranges: Range[] | [number, number, string][] | undefined | null, at: number) =>
    ranges?.find(range => range[0] <= at && at < range[1]);
  const result: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [start, end] = [points[i], points[i + 1]];
    if (start === end) continue;
    const classes = [
      inside(word, start) ? 'git-word' : '',
      (inside(syntax, start) as [number, number, string] | undefined)?.[2] ?? '',
      inside(found, start) ? 'git-search-hit' : '',
    ].filter(Boolean).join(' ');
    result.push({ text: text.slice(start, end), className: classes });
  }
  return result;
}

function LineText({ cell, syntax, query }: { cell: Cell; syntax: SyntaxMap | null; query: string }) {
  const parts = segments(cell.data.text, cell.ranges, syntax?.get(cellKey(cell)), query);
  return <code className="git-line-text">
    {parts.map((part, index) => part.className ? <span key={index} className={part.className}>{part.text}</span> : <Fragment key={index}>{part.text}</Fragment>)}
    {cell.data.crlf && <span className="git-eol" title={t('CRLF line ending')}>␍</span>}
    {cell.data.clipped && <span className="git-eol" title={t('This line is too long, so only its start is shown; staging still uses the full line')}>…</span>}
    {cell.data.noNewline && <span className="git-eol" title={t('No newline at end of file')}>⏎̸</span>}
  </code>;
}

export function DiffView({ projectId, repoId, repoName, path, oldPath, source, untracked, revision, preferences, onPreferences, onSource, onChanged, actions }: DiffViewProps) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syntax, setSyntax] = useState<SyntaxMap | null>(null);
  const [query, setQuery] = useState('');
  const [block, setBlock] = useState(-1);
  const anchor = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const snapshot = useRef<string | null>(null);

  const load = useCallback(async (reason?: string) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await gitApi.diff(projectId, { repoId, path, oldPath, source, ignoreWhitespace: preferences.ignoreWhitespace, untracked });
      if (current !== generation.current) return;
      if (snapshot.current !== next.snapshot) {
        // Selections refer to exact line positions of one snapshot.
        setSelected(new Set());
        anchor.current = null;
        if (reason && snapshot.current) setNotice({ tone: 'error', text: reason });
      }
      snapshot.current = next.snapshot;
      setDiff(next); setError('');
    } catch (failure) {
      if (current === generation.current) setError(errorMessage(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [projectId, repoId, path, oldPath, source, preferences.ignoreWhitespace, untracked]);

  useEffect(() => {
    const tracker = generation;
    void load();
    return () => { tracker.current++; };
  }, [load]);
  const lastRevision = useRef(revision);
  const ownChange = useRef(false);
  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    // Our own stage/unstage also changes the revision; only others are "external".
    const own = ownChange.current;
    ownChange.current = false;
    void load(own ? undefined : t('The file or index changed outside Session Bay and was reloaded; the previous selection was cleared.'));
  }, [revision, load]);
  useEffect(() => {
    let cancelled = false;
    setSyntax(null);
    if (!diff?.hunks.length) return;
    void highlight(path.path, diff.hunks).then(map => { if (!cancelled) setSyntax(map); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [diff, path.path]);

  const rows = useMemo(() => buildRows(diff?.hunks ?? [], preferences.mode), [diff, preferences.mode]);
  const blocks = useMemo(() => rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.type !== 'hunk' && row.blockStart).map(({ index }) => index), [rows]);
  const changedOrder = useMemo(() => (diff?.hunks ?? []).flatMap((hunk, h) =>
    hunk.lines.map((line, l) => ({ line, key: `${h}:${l}` })).filter(({ line }) => line.kind !== 'context').map(({ key }) => key)), [diff]);
  const stageable = source.kind === 'unstaged' || source.kind === 'staged';
  const selectable = !!diff && stageable && !diff.partialBlocked;
  const staging = source.kind === 'unstaged';

  const toggle = (cell: Cell, event: MouseEvent) => {
    const key = cellKey(cell);
    // The updater runs later; read the anchor now, before it moves.
    const from = event.shiftKey ? anchor.current : null;
    setSelected(previous => {
      const next = new Set(previous);
      if (from) {
        const [a, b] = [changedOrder.indexOf(from), changedOrder.indexOf(key)].sort((x, y) => x - y);
        const on = !previous.has(key);
        for (const item of changedOrder.slice(a, b + 1)) if (on) next.add(item); else next.delete(item);
      } else if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    anchor.current = key;
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true); setNotice(null);
    try {
      await action();
      setNotice({ tone: 'success', text: label });
      setSelected(new Set()); anchor.current = null;
    } catch (failure) {
      setNotice({ tone: 'error', text: errorMessage(failure) });
    } finally {
      setBusy(false);
      ownChange.current = true;
      onChanged();
      await load();
    }
  };
  const applySelection = (selection: { kind: 'hunks'; hunks: number[] } | { kind: 'lines'; lines: LineRef[] }, label: string) => {
    if (!diff) return;
    void run(label, () => staging
      ? gitApi.stageSelection(projectId, { repoId, path, untracked, snapshot: diff.snapshot, selection })
      : gitApi.unstageSelection(projectId, { repoId, path, snapshot: diff.snapshot, selection }));
  };
  const selectedLines = (): LineRef[] => [...selected].map(key => { const [hunk, line] = key.split(':').map(Number); return { hunk, line }; });
  const wholeFile = () => void run(staging ? t('Staged the whole file.') : t('Unstaged the whole file.'), () => staging
    ? gitApi.stagePaths(projectId, repoId, [path])
    : gitApi.unstagePaths(projectId, repoId, oldPath ? [path, oldPath] : [path]));

  const jump = (direction: 1 | -1) => {
    if (!blocks.length) return;
    const next = block < 0 ? (direction > 0 ? 0 : blocks.length - 1) : (block + direction + blocks.length) % blocks.length;
    setBlock(next);
    body.current?.querySelector<HTMLElement>(`[data-row="${blocks[next]}"]`)?.scrollIntoView({ block: 'center' });
  };

  const gutter = (cell: Cell | null) => {
    if (!cell) return <span className="git-gutter" />;
    const number = cell.data.kind === 'delete' ? cell.data.oldLine : cell.data.newLine ?? cell.data.oldLine;
    if (!selectable || cell.data.kind === 'context') return <span className="git-gutter"><span className="git-line-no">{number}</span></span>;
    const key = cellKey(cell);
    const added = cell.data.kind === 'add';
    return <span className="git-gutter">
      <button role="checkbox" aria-checked={selected.has(key)} className="git-line-select"
        aria-label={added ? t('Select added line {{line}}', { line: number ?? '' }) : t('Select deleted line {{line}}', { line: number ?? '' })} title={staging ? t('Select this line to stage (Shift to select a range)') : t('Select this line to unstage (Shift to select a range)')} onClick={event => toggle(cell, event)}>
        <span className="git-line-no">{number}</span>
      </button>
    </span>;
  };
  const sign = (cell: Cell | null) => <span className="git-sign" aria-hidden="true">{cell?.data.kind === 'add' ? '+' : cell?.data.kind === 'delete' ? '−' : ' '}</span>;
  const lineClass = (cell: Cell | null) => `git-line ${cell ? cell.data.kind : 'empty'}${cell && selected.has(cellKey(cell)) ? ' selected' : ''}`;

  const renderRow = (row: Row, index: number) => {
    if (row.type === 'hunk') return <div key={index} data-row={index} className="git-hunk-header">
      <code>{row.header}</code>
      {selectable && <button disabled={busy} onClick={() => applySelection({ kind: 'hunks', hunks: [row.hunk] }, staging ? t('Staged this hunk.') : t('Unstaged this hunk.'))}>
        {staging ? <Plus size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}{staging ? t('Stage hunk') : t('Unstage hunk')}</button>}
    </div>;
    const current = blocks[block] === index ? ' current' : '';
    if (row.type === 'inline') return <div key={index} data-row={index} className={`${lineClass(row.cell)}${current}`}>
      {gutter(row.cell)}{sign(row.cell)}<LineText cell={row.cell} syntax={syntax} query={query} />
    </div>;
    return <div key={index} data-row={index} className={`git-split-row${current}`}>
      <div className={lineClass(row.left)}>{gutter(row.left)}{sign(row.left)}{row.left && <LineText cell={row.left} syntax={syntax} query={query} />}</div>
      <div className={lineClass(row.right)}>{gutter(row.right)}{sign(row.right)}{row.right && <LineText cell={row.right} syntax={syntax} query={query} />}</div>
    </div>;
  };

  const matches = query ? rows.filter(row => row.type === 'inline' ? row.cell.data.text.toLowerCase().includes(query.toLowerCase())
    : row.type === 'split' && [row.left, row.right].some(cell => cell?.data.text.toLowerCase().includes(query.toLowerCase()))).length : 0;

  return <div className="git-diff" aria-label={t('Diff of {{path}}', { path: path.path })}>
    <div className="git-doc-toolbar">
      <span className="git-doc-title" title={`${repoName} · ${oldPath ? `${oldPath.path} → ` : ''}${path.path}`}>
        <strong>{path.path}</strong>{oldPath && <span className="git-muted">{t(' (was {{path}})', { path: oldPath.path })}</span>}
        <span className="git-muted"> · {repoName} · {sourceLabel(source)}</span>
      </span>
      {onSource && !untracked && <span className="git-segmented" role="group" aria-label={t('Comparison source')}>
        {([['unstaged', t('Unstaged')], ['staged', t('Staged')], ['workingTree', t('All uncommitted')]] as const).map(([kind, label]) =>
          <button key={kind} aria-pressed={source.kind === kind} onClick={() => onSource({ kind })}>{label}</button>)}
      </span>}
      <span className="git-segmented" role="group" aria-label={t('Layout')}>
        <button aria-pressed={preferences.mode === 'split'} title={t('Side by side')} aria-label={t('Side-by-side view')} onClick={() => onPreferences({ ...preferences, mode: 'split' })}><Columns2 size={14} /></button>
        <button aria-pressed={preferences.mode === 'inline'} title={t('Inline')} aria-label={t('Inline view')} onClick={() => onPreferences({ ...preferences, mode: 'inline' })}><Rows3 size={14} /></button>
      </span>
      <label className="git-check"><input type="checkbox" checked={preferences.ignoreWhitespace}
        onChange={event => onPreferences({ ...preferences, ignoreWhitespace: event.target.checked })} />{t('Ignore whitespace')}</label>
      <label className="git-search"><Search size={13} aria-hidden="true" />
        <input type="search" aria-label={t('Search diff')} placeholder={t('Search')} value={query} onChange={event => setQuery(event.target.value)} />
        {query && <span className="git-muted" aria-live="polite">{t('{{count}} lines', { count: matches })}</span>}
      </label>
      <button className="git-icon-button" aria-label={t('Previous change')} title={t('Previous change (Alt+↑)')} disabled={!blocks.length} onClick={() => jump(-1)}><ChevronUp size={15} /></button>
      <button className="git-icon-button" aria-label={t('Next change')} title={t('Next change (Alt+↓)')} disabled={!blocks.length} onClick={() => jump(1)}><ChevronDown size={15} /></button>
      {actions}
    </div>
    {stageable && diff && <div className="git-stage-bar">
      {selectable ? <>
        <button className="primary" disabled={busy || !selected.size} onClick={() => applySelection({ kind: 'lines', lines: selectedLines() }, staging ? t('Staged {{count}} selected lines.', { count: selected.size }) : t('Unstaged {{count}} selected lines.', { count: selected.size }))}>
          {staging ? (selected.size ? t('Stage {{count}} selected lines', { count: selected.size }) : t('Stage selected lines')) : (selected.size ? t('Unstage {{count}} selected lines', { count: selected.size }) : t('Unstage selected lines'))}</button>
        {selected.size > 0 && <button disabled={busy} onClick={() => { setSelected(new Set()); anchor.current = null; }}>{t('Clear selection')}</button>}
      </> : diff.partialBlocked && <span className="git-muted">{diff.partialBlocked}</span>}
      <button disabled={busy} onClick={wholeFile}>{staging ? t('Stage whole file') : t('Unstage whole file')}</button>
      {busy && <LoaderCircle className="spin" size={14} aria-label={t('Working…')} />}
    </div>}
    {notice && <p className={notice.tone === 'success' ? 'git-success' : 'git-error'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div ref={body} className={`git-diff-body ${preferences.mode}`} tabIndex={0} aria-busy={loading}
      onKeyDown={event => {
        if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); jump(event.key === 'ArrowDown' ? 1 : -1); }
      }}>
      {loading && !diff && <p className="git-muted" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Loading diff…')}</p>}
      {diff && <>
        {(diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode) && <p className="git-meta-line">{t('File mode {{from}} → {{to}}', { from: diff.oldMode, to: diff.newMode })}</p>}
        {diff.newFile && <p className="git-meta-line">{t('New file')}{diff.newMode ? t(' ({{mode}})', { mode: diff.newMode }) : ''}</p>}
        {diff.deletedFile && <p className="git-meta-line">{t('Deleted file')}</p>}
        {diff.binary && <p className="git-meta-line">{t('A non-text file changed; Session Bay does not show diffs of non-text content.')}</p>}
        {diff.submodule && <p className="git-meta-line">{t('Submodule pointer changed.')}</p>}
        {diff.tooLarge && <p className="git-notice" role="status">{t('The diff exceeds the viewing limit, so its content was not loaded.')}</p>}
        {diff.truncated && <p className="git-notice" role="status">{t('The diff is too long, so only the start is shown; some line actions are disabled.')}</p>}
        {diff.unsupportedEncoding && <p className="git-notice" role="status">{t('The file has non-UTF-8 content, shown with replacement characters.')}</p>}
        {!diff.hunks.length && !diff.binary && !diff.tooLarge && !diff.submodule && !(diff.oldMode !== diff.newMode) && !diff.newFile && !diff.deletedFile &&
          <p className="git-muted" role="status">{t('No text changes for this comparison.')}</p>}
        <div className="git-diff-rows" role="group" aria-label={t('Diff content')}>{rows.map(renderRow)}</div>
      </>}
    </div>
  </div>;
}
