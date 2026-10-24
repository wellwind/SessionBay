import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { GitBranch, LayoutGrid, MessageCircle } from 'lucide-react';
import { agentNames } from '../agents';
import { projectColor, projectColorSlots, projectInitials } from '../project-identity';
import { readTerminalTail } from '../terminal-tail';
import type { AgentKind, Pane, Project, Workspace } from '../types';
import { usePaneBranches } from '../use-pane-branches';
import {
  defaultOverviewFilter, filterOverview, overviewItems, sortOverview,
  type OverviewFilter, type OverviewItem, type OverviewSort,
} from '../workspace-overview';
import { useRuntimeActivity } from './RuntimeActivity';
import './workspace-overview.css';

const TAIL_REFRESH_MS = 1000;
const noopSubscribe = () => () => {};

/** Monitor every open terminal at once. Cards are text previews; only an opened pane is interactive. */
export function WorkspaceOverview({ workspace, projects, visible, onOpen }: {
  workspace: Workspace;
  projects: Project[];
  visible: boolean;
  onOpen: (paneId: string) => void;
}) {
  const store = useRuntimeActivity();
  const panes = Object.values(workspace.panes);
  // One subscription for all cards; the snapshot string changes only with a reported state.
  const observed = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => panes.map(pane => store?.paneAgentState(pane.id, pane.runtimeId) ?? '').join('\u0001'), () => '');
  const states = useMemo(() => new Map(panes.map((pane, index) => [pane.id, observed.split('\u0001')[index] ?? ''])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [observed, workspace.panes]);
  const items = useMemo(() => overviewItems(workspace, projects, (pane: Pane) => states.get(pane.id) ?? ''),
    [workspace, projects, states]);
  const [filter, setFilter] = useState<OverviewFilter>(defaultOverviewFilter);
  const [sort, setSort] = useState<OverviewSort>('attention');
  const shown = useMemo(() => sortOverview(filterOverview(items, filter), sort), [items, filter, sort]);
  const branches = usePaneBranches(items, visible);
  const colorSlots = useMemo(() => projectColorSlots(projects.map(project => project.id)), [projects]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setTick(value => value + 1), TAIL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [visible]);
  const grid = useRef<HTMLUListElement>(null);
  const projectOptions = useMemo(() => [...new Map(items.map(item => [item.projectId, item.projectName])).entries()], [items]);
  const kindOptions = useMemo(() => [...new Set(items.map(item => item.kind))], [items]);
  const counts = {
    input: items.filter(item => item.attention === 'input').length,
    error: items.filter(item => item.attention === 'error').length,
    active: items.filter(item => item.attention !== 'ended').length,
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('.overview-card-open') ?? [])];
    const index = buttons.indexOf(event.currentTarget);
    if (index < 0) return;
    // Column count from layout, so Up/Down follow the visual grid at any width.
    const top = buttons[0]?.getBoundingClientRect().top;
    const columns = Math.max(1, buttons.filter(button => button.getBoundingClientRect().top === top).length);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns,
      Home: 0, End: buttons.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, target))]?.focus();
  };
  return <section className="workspace-overview" hidden={!visible} aria-labelledby="workspace-overview-title">
    <header className="overview-header">
      <div className="overview-heading">
        <h2 id="workspace-overview-title"><LayoutGrid size={18} aria-hidden="true" />開啟中的工作</h2>
        <p className="overview-summary" aria-live="polite">
          {counts.input > 0 && <strong className="overview-summary-input">{counts.input} 個等待輸入</strong>}
          {counts.error > 0 && <strong className="overview-summary-error">{counts.error} 個需要處理</strong>}
          <span>{counts.active} 個開啟中 · 共 {items.length} 個</span>
        </p>
      </div>
      <div className="overview-controls">
        <label>狀態
          <select aria-label="狀態篩選" value={filter.attention} onChange={event => setFilter({ ...filter, attention: event.target.value as OverviewFilter['attention'] })}>
            <option value="all">全部</option>
            <option value="attention">需要注意</option>
            <option value="active">開啟中</option>
            <option value="ended">已結束</option>
          </select>
        </label>
        <label>專案
          <select aria-label="專案篩選" value={filter.projectId === null ? '\u0000' : filter.projectId}
            onChange={event => setFilter({ ...filter, projectId: event.target.value === '\u0000' ? null : event.target.value })}>
            <option value="all">全部專案</option>
            {projectOptions.map(([id, name]) => <option key={id ?? '\u0000'} value={id ?? '\u0000'}>{name}</option>)}
          </select>
        </label>
        <label>類型
          <select aria-label="類型篩選" value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as OverviewFilter['kind'] })}>
            <option value="all">全部類型</option>
            {kindOptions.map(kind => <option key={kind} value={kind}>{kind === 'shell' ? 'Shell' : agentNames[kind as AgentKind]}</option>)}
          </select>
        </label>
        <label>排序
          <select aria-label="排序方式" value={sort} onChange={event => setSort(event.target.value as OverviewSort)}>
            <option value="attention">需要注意優先</option>
            <option value="project">依專案</option>
          </select>
        </label>
      </div>
    </header>
    {items.length === 0 ? <div className="empty-state overview-empty">
      <LayoutGrid size={30} aria-hidden="true" /><h3>目前沒有開啟中的工作</h3>
      <p>在任一專案開啟 Terminal 或 Agent 後，會在這裡同時顯示。</p>
    </div> : shown.length === 0 ? <p className="overview-empty-filter">沒有符合篩選條件的工作。</p> :
    <ul className="overview-grid" ref={grid} aria-label="開啟中的工作">
      {shown.map(item => <OverviewCard key={item.paneId} item={item} branch={branches[item.paneId]} color={projectColor(item.projectId, colorSlots)}
        tail={visible && tick >= 0 ? readTerminalTail(item.paneId) : []} onOpen={() => onOpen(item.paneId)} onKeyDown={move} />)}
    </ul>}
  </section>;
}

function OverviewCard({ item, branch, color, tail, onOpen, onKeyDown }: {
  item: OverviewItem; branch?: string; color: string; tail: string[];
  onOpen: () => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const name = `${item.projectName} · ${item.kindLabel} ${item.title}`;
  return <li className={`overview-card attention-${item.attention}`} style={{ ['--card-project' as string]: color }}>
    <button type="button" className="overview-card-open" onClick={onOpen} onKeyDown={onKeyDown}
      aria-label={`放大 ${name}，${item.statusText}${branch ? `，分支 ${branch}` : ''}`}>
      <span className="overview-card-head">
        <span className="project-initials" aria-hidden="true">{projectInitials(item.projectName)}</span>
        <span className="overview-card-project">{item.projectName}</span>
        <span className={`overview-status attention-${item.attention}`}>{item.statusText}</span>
      </span>
      <span className="overview-card-title"><strong>{item.kindLabel}</strong> · {item.title}</span>
      <span className="overview-card-meta">
        {branch && <span className="overview-branch"><GitBranch size={12} aria-hidden="true" />{branch}</span>}
        <span className="overview-cwd" title={item.cwd}>{item.cwd}</span>
      </span>
      <pre className="overview-tail" aria-hidden="true">{tail.length ? tail.join('\n') : '（尚無輸出）'}</pre>
    </button>
    {item.attention === 'input' &&
      <button type="button" className="primary overview-reply" onClick={onOpen} aria-label={`放大並回覆 ${name}`}>
        <MessageCircle size={14} aria-hidden="true" />放大並回覆</button>}
  </li>;
}
