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
    {cell.data.crlf && <span className="git-eol" title="CRLF 行尾">␍</span>}
    {cell.data.clipped && <span className="git-eol" title="此行過長，只顯示前段；暫存仍使用完整內容">…</span>}
    {cell.data.noNewline && <span className="git-eol" title="檔案結尾沒有換行">⏎̸</span>}
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
    void load(own ? undefined : '檔案或 index 已在外部變更，已重新載入；先前的選取已清除。');
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
  const wholeFile = () => void run(staging ? '已暫存整個檔案。' : '已取消暫存整個檔案。', () => staging
    ? gitApi.stagePaths(projectId, repoId, [path])
    : gitApi.unstagePaths(projectId, repoId, oldPath ? [path, oldPath] : [path]));

  const jump = (direction: 1 | -1) => {
    if (!blocks.length) return;
    const next = block < 0 ? (direction > 0 ? 0 : blocks.length - 1) : (block + direction + blocks.length) % blocks.length;
    setBlock(next);
    body.current?.querySelector<HTMLElement>(`[data-row="${blocks[next]}"]`)?.scrollIntoView({ block: 'center' });
  };
  const verb = staging ? '暫存' : '取消暫存';

  const gutter = (cell: Cell | null) => {
    if (!cell) return <span className="git-gutter" />;
    const number = cell.data.kind === 'delete' ? cell.data.oldLine : cell.data.newLine ?? cell.data.oldLine;
    if (!selectable || cell.data.kind === 'context') return <span className="git-gutter"><span className="git-line-no">{number}</span></span>;
    const key = cellKey(cell);
    const kindText = cell.data.kind === 'add' ? '新增' : '刪除';
    return <span className="git-gutter">
      <button role="checkbox" aria-checked={selected.has(key)} className="git-line-select"
        aria-label={`選取${kindText}第 ${number} 行`} title={`選取此行以${verb}（Shift 連選）`} onClick={event => toggle(cell, event)}>
        <span className="git-line-no">{number}</span>
      </button>
    </span>;
  };
  const sign = (cell: Cell | null) => <span className="git-sign" aria-hidden="true">{cell?.data.kind === 'add' ? '+' : cell?.data.kind === 'delete' ? '−' : ' '}</span>;
  const lineClass = (cell: Cell | null) => `git-line ${cell ? cell.data.kind : 'empty'}${cell && selected.has(cellKey(cell)) ? ' selected' : ''}`;

  const renderRow = (row: Row, index: number) => {
    if (row.type === 'hunk') return <div key={index} data-row={index} className="git-hunk-header">
      <code>{row.header}</code>
      {selectable && <button disabled={busy} onClick={() => applySelection({ kind: 'hunks', hunks: [row.hunk] }, `已${verb}此區塊。`)}>
        {staging ? <Plus size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}{verb}此區塊</button>}
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

  return <div className="git-diff" aria-label={`${path.path} 的差異`}>
    <div className="git-doc-toolbar">
      <span className="git-doc-title" title={`${repoName} · ${oldPath ? `${oldPath.path} → ` : ''}${path.path}`}>
        <strong>{path.path}</strong>{oldPath && <span className="git-muted">（原 {oldPath.path}）</span>}
        <span className="git-muted"> · {repoName} · {sourceLabel(source)}</span>
      </span>
      {onSource && !untracked && <span className="git-segmented" role="group" aria-label="比較來源">
        {([['unstaged', '未暫存'], ['staged', '已暫存'], ['workingTree', '全部未提交']] as const).map(([kind, label]) =>
          <button key={kind} aria-pressed={source.kind === kind} onClick={() => onSource({ kind })}>{label}</button>)}
      </span>}
      <span className="git-segmented" role="group" aria-label="顯示方式">
        <button aria-pressed={preferences.mode === 'split'} title="並排" aria-label="並排檢視" onClick={() => onPreferences({ ...preferences, mode: 'split' })}><Columns2 size={14} /></button>
        <button aria-pressed={preferences.mode === 'inline'} title="行內" aria-label="行內檢視" onClick={() => onPreferences({ ...preferences, mode: 'inline' })}><Rows3 size={14} /></button>
      </span>
      <label className="git-check"><input type="checkbox" checked={preferences.ignoreWhitespace}
        onChange={event => onPreferences({ ...preferences, ignoreWhitespace: event.target.checked })} />忽略空白</label>
      <label className="git-search"><Search size={13} aria-hidden="true" />
        <input type="search" aria-label="搜尋 diff" placeholder="搜尋" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <span className="git-muted" aria-live="polite">{matches} 行</span>}
      </label>
      <button className="git-icon-button" aria-label="上一個變更" title="上一個變更 (Alt+↑)" disabled={!blocks.length} onClick={() => jump(-1)}><ChevronUp size={15} /></button>
      <button className="git-icon-button" aria-label="下一個變更" title="下一個變更 (Alt+↓)" disabled={!blocks.length} onClick={() => jump(1)}><ChevronDown size={15} /></button>
      {actions}
    </div>
    {stageable && diff && <div className="git-stage-bar">
      {selectable ? <>
        <button className="primary" disabled={busy || !selected.size} onClick={() => applySelection({ kind: 'lines', lines: selectedLines() }, `已${verb}所選 ${selected.size} 行。`)}>
          {verb}所選{selected.size ? ` ${selected.size} 行` : '行'}</button>
        {selected.size > 0 && <button disabled={busy} onClick={() => { setSelected(new Set()); anchor.current = null; }}>清除選取</button>}
      </> : diff.partialBlocked && <span className="git-muted">{diff.partialBlocked}</span>}
      <button disabled={busy} onClick={wholeFile}>{verb}整個檔案</button>
      {busy && <LoaderCircle className="spin" size={14} aria-label="處理中" />}
    </div>}
    {notice && <p className={notice.tone === 'success' ? 'git-success' : 'git-error'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div ref={body} className={`git-diff-body ${preferences.mode}`} tabIndex={0} aria-busy={loading}
      onKeyDown={event => {
        if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); jump(event.key === 'ArrowDown' ? 1 : -1); }
      }}>
      {loading && !diff && <p className="git-muted" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取差異…</p>}
      {diff && <>
        {(diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode) && <p className="git-meta-line">檔案模式 {diff.oldMode} → {diff.newMode}</p>}
        {diff.newFile && <p className="git-meta-line">新增檔案{diff.newMode ? `（${diff.newMode}）` : ''}</p>}
        {diff.deletedFile && <p className="git-meta-line">刪除檔案</p>}
        {diff.binary && <p className="git-meta-line">非文字檔案已變更；Session Bay 不顯示非文字內容差異。</p>}
        {diff.submodule && <p className="git-meta-line">子模組指標變更。</p>}
        {diff.tooLarge && <p className="git-notice" role="status">差異超過檢視上限，沒有載入內容。</p>}
        {diff.truncated && <p className="git-notice" role="status">差異過長，只顯示前段；部分行操作已停用。</p>}
        {diff.unsupportedEncoding && <p className="git-notice" role="status">檔案含非 UTF-8 內容，以替代字元顯示。</p>}
        {!diff.hunks.length && !diff.binary && !diff.tooLarge && !diff.submodule && !(diff.oldMode !== diff.newMode) && !diff.newFile && !diff.deletedFile &&
          <p className="git-muted" role="status">此比較來源沒有文字變更。</p>}
        <div className="git-diff-rows" role="group" aria-label="差異內容">{rows.map(renderRow)}</div>
      </>}
    </div>
  </div>;
}
