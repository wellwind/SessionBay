import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  Clock3,
  FileText,
  FolderPlus,
  Filter,
  History as HistoryIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
  Trash2,
} from 'lucide-react';
import { api, errorMessage } from '../api';
import { agentNames, historyAgentKinds } from '../agents';
import { Dialog } from './Dialog';
import { hasBlockingDialog } from '../dialog-focus';
import { AgentIcon } from './AgentIcon';
import { DatePicker, Select } from './controls';
import { localDayBound } from '../workspace';
import type { AgentKind, Project, Session, TranscriptPage } from '../types';
import { useSessionFeed } from '../use-session-feed';
import { VirtualSessionList } from './VirtualSessionList';
export const agentName = (kind: AgentKind) => agentNames[kind];
function mergeWarnings(previous: string | null | undefined, next: string | null): string | null {
  if (!previous) return next;
  if (!next || previous.includes(next)) return previous;
  if (next.includes(previous)) return next;
  return `${previous}\n${next}`;
}
export function dateLabel(value: string | null): string {
  if (!value) return '尚無活動';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-TW', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : '時間未知';
}
interface Filters {
  oldestFirst: boolean;
  query: string;
  kind: '' | AgentKind;
  archived: 'active' | 'all' | 'archived';
  after: string;
  before: string;
  children: boolean;
}
const initialFilters: Filters = {
  oldestFirst: false,
  query: '',
  kind: '',
  archived: 'active',
  after: '',
  before: '',
  children: false,
};
export function HistoryView({
  projectId,
  projects,
  refreshToken,
  onResume,
  onNew,
  onCurate,
  onHistoryChanged,
  curating = false,
  disabled = false,
  sidebarHost,
  scopeLabel,
  onSelectSession,
  openRequest,
}: {
  openRequest?: { session: Session; nonce: number };
  sidebarHost?: HTMLDivElement | null;
  scopeLabel?: string;
  onSelectSession?: () => void;
  projectId?: string;
  projects: Project[];
  refreshToken: number;
  onResume: (session: Session) => void;
  onNew: () => void;
  onCurate?: (session: Session) => void;
  onHistoryChanged?: () => Promise<void> | void;
  curating?: boolean;
  disabled?: boolean;
}) {
  const [trashTarget, setTrashTarget] = useState<Session | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const trashLock = useRef(false);
  const [trashError, setTrashError] = useState('');
  const trashTrigger = useRef<HTMLButtonElement | null>(null);
  const focusUndo = useRef<{ trigger: HTMLButtonElement | null } | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const [undoQueue, setUndoQueue] = useState<{ id: string; title: string }[]>([]);
  const undoId = undoQueue[0]?.id;
  const dismissUndo = () => { if (!hasBlockingDialog()) setUndoQueue(queue => queue.slice(1)); };
  // A completed deletion may still be awaiting a parent refresh. Any newer
  // interaction owns focus; a delayed completion must never reclaim it.
  useEffect(() => {
    const cancel = () => { focusUndo.current = null; };
    const focus = (event: FocusEvent) => {
      const pending = focusUndo.current;
      // Dialog cleanup may restore its original trigger. That is not new intent.
      if (pending && event.target !== pending.trigger) cancel();
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      document.removeEventListener('focusin', focus);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      cancel();
    };
  }, []);
  useEffect(() => {
    const pending = focusUndo.current;
    if (pending && undoId && !trashBusy) {
      focusUndo.current = null;
      const active = document.activeElement;
      if (!hasBlockingDialog() && (active === document.body || active === pending.trigger)) {
        undoButton.current?.focus();
      }
    }
  }, [undoId, trashBusy]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [saved, setSaved] = useState<Record<string, Filters>>({});
  const scrollPositions = useRef(new Map<string, { top: number }>());
  const key = projectId ?? '__all';
  const filters = saved[key] ?? initialFilters;
  const change = useCallback((patch: Partial<Filters>) =>
    setSaved((previous) => {
      const next = { ...(previous[key] ?? initialFilters), ...patch };
      scrollPositions.current.set(JSON.stringify([key, next]), { top: 0 });
      return { ...previous, [key]: next };
    }), [key]);
  const feedKey = JSON.stringify([key, filters]);
  if (!scrollPositions.current.has(feedKey)) scrollPositions.current.set(feedKey, { top: 0 });
  if (scrollPositions.current.size > 8) scrollPositions.current.delete(scrollPositions.current.keys().next().value!);
  const scrollMemory = scrollPositions.current.get(feedKey)!;
  const page = useSessionFeed<Session>(feedKey, JSON.stringify([refreshToken, historyRevision]),
    (offset, limit) => api.sessions({ projectId, kind: filters.kind || undefined,
      query: filters.query.trim() || undefined,
      archived: filters.archived === 'all' ? undefined : filters.archived === 'archived',
      includeChildren: filters.children, after: localDayBound(filters.after),
      before: localDayBound(filters.before, true), offset, limit,
      ...(filters.oldestFirst ? { oldestFirst: true } : {}) }), disabled, filters.query ? 220 : 0);
  const { loading, error } = page;
  const [selections, setSelections] = useState<Record<string, Session | null>>({});
  const selection = selections[key] ?? null;
  const setSelected = (value: Session | null | ((previous: Session | null) => Session | null)) =>
    setSelections(previous => ({ ...previous, [key]: typeof value === 'function' ? value(previous[key] ?? null) : value }));
  const selected = page.items.find(item => item.id === selection?.id) ?? (openRequest && openRequest.session.projectId === projectId && selection?.id === openRequest.session.id ? selection : page.items[0]) ?? null;
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const previewOpen = previews[key] ?? true;
  const setPreviewOpen = (open: boolean) => setPreviews(previous => ({ ...previous, [key]: open }));
  const consumedOpenRequest = useRef<typeof openRequest>(undefined);
  useEffect(() => {
    if (!openRequest || consumedOpenRequest.current === openRequest || openRequest.session.projectId !== projectId) return;
    consumedOpenRequest.current = openRequest;
    setSelections(previous => ({ ...previous, [key]: openRequest.session }));
    setPreviews(previous => ({ ...previous, [key]: true }));
  }, [openRequest, projectId, key]);
  const [moreFilters, setMoreFilters] = useState(false);
  const [dateReset, setDateReset] = useState(0);
  const selectedSessionId = selected?.id;
  const [transcript, setTranscript] = useState<TranscriptPage | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewGeneration = useRef(0);
  const latestPage = useRef<{ sessionId: string; refresh: number; signature: string } | null>(null);
  const transcriptScroll = useRef<HTMLDivElement>(null);
  const resumeReasonId = useId();
  useEffect(() => {
    const generation = ++previewGeneration.current;
    setPreviewError('');
    if (!selectedSessionId || disabled) {
      latestPage.current = null;
      setTranscript(null);
      setPreviewLoading(false);
      return;
    }
    const previous = latestPage.current;
    const background = previous?.sessionId === selectedSessionId && previous.refresh === previewRefresh;
    // Reindex can complete without changing this conversation. Keep loaded older
    // pages in place until a verified whole-transcript snapshot says otherwise.
    if (!background) setTranscript(null);
    setPreviewLoading(true);
    void api
      .transcript(selectedSessionId)
      .then((result) => {
        if (generation === previewGeneration.current) {
          const signature = JSON.stringify(result);
          const unchanged = background && !!result.snapshotId && previous.signature === signature;
          latestPage.current = { sessionId: selectedSessionId, refresh: previewRefresh, signature };
          if (!unchanged) {
            setTranscript(result);
            requestAnimationFrame(() => {
              if (generation === previewGeneration.current && transcriptScroll.current)
                transcriptScroll.current.scrollTop = transcriptScroll.current.scrollHeight;
            });
          }
        }
      })
      .catch((reason) => {
        if (generation === previewGeneration.current) setPreviewError(errorMessage(reason));
      })
      .finally(() => {
        if (generation === previewGeneration.current) setPreviewLoading(false);
      });
    return () => {
      if (previewGeneration.current === generation) previewGeneration.current = generation + 1;
    };
  }, [selectedSessionId, previewRefresh, refreshToken, disabled]);
  const earlier = async () => {
    if (!selected || !transcript?.hasMore || transcript.beforeLine === null || previewLoading)
      return;
    const generation = previewGeneration.current;
    const previousHeight = transcriptScroll.current?.scrollHeight ?? 0;
    setPreviewLoading(true);
    try {
      const result = await api.transcript(selected.id, transcript.beforeLine);
      if (generation === previewGeneration.current) {
        if (transcript.snapshotId && result.snapshotId && transcript.snapshotId !== result.snapshotId) {
          // A reindex may finish between page requests. Never join two snapshots.
          setPreviewRefresh((value) => value + 1);
          return;
        }
        // A failed verification can contaminate the merged paging state. Even
        // if the source recovers to the same snapshot, the next refresh must
        // replace that state rather than preserve its stale warning/cursor.
        if (result.stale || !result.snapshotId) latestPage.current = null;
        setTranscript((current) => ({
          ...result,
          stale: result.stale || !!current?.stale,
          warning: mergeWarnings(current?.warning, result.warning),
          messages: [...result.messages, ...(current?.messages ?? [])],
        }));
        requestAnimationFrame(() => {
          if (generation === previewGeneration.current && transcriptScroll.current)
            transcriptScroll.current.scrollTop +=
              transcriptScroll.current.scrollHeight - previousHeight;
        });
      }
    } catch (reason) {
      if (generation === previewGeneration.current) setPreviewError(errorMessage(reason));
    } finally {
      if (generation === previewGeneration.current) setPreviewLoading(false);
    }
  };
  const moveToTrash = async () => {
    if (!trashTarget?.trashIdentity || trashLock.current) return;
    trashLock.current = true;
    setTrashBusy(true);
    setTrashError('');
    try {
      const id = await api.trashSession(trashTarget.id, trashTarget.trashIdentity);
      focusUndo.current = { trigger: trashTrigger.current };
      setUndoQueue(queue => [...queue, { id, title: trashTarget.title || trashTarget.externalId }]);
      setTrashTarget(null);
      setSelected(previous => previous?.id === trashTarget.id ? null : previous);
      setHistoryRevision((value) => value + 1);
      await onHistoryChanged?.();
    } catch (reason) {
      setTrashError(errorMessage(reason));
      setHistoryRevision((value) => value + 1);
    }
    finally { trashLock.current = false; setTrashBusy(false); }
  };
  const undoTrash = async () => {
    if (!undoId || trashLock.current || hasBlockingDialog()) return;
    trashLock.current = true;
    setTrashBusy(true);
    setTrashError('');
    try {
      await api.restoreSession(undoId);
      setUndoQueue(queue => queue.filter(item => item.id !== undoId));
      setHistoryRevision((value) => value + 1);
      await onHistoryChanged?.();
    } catch (reason) { setTrashError(errorMessage(reason)); }
    finally { trashLock.current = false; setTrashBusy(false); }
  };
  const filtered =
    filters.oldestFirst ||
    !!filters.query ||
    !!filters.kind ||
    filters.archived !== 'active' ||
    !!filters.after ||
    !!filters.before ||
    filters.children;
  const selectedProject = projects.find((project) => project.id === selected?.projectId);
  const controls = <>
      {(undoId || (trashError && !trashTarget)) && createPortal(<div className="toast history-undo" aria-label="歷史刪除通知" inert={!!trashTarget}>
        <div className="history-undo-message" role="status" aria-live="polite" aria-atomic="true">
          {undoId && <><p>已移入資源回收筒：{undoQueue[0].title}</p>
            {undoQueue.length > 1 && <small>還有 {undoQueue.length - 1} 筆可依序復原。</small>}</>}
          {trashError && !trashTarget && <p role="alert">{trashError}</p>}
        </div>
        <div className="history-undo-actions">
          {undoId && <button ref={undoButton} disabled={trashBusy} onClick={() => void undoTrash()}>復原刪除</button>}
          <button className="icon-button" aria-label="關閉復原提示" disabled={trashBusy} onClick={() => { if (!hasBlockingDialog()) { dismissUndo(); setTrashError(''); } }}><X size={15} /></button>
        </div>
      </div>, document.body)}
      {trashTarget && <Dialog title="移入資源回收筒？" onClose={() => { if (!trashLock.current) setTrashTarget(null); }}>
        <p>「{trashTarget.title || trashTarget.externalId}」將從 Session Bay 歷史與搜尋隱藏，之後可從資源回收筒還原。</p>
        <p>原始 Agent 歷史會保留，執行中的工作會繼續。</p>
        {trashError && <p className="inline-error" role="alert">{trashError}</p>}
        <div className="dialog-actions">
          <button disabled={trashBusy} onClick={() => setTrashTarget(null)}>取消</button>
          <button data-dialog-confirm className="primary" disabled={trashBusy} onClick={() => void moveToTrash()}>確認移入資源回收筒</button>
        </div>
      </Dialog>}
      <div className="history-controls">
        <div className="search-field">
          <Search size={17} />
          <input
            id="session-search"
            placeholder="搜尋對話、程式碼或想法…"
            aria-label="搜尋 Session"
            value={filters.query}
            onChange={(event) => change({ query: event.target.value })}
          />
          {filters.query && (
            <button aria-label="清除搜尋" onClick={() => change({ query: '' })}>
              <X size={14} />
            </button>
          )}
        </div>
        <Select aria-label="篩選 Agent" className="history-agent-filter" value={filters.kind}
          onChange={(kind) => change({ kind: kind as '' | AgentKind })}
          options={[{ value: '', label: '所有 Agent' }, ...historyAgentKinds.map((kind) => ({
            value: kind, label: agentNames[kind], icon: <AgentIcon kind={kind} />,
          }))]} />
        <button
          className={`secondary ${moreFilters ? 'selected' : ''}`}
          onClick={() => setMoreFilters(!moreFilters)}
        >
          <Filter size={15} />
          篩選{filtered && <span className="tiny-dot" />}
        </button>
        <button
          className="icon-button"
          title={previewOpen ? '收合預覽' : '顯示預覽'}
          aria-label={previewOpen ? '收合預覽' : '顯示預覽'}
          onClick={() => { setPreviewOpen(!previewOpen); if (!previewOpen) onSelectSession?.(); }}
        >
          <FileText size={17} />
        </button>
      </div>
      {moreFilters && (
        <div className="filter-bar">
          <Select aria-label="Session 排序" value={filters.oldestFirst ? 'oldest' : 'latest'}
            onChange={value => change({ oldestFirst: value === 'oldest' })}
            options={[{ value: 'latest', label: '最新活動優先' }, { value: 'oldest', label: '最早活動優先' }]} />
          <label>
            從
            <DatePicker key={`${key}-after`} resetKey={dateReset} aria-label="開始日期" value={filters.after}
              onChange={(after) => change({ after })} />
          </label>
          <label>
            至
            <DatePicker key={`${key}-before`} resetKey={dateReset} aria-label="結束日期" value={filters.before}
              onChange={(before) => change({ before })} />
          </label>
          <Select aria-label="封存狀態" className="history-archive-filter" value={filters.archived}
            onChange={(archived) => change({ archived: archived as Filters['archived'] })}
            options={[{ value: 'active', label: '未封存' }, { value: 'all', label: '包含封存' },
              { value: 'archived', label: '僅封存' }]} />
          <label className="checkbox-label">
            <input
              type="checkbox" className="checkbox"
              checked={filters.children}
              onChange={(event) => change({ children: event.target.checked })}
            />
            包含子代理與分支
          </label>
          {filtered && <button onClick={() => { change(initialFilters); setDateReset((value) => value + 1); }}>重設篩選</button>}
        </div>
      )}
      <div className="history-caption">
        <span>{loading ? '搜尋中…' : `${page.total} 個 Session`}</span>
      </div>
    </>;
  const sessionList = <div className="session-column">
          {error && !page.items.length ? (
            <div className="empty-state">
              <FileText size={32} />
              <h3>暫時無法讀取歷史</h3>
              <p role="alert">{error}</p>
              <button onClick={page.retry}>重試載入</button>
            </div>
          ) : loading && !page.items.length ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={28} />
              <p>正在讀取本機索引…</p>
            </div>
          ) : !page.items.length ? (
            <div className="empty-state">
              <div className="empty-icon">
                <HistoryIcon size={30} />
              </div>
              <h3>{filtered ? '沒有符合條件的對話' : '把工作接續起來'}</h3>
              <p>
                {filtered
                  ? '試試較短關鍵字、放寬日期或顯示封存對話。'
                  : `這裡會整理 ${historyAgentKinds.map((kind) => agentNames[kind]).join('、')} 的本機歷史。你也可以直接開始新的工作。`}
              </p>
              {filtered ? (
                <button className="secondary" onClick={() => change(initialFilters)}>
                  清除篩選
                </button>
              ) : (
                <button className="primary" disabled={disabled} onClick={onNew}>
                  開始新工作
                  <ArrowRight size={15} />
                </button>
              )}
            </div>
          ) : (
            <VirtualSessionList key={feedKey} items={page.items} total={page.total} label="Session 清單"
              className="session-list" rowHeight={176} scrollMemory={scrollMemory}
              loading={loading} done={page.done} error={error} loadMore={page.loadMore} retry={page.retry}
              renderRow={(session) => (
                <div
                  className={`session-card ${selected?.id === session.id ? 'active' : ''}`}>
                  <button className="session-card-select" aria-current={selected?.id === session.id ? 'true' : undefined}
                    onClick={() => {
                      setSelected(session);
                      setPreviewOpen(true);
                      onSelectSession?.();
                    }}
                  >
                    <div className="session-card-top">
                      <span className={`agent-badge ${session.kind}`}>{agentName(session.kind)}</span>
                      <span className="session-time">{dateLabel(session.updatedAt)}</span>
                    </div>
                    <h3>{session.title || session.externalId.slice(0, 12)}</h3>
                    <p className="session-snippet">
                      {session.snippet || '開啟預覽，查看最近的對話脈絡。'}
                    </p>
                    <div className="session-card-meta">
                      <span title={session.cwd ?? ''}>
                        {session.cwd || projects.find((p) => p.id === session.projectId)?.launchPath || '工作目錄未知'}
                      </span>
                      <span>
                        {session.archived && '封存 '}
                        {session.partial && '解析不完整 '}
                        {session.parentId && '子代理／分支 '}
                        {session.timeSource === 'mtime' && '檔案時間'}
                      </span>
                    </div>
                  </button>
                  <button className="icon-button session-card-delete" aria-label={`刪除 Session ${session.title || session.externalId}`}
                    title="移入資源回收筒" disabled={disabled || trashBusy || !session.trashIdentity}
                    onClick={event => { trashTrigger.current = event.currentTarget; event.currentTarget.focus(); setTrashError(''); setTrashTarget(session); }}>
                    <Trash2 size={16} />
                  </button>
                </div>
              )} />
          )}

        </div>;
  const preview = previewOpen && (
          <section className="transcript-column" aria-label="對話預覽">
            {selected ? (
              <>
                <header className="transcript-header">
                  <div className="transcript-heading">
                    <span className="eyebrow">對話預覽</span>
                    <h3>{selected.title || selected.externalId}</h3>
                  </div>
                  <div className="transcript-actions">
                    <button className="icon-button" aria-label="刪除 Session" title="移入資源回收筒，可還原"
                      disabled={disabled || trashBusy || !selected.trashIdentity} onClick={event => { trashTrigger.current = event.currentTarget; event.currentTarget.focus(); setTrashError(''); setTrashTarget(selected); }}><Trash2 size={17} /></button>
                    <button
                      className="primary"
                      disabled={disabled || !!selected.resumeDisabledReason}
                      aria-describedby={selected.resumeDisabledReason ? resumeReasonId : undefined}
                      onClick={() => { if (!selected.resumeDisabledReason) onResume(selected); }}
                    >
                      接續工作
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </header>
                {selected.resumeDisabledReason && (
                  <div className="inline-warning" id={resumeReasonId} role="status">
                    {selected.resumeDisabledReason}
                  </div>
                )}
                <div className="transcript-meta">
                  <span className={`agent-badge ${selected.kind}`}>{agentName(selected.kind)}</span>
                  <span>
                    <Clock3 size={12} />
                    {selected.timeSource === 'mtime' ? '檔案修改時間' : '對話活動'} ·{' '}
                    {dateLabel(selected.updatedAt)}
                  </span>
                </div>
                <div className="transcript-source">
                  來源 {selected.sourceId} · Session {selected.externalId}
                  <br />
                  {selected.cwd || '未記錄工作目錄'}
                  {selectedProject?.launchPath && (
                    <>
                      <br />
                      接續目錄（已重新定位）：{selectedProject.launchPath}
                    </>
                  )}
                  {selected.parentId && (
                    <>
                      <br />
                      分支來源 {selected.parentId}
                    </>
                  )}
                </div>
                {onCurate && selectedProject && (
                  <div className="history-project-action">
                    {selectedProject.curated ? <span>已加入專案：{selectedProject.name}</span> :
                      <button className="secondary" disabled={disabled || curating} onClick={() => onCurate(selected)}>
                        <FolderPlus size={14} />{selectedProject.path || selectedProject.launchPath ? '將此目錄加入專案' : '選擇目錄並加入專案'}
                      </button>}
                  </div>
                )}
                {(transcript?.stale || transcript?.warning || selected.partial) && (
                  <div className="inline-warning">
                    <div>
                      {transcript?.stale && <div>來源已變更，索引可能尚未更新。</div>}
                      {transcript?.warning && <div>{transcript.warning}</div>}
                      {selected.partial && !transcript?.warning && <div>部分事件無法解析，可讀內容仍會顯示。</div>}
                    </div>
                    {transcript?.stale && (
                      <button onClick={() => setPreviewRefresh((value) => value + 1)}>
                        <RefreshCw size={13} />
                        重新讀取
                      </button>
                    )}
                  </div>
                )}
                <div className="transcript-scroll" ref={transcriptScroll}>
                  {transcript?.hasMore && (
                    <button
                      className="load-earlier"
                      disabled={previewLoading}
                      onClick={() => void earlier()}
                    >
                      {previewLoading ? '讀取中…' : '載入更早的對話'}
                    </button>
                  )}
                  {previewError && (
                    <div className="inline-warning" role="alert">
                      {previewError}
                      <button onClick={() => setPreviewRefresh((value) => value + 1)}>重試</button>
                    </div>
                  )}
                  {previewLoading && !transcript && (
                    <div className="empty-state">
                      <LoaderCircle className="spin" size={22} />
                      <p>讀取對話…</p>
                    </div>
                  )}
                  {transcript?.messages.map((message, index) => (
                    <article
                      className={`transcript-message role-${message.role === 'user' ? 'user' : 'assistant'}`}
                      key={`${message.line}-${index}`}
                    >
                      <div className="message-heading">
                        <span className={`message-avatar ${message.role === 'user' ? 'user' : ''}`}>
                          {message.role === 'user'
                            ? '你'
                            : message.role === 'assistant'
                              ? 'AI'
                              : '·'}
                        </span>
                        <strong>
                          {message.role === 'user'
                            ? '使用者'
                            : message.role === 'assistant'
                              ? agentName(selected.kind)
                              : message.role === 'tool'
                                ? '工具'
                                : message.role}
                        </strong>
                        {message.timestamp && <time>{dateLabel(message.timestamp)}</time>}
                      </div>
                      <div className="message-text">{message.text}</div>
                    </article>
                  ))}
                  {transcript && !transcript.messages.length && (
                    <div className="empty-state">
                      <FileText size={24} />
                      <p>目前沒有可預覽的文字內容。附件或不支援的事件可能不包含文字。</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <FileText size={30} />
                <h3>留住工作的脈絡</h3>
                <p>選取 Session，從最近的對話繼續。</p>
              </div>
            )}
          </section>
        );
  if (sidebarHost !== undefined) return <>
    {sidebarHost && createPortal(<div className="history-view activity-history-browser"><div className="activity-history-controls">{scopeLabel && <h2 className="activity-history-heading">{scopeLabel}</h2>}{controls}</div>{sessionList}</div>, sidebarHost)}
    <div className="history-view activity-history-preview">{preview}</div>
  </>;
  return <div className="history-view history-standalone">
    {controls}
    <div className={`history-columns ${previewOpen ? '' : 'preview-hidden'}`}>
      {sessionList}{preview}
    </div>
  </div>;
}
