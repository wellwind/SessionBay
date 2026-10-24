import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { History, Search, TerminalSquare } from 'lucide-react';
import { api, errorMessage } from '../api';
import { agentNames } from '../agents';
import { paneRuntimeStatusText } from '../pane-runtime-status';
import type { Pane, Project, Session, Workspace } from '../types';
import { paneIds } from '../workspace';
import { useRuntimeActivity } from './RuntimeActivity';

const SESSION_LIMIT = 20;
const noopSubscribe = () => () => {};
export type ProjectBadge = (projectId: string | null) => { initials: string; name: string; color: string };

/**
 * Split source: an open pane of any project (moved, never restarted) or a
 * history Session of any project (resumed into the split).
 */
export function SplitExistingPicker({ workspace, targetPaneId, projects, badge, onPickPane, onPickSession }: {
  workspace: Workspace;
  targetPaneId: string;
  projects: Project[];
  badge: ProjectBadge;
  onPickPane: (paneId: string) => void;
  onPickSession: (session: Session) => void;
}) {
  const [query, setQuery] = useState('');
  const store = useRuntimeActivity();
  // Panes already in the target tab are excluded; everything else can move in.
  const targetTab = workspace.tabs.find((tab) => paneIds(tab.layout).includes(targetPaneId));
  const excluded = new Set(targetTab ? paneIds(targetTab.layout) : []);
  const panes = useMemo(() => workspace.tabs.flatMap((tab) => paneIds(tab.layout))
    .flatMap((id) => !excluded.has(id) && workspace.panes[id] ? [workspace.panes[id]] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [workspace, targetPaneId]);
  const observed = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => panes.map((pane) => store?.paneAgentState(pane.id, pane.runtimeId) ?? '').join('\u0001'), () => '');
  const needle = query.trim().toLowerCase();
  const matches = (pane: Pane) => !needle ||
    [pane.title, badge(pane.projectId).name, pane.kind === 'shell' ? 'shell' : agentNames[pane.kind], pane.cwd]
      .some((text) => text.toLowerCase().includes(needle));
  const shownPanes = panes.filter(matches);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionError, setSessionError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api.sessions({ query: query.trim() || undefined, limit: SESSION_LIMIT })
        .then((page) => { if (!cancelled) { setSessions(page.items); setSessionError(''); } })
        .catch((error) => { if (!cancelled) { setSessions([]); setSessionError(errorMessage(error)); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  const openSessionIds = new Set(Object.values(workspace.panes).flatMap((pane) => pane.sessionId ? [pane.sessionId] : []));
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? '未知專案';

  return <div className="split-existing">
    <label className="field-label">搜尋
      <span className="split-existing-search"><Search size={14} aria-hidden="true" />
        <input type="search" value={query} placeholder="專案、標題、Agent 或路徑"
          aria-label="搜尋既有工作與 Session" onChange={(event) => setQuery(event.target.value)} autoFocus /></span>
    </label>
    <section aria-labelledby="split-existing-open">
      <h3 id="split-existing-open"><TerminalSquare size={14} aria-hidden="true" />開啟中的工作<small>移入，不重新啟動</small></h3>
      {shownPanes.length === 0 ? <p className="small-muted">{panes.length ? '沒有符合的工作。' : '其他分頁沒有開啟中的工作。'}</p> :
        <ul className="split-existing-list">{shownPanes.map((pane) => {
          const item = badge(pane.projectId);
          const index = panes.indexOf(pane);
          const status = paneRuntimeStatusText(pane, false, observed.split('\u0001')[index]?.split('|')[0] ?? '') || '已開啟';
          return <li key={pane.id}><button type="button" onClick={() => onPickPane(pane.id)}
            aria-label={`移入 ${item.name} · ${pane.title}，${status}`}>
            <span className="project-initials" style={{ ['--pane-project' as string]: item.color }} aria-hidden="true">{item.initials}</span>
            <span className="split-existing-main"><strong>{pane.title}</strong>
              <span>{item.name} · {pane.kind === 'shell' ? 'Shell' : agentNames[pane.kind]}</span></span>
            <span className="split-existing-status">{status}</span>
          </button></li>;
        })}</ul>}
    </section>
    <section aria-labelledby="split-existing-history" aria-busy={loading}>
      <h3 id="split-existing-history"><History size={14} aria-hidden="true" />Session 歷史<small>在分割中接續</small></h3>
      {sessionError ? <p className="inline-warning" role="alert">{sessionError}</p>
        : loading && sessions.length === 0 ? <p className="small-muted" role="status">搜尋中…</p>
        : !loading && sessions.length === 0 ? <p className="small-muted">沒有符合的 Session。</p> :
        <ul className="split-existing-list">{sessions.map((session) => {
          const item = badge(session.projectId);
          const open = openSessionIds.has(session.id);
          return <li key={session.id}><button type="button" disabled={!!session.resumeDisabledReason || open}
            title={session.resumeDisabledReason ?? (open ? '這個 Session 已開啟；請從「開啟中的工作」移入。' : undefined)}
            onClick={() => onPickSession(session)} aria-label={`接續 ${projectName(session.projectId)} · ${session.title}`}>
            <span className="project-initials" style={{ ['--pane-project' as string]: item.color }} aria-hidden="true">{item.initials}</span>
            <span className="split-existing-main"><strong>{session.title}</strong>
              <span>{projectName(session.projectId)} · {agentNames[session.kind]}</span></span>
            <span className="split-existing-status">{open ? '已開啟' : new Date(session.updatedAt).toLocaleDateString('zh-TW')}</span>
          </button></li>;
        })}</ul>}
    </section>
  </div>;
}
