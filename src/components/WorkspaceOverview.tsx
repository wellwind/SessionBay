import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Columns3, GitBranch, LayoutGrid, MessageCircle } from 'lucide-react';
import { agentNames } from '../agents';
import { projectColor, projectColorSlots, projectInitials } from '../project-identity';
import { readTerminalTail } from '../terminal-tail';
import type { AgentKind, Pane, Project, Workspace } from '../types';
import { MAX_SPLIT_PANES } from '../workspace';
import { usePaneBranches } from '../use-pane-branches';
import {
  defaultOverviewFilter, filterOverview, overviewItems, sortOverview,
  type OverviewFilter, type OverviewItem, type OverviewSort,
} from '../workspace-overview';
import { useRuntimeActivity } from './RuntimeActivity';
import './workspace-overview.css';
import { t } from '../i18n';

const TAIL_REFRESH_MS = 1000;
const noopSubscribe = () => () => {};

/** Monitor every open terminal at once. Cards are text previews; only an opened pane is interactive. */
export function WorkspaceOverview({ workspace, projects, visible, onOpen, onSplit }: {
  workspace: Workspace;
  projects: Project[];
  visible: boolean;
  onOpen: (paneId: string) => void;
  /** Open 2–3 selected panes side by side; panes keep their own project and runtime. */
  onSplit?: (paneIds: string[]) => void;
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
  const [selected, setSelected] = useState<string[]>([]);
  const chosen = selected.filter((id) => workspace.panes[id]);
  const toggleSelected = (id: string) => setSelected((previous) => previous.includes(id)
    ? previous.filter((item) => item !== id) : previous.length >= MAX_SPLIT_PANES ? previous : [...previous, id]);
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
        <h2 id="workspace-overview-title"><LayoutGrid size={18} aria-hidden="true" />{t('Open work')}</h2>
        <p className="overview-summary" aria-live="polite">
          {counts.input > 0 && <strong className="overview-summary-input">{t('{{count}} waiting for input', { count: counts.input })}</strong>}
          {counts.error > 0 && <strong className="overview-summary-error">{t('{{count}} need attention', { count: counts.error })}</strong>}
          <span>{t('{{active}} open · {{total}} total', { active: counts.active, total: items.length })}</span>
        </p>
      </div>
      <div className="overview-controls">
        {onSplit && <div className="overview-split" role="group" aria-label={t('Open side by side')}>
          <span className="overview-split-hint" aria-live="polite">{chosen.length
            ? t('{{count}} / {{max}} selected', { count: chosen.length, max: MAX_SPLIT_PANES })
            : t('Check 2–{{max}} to open side by side; keep the rest in the overview', { max: MAX_SPLIT_PANES })}</span>
          <button type="button" className="primary" disabled={chosen.length < 2}
            onClick={() => { onSplit(chosen); setSelected([]); }}><Columns3 size={14} aria-hidden="true" />{t('Open side by side')}</button>
          {chosen.length > 0 && <button type="button" className="secondary" onClick={() => setSelected([])}>{t('Clear')}</button>}
        </div>}
        <label>{t('Status')}
          <select aria-label={t('Status filter')} value={filter.attention} onChange={event => setFilter({ ...filter, attention: event.target.value as OverviewFilter['attention'] })}>
            <option value="all">{t('All')}</option>
            <option value="attention">{t('Needs attention (filter)')}</option>
            <option value="active">{t('Open (state)')}</option>
            <option value="ended">{t('Ended')}</option>
          </select>
        </label>
        <label>{t('Project')}
          <select aria-label={t('Project filter')} value={filter.projectId === null ? '\u0000' : filter.projectId}
            onChange={event => setFilter({ ...filter, projectId: event.target.value === '\u0000' ? null : event.target.value })}>
            <option value="all">{t('All projects')}</option>
            {projectOptions.map(([id, name]) => <option key={id ?? '\u0000'} value={id ?? '\u0000'}>{name}</option>)}
          </select>
        </label>
        <label>{t('Type')}
          <select aria-label={t('Type filter')} value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as OverviewFilter['kind'] })}>
            <option value="all">{t('All types')}</option>
            {kindOptions.map(kind => <option key={kind} value={kind}>{kind === 'shell' ? 'Shell' : agentNames[kind as AgentKind]}</option>)}
          </select>
        </label>
        <label>{t('Sort')}
          <select aria-label={t('Sort order')} value={sort} onChange={event => setSort(event.target.value as OverviewSort)}>
            <option value="attention">{t('Needs attention first')}</option>
            <option value="project">{t('By project')}</option>
          </select>
        </label>
      </div>
    </header>
    {items.length === 0 ? <div className="empty-state overview-empty">
      <LayoutGrid size={30} aria-hidden="true" /><h3>{t('No open work right now')}</h3>
      <p>{t('Terminals and agents you open in any project show up here together.')}</p>
    </div> : shown.length === 0 ? <p className="overview-empty-filter">{t('No work matches the filters.')}</p> :
    <ul className="overview-grid" ref={grid} aria-label={t('Open work')}>
      {shown.map(item => <OverviewCard key={item.paneId} item={item} branch={branches[item.paneId]} color={projectColor(item.projectId, colorSlots)}
        selection={onSplit ? { checked: chosen.includes(item.paneId), disabled: !chosen.includes(item.paneId) && chosen.length >= MAX_SPLIT_PANES,
          onChange: () => toggleSelected(item.paneId) } : undefined}
        tail={visible && tick >= 0 ? readTerminalTail(item.paneId) : []} onOpen={() => onOpen(item.paneId)} onKeyDown={move} />)}
    </ul>}
  </section>;
}

function OverviewCard({ item, branch, color, tail, selection, onOpen, onKeyDown }: {
  item: OverviewItem; branch?: string; color: string; tail: string[];
  selection?: { checked: boolean; disabled: boolean; onChange: () => void };
  onOpen: () => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const name = `${item.projectName} · ${item.kindLabel} ${item.title}`;
  return <li className={`overview-card attention-${item.attention}`} style={{ ['--card-project' as string]: color }}>
    <button type="button" className="overview-card-open" onClick={onOpen} onKeyDown={onKeyDown}
      aria-label={t('Expand {{name}}, {{status}}', { name, status: item.statusText }) + (branch ? t(', on branch {{branch}}', { branch }) : '')}>
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
      <pre className="overview-tail" aria-hidden="true">{tail.length ? tail.join('\n') : t('(no output yet)')}</pre>
    </button>
    {selection && <label className="overview-select">
      <input type="checkbox" checked={selection.checked} disabled={selection.disabled} onChange={selection.onChange}
        aria-label={t('Select {{name}} for side by side', { name })} />{t('Side by side')}</label>}
    {item.attention === 'input' &&
      <button type="button" className="primary overview-reply" onClick={onOpen} aria-label={t('Expand and reply to {{name}}', { name })}>
        <MessageCircle size={14} aria-hidden="true" />{t('Expand and reply')}</button>}
  </li>;
}
