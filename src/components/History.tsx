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
import type { AgentKind, Project, Session, TranscriptPage, TrashedSession } from '../types';
import { OsTrashReview } from './OsTrashReview';
import { useSessionFeed } from '../use-session-feed';
import { VirtualSessionList } from './VirtualSessionList';
import { locale, t } from '../i18n';
export const agentName = (kind: AgentKind) => agentNames[kind];
function mergeWarnings(previous: string | null | undefined, next: string | null): string | null {
  if (!previous) return next;
  if (!next || previous.includes(next)) return previous;
  if (next.includes(previous)) return next;
  return `${previous}\n${next}`;
}
export function dateLabel(value: string | null): string {
  if (!value) return t('No activity yet');
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : t('Time unknown');
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
  // Set after the one-step delete parks the Session in the recycle bin.
  const [osReview, setOsReview] = useState<TrashedSession | null>(null);
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
  const moveToTrash = async (osTrash = false) => {
    if (!trashTarget?.trashIdentity || trashLock.current) return;
    trashLock.current = true;
    setTrashBusy(true);
    setTrashError('');
    try {
      const id = await api.trashSession(trashTarget.id, trashTarget.trashIdentity);
      if (osTrash) setOsReview({ id, session: trashTarget, sourceRoot: '', deletedAt: '', unavailableReason: null });
      else {
        focusUndo.current = { trigger: trashTrigger.current };
        setUndoQueue(queue => [...queue, { id, title: trashTarget.title || trashTarget.externalId }]);
      }
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
  // Backing out leaves the Session in the recycle bin, still undoable from the toast.
  const leaveOsReview = () => {
    if (!osReview) return;
    focusUndo.current = { trigger: trashTrigger.current };
    setUndoQueue(queue => [...queue, { id: osReview.id, title: osReview.session.title || osReview.session.externalId }]);
    setOsReview(null);
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
      {(undoId || (trashError && !trashTarget)) && createPortal(<div className="toast history-undo" aria-label={t('History deletion notice')} inert={!!trashTarget}>
        <div className="history-undo-message" role="status" aria-live="polite" aria-atomic="true">
          {undoId && <><p>{t('Moved to the recycle bin: {{title}}', { title: undoQueue[0].title })}</p>
            {undoQueue.length > 1 && <small>{t('{{count}} more can be undone in order.', { count: undoQueue.length - 1 })}</small>}</>}
          {trashError && !trashTarget && <p role="alert">{trashError}</p>}
        </div>
        <div className="history-undo-actions">
          {undoId && <button ref={undoButton} disabled={trashBusy} onClick={() => void undoTrash()}>{t('Undo delete')}</button>}
          <button className="icon-button" aria-label={t('Close undo notice')} disabled={trashBusy} onClick={() => { if (!hasBlockingDialog()) { dismissUndo(); setTrashError(''); } }}><X size={15} /></button>
        </div>
      </div>, document.body)}
      {trashTarget && <Dialog title={t('Move to the recycle bin?')} onClose={() => { if (!trashLock.current) setTrashTarget(null); }}>
        <p>{t('"{{title}}" will be hidden from Session Bay history and search; you can restore it from the recycle bin later.', { title: trashTarget.title || trashTarget.externalId })}</p>
        <p>{t('The original agent history is kept and running work continues. To delete the agent\'s files too, choose "Move to system trash…"; nothing moves until you confirm the file list.')}</p>
        {trashError && <p className="inline-error" role="alert">{trashError}</p>}
        <div className="dialog-actions">
          <button disabled={trashBusy} onClick={() => setTrashTarget(null)}>{t('Cancel')}</button>
          <button className="danger" disabled={trashBusy} onClick={() => void moveToTrash(true)}>{t('Move to system trash…')}</button>
          <button data-dialog-confirm className="primary" disabled={trashBusy} onClick={() => void moveToTrash()}>{t('Move to recycle bin')}</button>
        </div>
      </Dialog>}
      {osReview && <Dialog title={t('Move to system trash')} wide onClose={leaveOsReview}>
        <OsTrashReview entry={osReview} onClose={leaveOsReview} onMoved={async () => { setOsReview(null); setHistoryRevision((value) => value + 1); await onHistoryChanged?.(); }} />
      </Dialog>}
      <div className="history-controls">
        <div className="search-field">
          <Search size={17} />
          <input
            id="session-search"
            placeholder={t('Search conversations, code or ideas…')}
            aria-label={t('Search sessions')}
            value={filters.query}
            onChange={(event) => change({ query: event.target.value })}
          />
          {filters.query && (
            <button aria-label={t('Clear search')} onClick={() => change({ query: '' })}>
              <X size={14} />
            </button>
          )}
        </div>
        <Select aria-label={t('Filter by agent')} className="history-agent-filter" value={filters.kind}
          onChange={(kind) => change({ kind: kind as '' | AgentKind })}
          options={[{ value: '', label: t('All agents') }, ...historyAgentKinds.map((kind) => ({
            value: kind, label: agentNames[kind], icon: <AgentIcon kind={kind} />,
          }))]} />
        <button
          className={`secondary ${moreFilters ? 'selected' : ''}`}
          onClick={() => setMoreFilters(!moreFilters)}
        >
          <Filter size={15} />
          {t('Filter')}{filtered && <span className="tiny-dot" />}
        </button>
        <button
          className="icon-button"
          title={previewOpen ? t('Hide preview') : t('Show preview')}
          aria-label={previewOpen ? t('Hide preview') : t('Show preview')}
          onClick={() => { setPreviewOpen(!previewOpen); if (!previewOpen) onSelectSession?.(); }}
        >
          <FileText size={17} />
        </button>
      </div>
      {moreFilters && (
        <div className="filter-bar">
          <Select aria-label={t('Session order')} value={filters.oldestFirst ? 'oldest' : 'latest'}
            onChange={value => change({ oldestFirst: value === 'oldest' })}
            options={[{ value: 'latest', label: t('Most recent first') }, { value: 'oldest', label: t('Oldest first') }]} />
          <label>
            {t('From')}
            <DatePicker key={`${key}-after`} resetKey={dateReset} aria-label={t('Start date')} value={filters.after}
              onChange={(after) => change({ after })} />
          </label>
          <label>
            {t('To')}
            <DatePicker key={`${key}-before`} resetKey={dateReset} aria-label={t('End date')} value={filters.before}
              onChange={(before) => change({ before })} />
          </label>
          <Select aria-label={t('Archive status')} className="history-archive-filter" value={filters.archived}
            onChange={(archived) => change({ archived: archived as Filters['archived'] })}
            options={[{ value: 'active', label: t('Not archived') }, { value: 'all', label: t('Include archived') },
              { value: 'archived', label: t('Archived only') }]} />
          <label className="checkbox-label">
            <input
              type="checkbox" className="checkbox"
              checked={filters.children}
              onChange={(event) => change({ children: event.target.checked })}
            />
            {t('Include subagents and branches')}
          </label>
          {filtered && <button onClick={() => { change(initialFilters); setDateReset((value) => value + 1); }}>{t('Reset filters')}</button>}
        </div>
      )}
      <div className="history-caption">
        <span>{loading ? t('Searching…') : t('{{count}} sessions', { count: page.total })}</span>
      </div>
    </>;
  const sessionList = <div className="session-column">
          {error && !page.items.length ? (
            <div className="empty-state">
              <FileText size={32} />
              <h3>{t('History cannot be read right now')}</h3>
              <p role="alert">{error}</p>
              <button onClick={page.retry}>{t('Retry loading')}</button>
            </div>
          ) : loading && !page.items.length ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={28} />
              <p>{t('Reading the local index…')}</p>
            </div>
          ) : !page.items.length ? (
            <div className="empty-state">
              <div className="empty-icon">
                <HistoryIcon size={30} />
              </div>
              <h3>{filtered ? t('No matching conversations') : t('Pick up where you left off')}</h3>
              <p>
                {filtered
                  ? t('Try a shorter keyword, a wider date range or include archived conversations.')
                  : t('Local history from {{agents}} shows up here. You can also start new work right away.', { agents: historyAgentKinds.map((kind) => agentNames[kind]).join(t(', ')) })}
              </p>
              {filtered ? (
                <button className="secondary" onClick={() => change(initialFilters)}>
                  {t('Clear filters')}
                </button>
              ) : (
                <button className="primary" disabled={disabled} onClick={onNew}>
                  {t('Start new work')}
                  <ArrowRight size={15} />
                </button>
              )}
            </div>
          ) : (
            <VirtualSessionList key={feedKey} items={page.items} total={page.total} label={t('Session list')}
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
                      {session.snippet || t('Open the preview to see the latest conversation.')}
                    </p>
                    <div className="session-card-meta">
                      <span title={session.cwd ?? ''}>
                        {session.cwd || projects.find((p) => p.id === session.projectId)?.launchPath || t('Unknown working directory')}
                      </span>
                      <span>
                        {session.archived && t('Archived ')}
                        {session.partial && t('Partially parsed ')}
                        {session.parentId && t('Subagent / branch ')}
                        {session.timeSource === 'mtime' && t('File time')}
                      </span>
                    </div>
                  </button>
                  <button className="icon-button session-card-delete" aria-label={t('Delete session {{title}}', { title: session.title || session.externalId })}
                    title={t('Move to the recycle bin')} disabled={disabled || trashBusy || !session.trashIdentity}
                    onClick={event => { trashTrigger.current = event.currentTarget; event.currentTarget.focus(); setTrashError(''); setTrashTarget(session); }}>
                    <Trash2 size={16} />
                  </button>
                </div>
              )} />
          )}

        </div>;
  const preview = previewOpen && (
          <section className="transcript-column" aria-label={t('Conversation preview')}>
            {selected ? (
              <>
                <header className="transcript-header">
                  <div className="transcript-heading">
                    <span className="eyebrow">{t('Conversation preview')}</span>
                    <h3>{selected.title || selected.externalId}</h3>
                  </div>
                  <div className="transcript-actions">
                    <button className="icon-button" aria-label={t('Delete session')} title={t('Move to recycle bin (can be restored)')}
                      disabled={disabled || trashBusy || !selected.trashIdentity} onClick={event => { trashTrigger.current = event.currentTarget; event.currentTarget.focus(); setTrashError(''); setTrashTarget(selected); }}><Trash2 size={17} /></button>
                    <button
                      className="primary"
                      disabled={disabled || !!selected.resumeDisabledReason}
                      aria-describedby={selected.resumeDisabledReason ? resumeReasonId : undefined}
                      onClick={() => { if (!selected.resumeDisabledReason) onResume(selected); }}
                    >
                      {t('Resume work')}
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
                    {selected.timeSource === 'mtime' ? t('File modified') : t('Conversation activity')} ·{' '}
                    {dateLabel(selected.updatedAt)}
                  </span>
                </div>
                <div className="transcript-source">
                  {t('Source {{root}}', { root: selected.sourceId })} · Session {selected.externalId}
                  <br />
                  {selected.cwd || t('No working directory recorded')}
                  {selectedProject?.launchPath && (
                    <>
                      <br />
                      {t('Resume folder (relocated): {{path}}', { path: selectedProject.launchPath })}
                    </>
                  )}
                  {selected.parentId && (
                    <>
                      <br />
                      {t('Branched from {{id}}', { id: selected.parentId })}
                    </>
                  )}
                </div>
                {onCurate && selectedProject && (
                  <div className="history-project-action">
                    {selectedProject.curated ? <span>{t('In projects: {{name}}', { name: selectedProject.name })}</span> :
                      <button className="secondary" disabled={disabled || curating} onClick={() => onCurate(selected)}>
                        <FolderPlus size={14} />{selectedProject.path || selectedProject.launchPath ? t('Add this folder to projects') : t('Choose a folder and add it to projects')}
                      </button>}
                  </div>
                )}
                {(transcript?.stale || transcript?.warning || selected.partial) && (
                  <div className="inline-warning">
                    <div>
                      {transcript?.stale && <div>{t('The source changed; the index may not be updated yet.')}</div>}
                      {transcript?.warning && <div>{transcript.warning}</div>}
                      {selected.partial && !transcript?.warning && <div>{t('Some events could not be parsed; the readable content is still shown.')}</div>}
                    </div>
                    {transcript?.stale && (
                      <button onClick={() => setPreviewRefresh((value) => value + 1)}>
                        <RefreshCw size={13} />
                        {t('Read again')}
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
                      {previewLoading ? t('Loading…') : t('Load earlier messages')}
                    </button>
                  )}
                  {previewError && (
                    <div className="inline-warning" role="alert">
                      {previewError}
                      <button onClick={() => setPreviewRefresh((value) => value + 1)}>{t('Retry')}</button>
                    </div>
                  )}
                  {previewLoading && !transcript && (
                    <div className="empty-state">
                      <LoaderCircle className="spin" size={22} />
                      <p>{t('Loading conversation…')}</p>
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
                            ? t('You')
                            : message.role === 'assistant'
                              ? 'AI'
                              : '·'}
                        </span>
                        <strong>
                          {message.role === 'user'
                            ? t('User')
                            : message.role === 'assistant'
                              ? agentName(selected.kind)
                              : message.role === 'tool'
                                ? t('Tool')
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
                      <p>{t('There is no text to preview. Attachments and unsupported events may have no text.')}</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <FileText size={30} />
                <h3>{t('Keep the context of your work')}</h3>
                <p>{t('Choose a session to continue from its latest conversation.')}</p>
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
