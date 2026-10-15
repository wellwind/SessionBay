import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  FolderPlus,
  Filter,
  History as HistoryIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../api';
import { agentNames, historyAgentKinds } from '../agents';
import { AgentIcon } from './AgentIcon';
import { DatePicker, Select } from './controls';
import { localDayBound } from '../workspace';
import type { AgentKind, Project, Session, SessionPage, TranscriptPage } from '../types';
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
  query: string;
  kind: '' | AgentKind;
  archived: 'active' | 'all' | 'archived';
  after: string;
  before: string;
  children: boolean;
  offset: number;
}
const initialFilters: Filters = {
  query: '',
  kind: '',
  archived: 'active',
  after: '',
  before: '',
  children: false,
  offset: 0,
};
export function HistoryView({
  projectId,
  projects,
  refreshToken,
  onResume,
  onNew,
  onCurate,
  curating = false,
  disabled = false,
}: {
  projectId?: string;
  projects: Project[];
  refreshToken: number;
  onResume: (session: Session) => void;
  onNew: () => void;
  onCurate?: (session: Session) => void;
  curating?: boolean;
  disabled?: boolean;
}) {
  const [saved, setSaved] = useState<Record<string, Filters>>({});
  const key = projectId ?? '__all';
  const filters = saved[key] ?? initialFilters;
  const change = (patch: Partial<Filters>) =>
    setSaved((previous) => ({
      ...previous,
      [key]: { ...(previous[key] ?? initialFilters), offset: 0, ...patch },
    }));
  const [storedPage, setPage] = useState<SessionPage>({ items: [], total: 0 });
  const [resultKey, setResultKey] = useState<string | null>(null);
  const page = resultKey === key ? storedPage : { items: [], total: 0 };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelected] = useState<Session | null>(null);
  const selected = resultKey === key ? selection : null;
  const [previewOpen, setPreviewOpen] = useState(true);
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
    if (disabled) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const timer = setTimeout(
      () => {
        void api
          .sessions({
            projectId,
            kind: filters.kind || undefined,
            query: filters.query.trim() || undefined,
            archived: filters.archived === 'all' ? undefined : filters.archived === 'archived',
            includeChildren: filters.children,
            after: localDayBound(filters.after),
            before: localDayBound(filters.before, true),
            offset: filters.offset,
            limit: 40,
          })
          .then((result) => {
            if (!cancelled) {
              setPage(result);
              setResultKey(projectId ?? '__all');
              setSelected(
                (previous) =>
                  result.items.find((s) => s.id === previous?.id) ?? result.items[0] ?? null,
              );
            }
          })
          .catch((reason) => {
            if (!cancelled) {
              setError(errorMessage(reason));
              setPage({ items: [], total: 0 });
              setSelected(null);
            }
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      filters.query ? 220 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    projectId,
    filters.query,
    filters.kind,
    filters.archived,
    filters.after,
    filters.before,
    filters.children,
    filters.offset,
    refreshToken,
    disabled,
  ]);
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
  const filtered =
    !!filters.query ||
    !!filters.kind ||
    filters.archived !== 'active' ||
    !!filters.after ||
    !!filters.before ||
    filters.children;
  const selectedProject = projects.find((project) => project.id === selected?.projectId);
  return (
    <div className="history-view">
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
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          <FileText size={17} />
        </button>
      </div>
      {moreFilters && (
        <div className="filter-bar">
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
        <span>本機標題與對話 · 中文子字串 / 英文關鍵字</span>
      </div>
      <div className={`history-columns ${previewOpen ? '' : 'preview-hidden'}`}>
        <div className="session-column">
          {error ? (
            <div className="empty-state">
              <FileText size={32} />
              <h3>暫時無法讀取歷史</h3>
              <p role="alert">{error}</p>
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
            <div className="session-list" aria-label="Session 清單" aria-busy={loading}>
              {page.items.map((session) => (
                <button
                  key={session.id}
                  className={`session-card ${selected?.id === session.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelected(session);
                    setPreviewOpen(true);
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
              ))}
            </div>
          )}
          <div className="pagination">
            <span>
              {page.total
                ? `${filters.offset + 1}–${Math.min(filters.offset + page.items.length, page.total)} / ${page.total}`
                : '0 個結果'}
            </span>
            <div>
              <button
                aria-label="上一頁"
                disabled={filters.offset === 0 || loading}
                onClick={() => change({ offset: Math.max(0, filters.offset - 40) })}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                aria-label="下一頁"
                disabled={filters.offset + 40 >= page.total || loading}
                onClick={() => change({ offset: filters.offset + 40 })}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </div>
        {previewOpen && (
          <section className="transcript-column" aria-label="對話預覽">
            {selected ? (
              <>
                <header className="transcript-header">
                  <div>
                    <span className="eyebrow">對話預覽</span>
                    <h3>{selected.title || selected.externalId}</h3>
                  </div>
                  <button
                    className="primary"
                    disabled={disabled || !!selected.resumeDisabledReason}
                    aria-describedby={selected.resumeDisabledReason ? resumeReasonId : undefined}
                    onClick={() => { if (!selected.resumeDisabledReason) onResume(selected); }}
                  >
                    接續工作
                    <ArrowRight size={15} />
                  </button>
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
                <div className="transcript-footer">唯讀預覽 · 不啟動 Agent，也不傳送內容</div>
              </>
            ) : (
              <div className="empty-state">
                <FileText size={30} />
                <h3>留住工作的脈絡</h3>
                <p>選取左側 Session，從最近的對話繼續。</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
