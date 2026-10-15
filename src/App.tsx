import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Anchor,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command as CommandIcon,
  Folder,
  FolderPlus,
  History,
  Layers3,
  LoaderCircle,
  PanelLeftClose,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  TerminalSquare,
  X,
  AlertTriangle,
  Check,
  Square,
  Compass,
} from 'lucide-react';
import { api, errorMessage, isDesktop } from './api';
import type {
  AgentKind,
  Bootstrap,
  IndexStatus,
  Pane,
  Project,
  Session,
  Settings,
  Workspace,
} from './types';
import {
  closePane,
  emptyWorkspace,
  mergeWorkspaceProjects,
  paneIds,
  restoreWorkspace,
  serializeWorkspace,
  setRatio,
  splitNode,
  uid,
} from './workspace';
import { matchesShortcut, shortcutConflicts, shortcutDefaults } from './commands';
import type { Command } from './commands';
import { Dialog } from './components/Dialog';
import { agentName, dateLabel, HistoryView } from './components/History';
import { SettingsPanel } from './components/SettingsPanel';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
interface Launcher {
  kind: 'shell' | AgentKind;
  cwd: string;
  profileId: string;
  split?: { paneId: string; axis: 'horizontal' | 'vertical' };
}
interface PathDialog {
  path: string;
  project?: Project;
  resume?: Session;
}
interface Confirmation {
  title: string;
  text: string;
  action: () => Promise<void>;
}
const noIndex: IndexStatus = {
  running: false,
  processed: 0,
  total: 0,
  cancelled: false,
  errors: [],
  sources: [],
};
export default function App() {
  const desktop = isDesktop();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [view, setView] = useState<'history' | 'workspace'>('history');
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [index, setIndex] = useState<IndexStatus>(noIndex);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectSearch, setProjectSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<Launcher | null>(null);
  const [pathDialog, setPathDialog] = useState<PathDialog | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const ready = boot !== null;
  const settings = boot?.settings;
  const theme = settings?.theme;
  const knownProjects = useRef<Record<string, Project>>({});
  for (const project of projects) knownProjects.current[project.id] = project;
  const visibleProjects = useMemo(
    () => mergeWorkspaceProjects(projects, workspace, knownProjects.current),
    [projects, workspace],
  );
  const current = visibleProjects.find((p) => p.id === selectedId);
  const activeTabId = selectedId ? workspace.activeTabByProject[selectedId] : undefined;
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
  const focusPane = activeTab ? workspace.panes[activeTab.focusedPaneId] : undefined;
  useEffect(() => {
    if (selectedId && !visibleProjects.some((project) => project.id === selectedId)) {
      setSelectedId(undefined);
      setView('history');
    }
  }, [selectedId, visibleProjects]);
  const stateRef = useRef({ workspace, selectedId, boot, view, projects: visibleProjects });
  stateRef.current = { workspace, selectedId, boot, view, projects: visibleProjects };
  const indexRef = useRef(index);
  indexRef.current = index;
  const saveQueue = useRef(Promise.resolve());
  const closingApp = useRef(false);
  const observedWorkspace = useRef<string | null>(null);
  const persistedWorkspace = useRef<string | null>(null);
  const workspaceSignature = useMemo(
    () => JSON.stringify(serializeWorkspace(workspace)),
    [workspace],
  );
  const notify = useCallback((error: unknown) => setToast(errorMessage(error)), []);
  const refresh = useCallback(async () => {
    setProjects(await api.projects());
    setRefreshToken((t) => t + 1);
  }, []);
  const scan = useCallback(async (rebuild: boolean) => {
    setIndex(await api.scan(rebuild));
  }, []);
  const initialize = useCallback(async () => {
    setBootError('');
    try {
      const data = await api.bootstrap();
      setBoot(data);
      setProjects(data.projects);
      setIndex(data.index);
      const restored = restoreWorkspace(data.workspace);
      observedWorkspace.current = JSON.stringify(serializeWorkspace(restored));
      persistedWorkspace.current = observedWorkspace.current;
      setWorkspace(restored);
      setSettingsOpen(!data.settings.onboardingComplete);
      if (data.warnings.length) notify(data.warnings.join('；'));
      if (data.settings.onboardingComplete && !data.index.running)
        void api.scan(false).then(setIndex).catch(notify);
    } catch (error) {
      setBootError(errorMessage(error));
    }
  }, [notify]);
  useEffect(() => {
    if (desktop) void initialize();
  }, [desktop, initialize]);
  useEffect(() => {
    if (!ready || !desktop) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.index();
        if (disposed) return;
        const previous = indexRef.current;
        const changed =
          previous.revision !== status.revision ||
          previous.processed !== status.processed ||
          previous.total !== status.total ||
          JSON.stringify(previous.sources) !== JSON.stringify(status.sources) ||
          JSON.stringify(previous.errors) !== JSON.stringify(status.errors);
        const finished = previous.running && !status.running;
        setIndex(status);
        if (finished || (changed && !status.running)) await refresh();
      } catch (error) {
        if (!disposed) notify(error);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1800);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [ready, desktop, refresh, notify]);
  useEffect(() => {
    if (!theme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  useEffect(() => {
    if (!ready || observedWorkspace.current === workspaceSignature) return;
    observedWorkspace.current = workspaceSignature;
    const timer = setTimeout(() => {
      if (closingApp.current) return;
      saveQueue.current = saveQueue.current
        .then(() => api.saveWorkspace(JSON.parse(workspaceSignature)))
        .then(() => {
          persistedWorkspace.current = workspaceSignature;
        })
        .catch(notify);
    }, 400);
    return () => clearTimeout(timer);
  }, [workspaceSignature, ready, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 10000);
    return () => clearTimeout(timer);
  }, [toast]);
  const closeApplication = useCallback(() => {
    const live = Object.values(stateRef.current.workspace.panes).filter(
      (p) => p.state === 'running' || p.state === 'starting',
    );
    const action = async () => {
      closingApp.current = true;
      try {
        if (stateRef.current.boot) {
          await saveQueue.current;
          const snapshot = serializeWorkspace(stateRef.current.workspace);
          const signature = JSON.stringify(snapshot);
          if (signature !== persistedWorkspace.current) {
            await api.saveWorkspace(snapshot);
            persistedWorkspace.current = signature;
          }
        }
        await api.close();
      } catch (error) {
        closingApp.current = false;
        throw error;
      }
    };
    if (live.length)
      setConfirmation({
        title: `結束 ${live.length} 個程序並退出？`,
        text: `將結束 Session Bay 管理的面板：${live.map((p) => p.title).join('、')}。布局會保存，重新開啟時不會自動執行指令。`,
        action,
      });
    else void action().catch(notify);
  }, [notify]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const listeners: (() => void)[] = [];
    for (const task of [
      listen('app-close-requested', closeApplication),
      listen<string>('app-close-error', (event) => notify(event.payload)),
    ])
      void task
        .then((stop) => {
          if (disposed) stop();
          else listeners.push(stop);
        })
        .catch(notify);
    return () => {
      disposed = true;
      listeners.forEach((stop) => stop());
    };
  }, [desktop, closeApplication, notify]);
  const patchPane = useCallback(
    (id: string, patch: Partial<Pane>) =>
      setWorkspace((w) =>
        w.panes[id] ? { ...w, panes: { ...w.panes, [id]: { ...w.panes[id], ...patch } } } : w,
      ),
    [],
  );
  const focus = useCallback((id: string) => {
    const tab = stateRef.current.workspace.tabs.find((t) => paneIds(t.layout).includes(id));
    if (!tab) return;
    setSelectedId(tab.projectId);
    setView('workspace');
    setMaximizedId(null);
    setWorkspace((w) => ({
      ...w,
      activeTabByProject: { ...w.activeTabByProject, [tab.projectId]: tab.id },
      tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, focusedPaneId: id } : t)),
    }));
  }, []);
  const startPane = useCallback(
    (id: string, cwdOverride?: string) =>
      setWorkspace((w) => {
        const pane = w.panes[id];
        if (!pane || pane.state === 'running' || pane.state === 'starting') return w;
        const project = stateRef.current.projects.find((p) => p.id === pane.projectId);
        const cwd =
          cwdOverride ??
          (pane.sessionId ? project?.launchPath || project?.path || pane.cwd : pane.cwd);
        return {
          ...w,
          panes: { ...w.panes, [id]: { ...pane, cwd, startToken: (pane.startToken ?? 0) + 1 } },
        };
      }),
    [],
  );
  const addPane = (
    project: Project,
    kind: Pane['kind'],
    cwd: string,
    profileId: string,
    session?: Session,
    split?: Launcher['split'],
  ) => {
    if (Object.keys(workspace.panes).length >= 128) {
      notify('已達 128 個面板上限。請先關閉不需要的面板。');
      return;
    }
    const id = uid();
    const pane: Pane = {
      id,
      kind,
      title:
        session?.title ||
        (kind === 'shell'
          ? settings?.profiles.find((p) => p.id === profileId)?.name || 'Terminal'
          : `${agentName(kind)} 工作`),
      projectId: project.id,
      cwd,
      profileId,
      sessionId: session?.id,
      state: 'placeholder',
      startToken: 1,
    };
    setWorkspace((w) => {
      const tab = split ? w.tabs.find((t) => paneIds(t.layout).includes(split.paneId)) : undefined;
      if (tab && split)
        return {
          ...w,
          panes: { ...w.panes, [id]: pane },
          tabs: w.tabs.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  focusedPaneId: id,
                  layout: splitNode(t.layout, split.paneId, id, split.axis),
                }
              : t,
          ),
          activeTabByProject: { ...w.activeTabByProject, [project.id]: tab.id },
        };
      const tabId = uid();
      return {
        ...w,
        panes: { ...w.panes, [id]: pane },
        tabs: [
          ...w.tabs,
          {
            id: tabId,
            projectId: project.id,
            name: kind === 'shell' ? 'Terminal' : agentName(kind),
            focusedPaneId: id,
            layout: { kind: 'pane', paneId: id },
          },
        ],
        activeTabByProject: { ...w.activeTabByProject, [project.id]: tabId },
      };
    });
    setSelectedId(project.id);
    setView('workspace');
    setMaximizedId(null);
  };
  const resume = (session: Session, override?: Project) => {
    const existing = Object.values(workspace.panes).find((p) => p.sessionId === session.id);
    const project = override ?? visibleProjects.find((p) => p.id === session.projectId);
    if (existing) {
      if (existing.state === 'running' || existing.state === 'starting') {
        focus(existing.id);
        return;
      }
      if (project && (!project.exists || !(project.launchPath || project.path))) {
        setPathDialog({ project, path: project.launchPath || project.path || '', resume: session });
        return;
      }
      focus(existing.id);
      startPane(existing.id, project?.launchPath || project?.path || existing.cwd);
      return;
    }
    if (!project) {
      notify('找不到 Session 所屬專案，請先重新整理索引。');
      return;
    }
    if (!project.exists || !(project.launchPath || project.path)) {
      setPathDialog({ project, path: project.launchPath || project.path || '', resume: session });
      return;
    }
    addPane(
      project,
      session.kind,
      project.launchPath || project.path || session.cwd || '',
      settings?.defaultProfileId ?? '',
      session,
    );
  };
  const openLauncher = (kind: Launcher['kind'], split?: Launcher['split']) => {
    if (!settings) return;
    if (!current) {
      setPathDialog({ path: '' });
      return;
    }
    if (!current.exists || !(current.launchPath || current.path)) {
      setPathDialog({ project: current, path: current.launchPath || current.path || '' });
      return;
    }
    setLauncher({
      kind,
      cwd: current.launchPath || current.path || '',
      profileId: settings.defaultProfileId,
      split,
    });
  };
  const removePanes = (ids: string[]) => {
    const panes = ids.map((id) => workspace.panes[id]).filter(Boolean);
    const live = panes.filter((p) => p.state === 'running' || p.state === 'starting');
    const action = async () => {
      const managed = await api.runtimes();
      const targets = new Set([
        ...managed
          .filter((r) => ids.includes(r.paneId) && ['running', 'starting'].includes(r.state))
          .map((r) => r.id),
        ...ids
          .map((id) => stateRef.current.workspace.panes[id])
          .filter((p) => p && ['running', 'starting'].includes(p.state) && p.runtimeId)
          .map((p) => p.runtimeId!),
      ]);
      await Promise.all([...targets].map((id) => api.stop(id)));
      setWorkspace((w) => {
        const next = ids.reduce((result, id) => closePane(result, id), w);
        if (!next.tabs.some((t) => t.projectId === stateRef.current.selectedId)) setView('history');
        return next;
      });
      setMaximizedId(null);
    };
    if (live.length)
      setConfirmation({
        title: `關閉 ${panes.length} 個面板？`,
        text: `將結束受管程序：${live.map((p) => p.title).join('、')}，並移除面板。其他分頁的程序不受影響。`,
        action,
      });
    else void action().catch(notify);
  };
  const effectiveShortcuts = useMemo(
    () => ({ ...shortcutDefaults, ...settings?.shortcuts }),
    [settings?.shortcuts],
  );
  const conflicts = useMemo(() => shortcutConflicts(effectiveShortcuts), [effectiveShortcuts]);
  const commands: Command[] = [
    {
      id: 'command-palette',
      label: '開啟命令面板',
      run: () => {
        setPalette(true);
        setPaletteQuery('');
      },
    },
    {
      id: 'new-terminal',
      label: '開啟 Terminal',
      run: () => openLauncher('shell'),
      disabled: !settings,
    },
    {
      id: 'new-agent',
      label: '開始 Agent 工作',
      run: () => openLauncher(settings?.defaultAgent ?? 'codex'),
      disabled: !settings,
    },
    {
      id: 'search-sessions',
      label: '搜尋所有 Session',
      run: () => {
        setSelectedId(undefined);
        setView('history');
        setTimeout(() => document.getElementById('session-search')?.focus(), 0);
      },
    },
    {
      id: 'split-right',
      label: '左右分割面板',
      run: () => {
        if (focusPane) openLauncher('shell', { paneId: focusPane.id, axis: 'horizontal' });
      },
      disabled: !focusPane,
    },
    {
      id: 'split-down',
      label: '上下分割面板',
      run: () => {
        if (focusPane) openLauncher('shell', { paneId: focusPane.id, axis: 'vertical' });
      },
      disabled: !focusPane,
    },
    {
      id: 'next-pane',
      label: '切換至下一個面板',
      run: () => {
        if (activeTab) {
          const ids = paneIds(activeTab.layout);
          focus(ids[(ids.indexOf(activeTab.focusedPaneId) + 1) % ids.length]);
        }
      },
      disabled: !focusPane,
    },
    {
      id: 'maximize-pane',
      label: maximizedId ? '還原面板大小' : '暫時最大化面板',
      run: () => {
        if (focusPane) setMaximizedId(maximizedId === focusPane.id ? null : focusPane.id);
      },
      disabled: !focusPane,
    },
    {
      id: 'close-pane',
      label: '關閉目前面板',
      run: () => {
        if (focusPane) removePanes([focusPane.id]);
      },
      disabled: !focusPane,
    },
    { id: 'toggle-sidebar', label: '顯示／隱藏側欄', run: () => setSidebarOpen((value) => !value) },
  ].map((command) => ({ ...command, shortcut: effectiveShortcuts[command.id] ?? '' }));
  const commandRef = useRef(commands);
  commandRef.current = commands;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]'))
        return;
      const command = commandRef.current.find(
        (c) =>
          c.shortcut && !c.disabled && !conflicts.has(c.id) && matchesShortcut(event, c.shortcut),
      );
      if (command) {
        event.preventDefault();
        command.run();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [conflicts]);
  const runCommand = (id: string) => commands.find((c) => c.id === id && !c.disabled)?.run();
  const saveSettings = async (next: Settings) => {
    const first = !settings?.onboardingComplete;
    const saved = await api.saveSettings(next);
    setBoot((b) => (b ? { ...b, settings: saved } : b));
    setSettingsOpen(false);
    void api
      .detect()
      .then((installations) => setBoot((b) => (b ? { ...b, installations } : b)))
      .catch(notify);
    if (first) void scan(false).catch(notify);
  };
  const sortedProjects = [...visibleProjects]
    .filter((p) => `${p.name} ${p.path ?? ''}`.toLowerCase().includes(projectSearch.toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
        a.name.localeCompare(b.name),
    );
  const activeCount = Object.values(workspace.panes).filter(
    (p) => p.state === 'running' || p.state === 'starting',
  ).length;
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">
            <Anchor size={22} />
          </div>
          <span>
            Session Bay<span className="brand-tag">WORKSPACE</span>
          </span>
        </div>
        <button className="global-search" onClick={() => runCommand('command-palette')}>
          <Search size={15} />
          <span>搜尋專案或執行命令</span>
          <kbd>⌘ / Ctrl ⇧ P</kbd>
        </button>
        <div className="topbar-actions">
          <span className="local-badge">
            <span className="tiny-dot" />
            本機優先
          </span>
          <button
            className="icon-button"
            aria-label="設定與資料來源"
            title="設定與資料來源"
            disabled={!boot}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>
      <div className="app-body">
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              <span>工作總覽</span>
              <button
                className="icon-button"
                aria-label="隱藏側欄"
                onClick={() => setSidebarOpen(false)}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <button
              className={`sidebar-global ${selectedId === undefined ? 'active' : ''}`}
              onClick={() => {
                setSelectedId(undefined);
                setView('history');
              }}
            >
              <Compass size={17} />
              所有 Session<span>{projects.reduce((sum, p) => sum + p.sessionCount, 0)}</span>
            </button>
            <div className="sidebar-section">
              <span>專案</span>
              <button
                className="icon-button"
                title="加入專案"
                aria-label="加入專案"
                disabled={!boot}
                onClick={() => setPathDialog({ path: '' })}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="project-search">
              <Search size={13} />
              <input
                aria-label="搜尋專案"
                placeholder="尋找專案…"
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </div>
            <nav className="project-list" aria-label="專案">
              {sortedProjects.map((project) => (
                <div
                  key={project.id}
                  className={`project-row ${selectedId === project.id ? 'active' : ''}`}
                >
                  <button
                    className="project-main"
                    onClick={() => {
                      setSelectedId(project.id);
                      setView('history');
                      setMaximizedId(null);
                    }}
                    title={project.path ?? '未分類'}
                  >
                    <Folder size={17} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>
                        {project.workspaceOnly
                          ? `僅工作區 · ${project.path || '目錄待確認'}`
                          : project.path || '工作目錄未知'}
                      </small>
                    </span>
                    <span className="project-count">{project.sessionCount}</span>
                    {!project.exists && <AlertTriangle className="warning-icon" size={13} />}
                  </button>
                  <button
                    className={`project-pin ${project.pinned ? 'pinned' : ''}`}
                    aria-label={
                      project.pinned ? `取消釘選 ${project.name}` : `釘選 ${project.name}`
                    }
                    onClick={() =>
                      void api
                        .updateProject(project.id, { pinned: !project.pinned })
                        .then((result) =>
                          setProjects((previous) =>
                            previous.map((p) => (p.id === result.id ? result : p)),
                          ),
                        )
                        .catch(notify)
                    }
                  >
                    <Pin size={12} />
                  </button>
                </div>
              ))}
              {!sortedProjects.length && (
                <p className="sidebar-empty">
                  {projectSearch ? '沒有符合的專案' : '加入目錄，讓工作有個歸處。'}
                </p>
              )}
            </nav>
            <button
              className="add-project"
              disabled={!boot}
              onClick={() => setPathDialog({ path: '' })}
            >
              <FolderPlus size={16} />
              加入專案
            </button>
            <div className="sidebar-bottom">
              <span className="eyebrow">你的工作，留在本機</span>
              <p>搜尋與預覽不會啟動 Agent，也不會上傳對話。</p>
              <button onClick={() => setSettingsOpen(true)} disabled={!boot}>
                <CircleHelp size={14} />
                資料來源與支援範圍
                <ChevronRight size={14} />
              </button>
            </div>
          </aside>
        )}
        <main className="main-content">
          <div className="project-header">
            <div>
              <div className="breadcrumb">
                {!sidebarOpen && (
                  <button
                    className="icon-button"
                    aria-label="顯示側欄"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <Layers3 size={16} />
                  </button>
                )}
                Session Bay
                <ChevronRight size={12} />
                {current ? '專案' : '總覽'}
              </div>
              <h1>
                {current?.name ?? '所有 Session'}
                {current?.pinned && <Pin size={16} />}
              </h1>
              <div className="project-path">
                {current ? (
                  <>
                    <span title={current.path ?? ''}>
                      {current.launchPath || current.path || '未分類 · 未記錄工作目錄'}
                    </span>
                    {current.launchPath && <span title={current.path ?? ''}>· 已重新定位</span>}
                    <button
                      onClick={() =>
                        setPathDialog({
                          project: current,
                          path: current.launchPath || current.path || '',
                        })
                      }
                    >
                      重新定位
                    </button>
                  </>
                ) : (
                  '把散落的對話，接回你的工作。'
                )}
              </div>
            </div>
            <div className="header-buttons">
              <button
                className="secondary"
                disabled={!boot}
                onClick={() => runCommand('new-terminal')}
              >
                <TerminalSquare size={15} />
                Terminal
              </button>
              <button className="primary" disabled={!boot} onClick={() => runCommand('new-agent')}>
                <Plus size={15} />
                新增工作
                <ChevronDown size={13} />
              </button>
            </div>
          </div>
          {!desktop ? (
            <div className="runtime-unavailable">
              <div className="empty-icon">
                <Anchor size={35} />
              </div>
              <span className="eyebrow">SESSION BAY DESKTOP</span>
              <h2>你的本機工作台，等待啟航</h2>
              <p>目前是網頁預覽。專案、對話歷史與 Terminal 需要 macOS 或 Linux 桌面執行環境。</p>
              <div className="runtime-note">
                <AlertTriangle size={17} />
                <div>
                  <strong>桌面執行環境未連線</strong>
                  <span>請從桌面應用程式啟動；此預覽沒有模擬資料或程序。</span>
                </div>
              </div>
              <div className="runtime-features">
                <span>
                  <History size={16} />
                  找回跨 Agent 歷史
                </span>
                <span>
                  <Layers3 size={16} />
                  分割工作區
                </span>
                <span>
                  <TerminalSquare size={16} />
                  真正的本機 PTY
                </span>
              </div>
            </div>
          ) : bootError ? (
            <div className="empty-state">
              <AlertTriangle size={30} />
              <h2>無法開啟本機工作台</h2>
              <p role="alert">{bootError}</p>
              <button className="primary" onClick={() => void initialize()}>
                重新嘗試
              </button>
            </div>
          ) : !boot ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={30} />
              <p>正在讀取本機工作台…</p>
            </div>
          ) : (
            <>
              {current && !current.exists && (
                <div className="project-warning">
                  <AlertTriangle size={15} />
                  工作目錄不存在。歷史仍可閱讀，啟動前請重新定位。
                  <button
                    onClick={() =>
                      setPathDialog({
                        project: current,
                        path: current.launchPath || current.path || '',
                      })
                    }
                  >
                    選擇新位置
                  </button>
                </div>
              )}
              <div className="workspace-tabs">
                <button
                  className={view === 'history' ? 'active history-tab' : 'history-tab'}
                  onClick={() => setView('history')}
                >
                  <History size={14} />
                  歷史 Session
                </button>
                {workspace.tabs
                  .filter((t) => t.projectId === selectedId)
                  .map((tab) => (
                    <div
                      className={`workspace-tab ${view === 'workspace' && tab.id === activeTabId ? 'active' : ''}`}
                      key={tab.id}
                    >
                      <button
                        onClick={() => {
                          setWorkspace((w) => ({
                            ...w,
                            activeTabByProject: {
                              ...w.activeTabByProject,
                              [tab.projectId]: tab.id,
                            },
                          }));
                          setView('workspace');
                          setMaximizedId(null);
                        }}
                      >
                        <TerminalSquare size={13} />
                        {tab.name}
                        <span>{paneIds(tab.layout).length}</span>
                      </button>
                      <button
                        aria-label={`關閉分頁 ${tab.name}`}
                        onClick={() => removePanes(paneIds(tab.layout))}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                {current && (
                  <button
                    className="icon-button"
                    aria-label="新增工作區分頁"
                    onClick={() => openLauncher('shell')}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              <div className="main-work-area">
                <div
                  className="history-mount"
                  style={{ display: view === 'history' ? undefined : 'none' }}
                >
                  <HistoryView
                    projectId={selectedId}
                    projects={projects}
                    refreshToken={refreshToken}
                    onResume={resume}
                    onNew={() => openLauncher(settings?.defaultAgent ?? 'codex')}
                  />
                </div>
                {settings && (
                  <WorkspaceCanvas
                    workspace={workspace}
                    knownProjectIds={projects.map((project) => project.id)}
                    activeTabId={activeTabId}
                    settings={settings}
                    visible={view === 'workspace'}
                    maximizedId={maximizedId}
                    onPatch={patchPane}
                    onFocus={(id) => {
                      if (activeTab?.focusedPaneId !== id)
                        setWorkspace((w) => ({
                          ...w,
                          tabs: w.tabs.map((t) =>
                            t.id === activeTabId ? { ...t, focusedPaneId: id } : t,
                          ),
                        }));
                    }}
                    onStart={startPane}
                    onClose={(id) => removePanes([id])}
                    onMaximize={(id) => setMaximizedId(maximizedId === id ? null : id)}
                    onSplit={(id, axis) => openLauncher('shell', { paneId: id, axis })}
                    onRatio={(id, ratio) =>
                      setWorkspace((w) => ({
                        ...w,
                        tabs: w.tabs.map((t) =>
                          t.id === activeTabId
                            ? { ...t, layout: setRatio(t.layout, id, ratio) }
                            : t,
                        ),
                      }))
                    }
                    onAlreadyOpen={(newId, info) => {
                      if (workspace.panes[info.paneId]) {
                        setWorkspace((w) => closePane(w, newId));
                        focus(info.paneId);
                      } else
                        patchPane(newId, {
                          state: 'failed',
                          error:
                            '此 Session 已在受管程序中執行，但目前視圖無法重新附接。請先查看其他工作區。',
                        });
                    }}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <div>
          {index.running ? (
            <>
              <LoaderCircle className="spin" size={12} />
              <span>
                正在更新索引 {index.processed} / {index.total}
              </span>
              <button
                title="取消索引"
                aria-label="取消索引"
                onClick={() => void api.cancelScan().catch(notify)}
              >
                <Square size={10} />
              </button>
            </>
          ) : (
            <>
              <span className={`tiny-dot ${index.errors.length ? 'warn' : ''}`} />
              <span>
                {!desktop
                  ? '網頁預覽 · 桌面功能未連線'
                  : index.cancelled
                    ? '索引已取消'
                    : index.errors.length
                      ? `${index.errors.length} 個來源問題`
                      : '本機索引就緒'}
              </span>
              <button
                title="更新索引"
                aria-label="更新索引"
                disabled={!boot}
                onClick={() => void scan(false).catch(notify)}
              >
                <RefreshCw size={12} />
              </button>
            </>
          )}
        </div>
        <div>
          <span>{activeCount} 個執行中程序</span>
          <span className="status-separator">│</span>
          <span>
            {focusPane && view === 'workspace'
              ? `${focusPane.title} · ${focusPane.cwd}`
              : current
                ? `最近活動 ${dateLabel(current.updatedAt)}`
                : 'Codex + Claude Code'}
          </span>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="alert">
          <AlertTriangle size={17} />
          <span>{toast}</span>
          <button aria-label="關閉通知" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {settingsOpen && settings && boot && (
        <SettingsPanel
          settings={settings}
          installations={boot.installations}
          index={index}
          onboarding={!settings.onboardingComplete}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
          onScan={scan}
          onCancelScan={api.cancelScan}
          onClearIndex={async () => {
            await api.clearIndex();
            await refresh();
            setIndex(await api.index());
          }}
          onDetect={async () => {
            const installations = await api.detect();
            setBoot((b) => (b ? { ...b, installations } : b));
          }}
        />
      )}
      {pathDialog && (
        <Dialog
          title={pathDialog.project ? '重新定位專案目錄' : '加入專案'}
          onClose={() => !busy && setPathDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              const task = pathDialog.project
                ? api.updateProject(pathDialog.project.id, { launchPath: pathDialog.path.trim() })
                : api.addProject(pathDialog.path.trim());
              void task
                .then(async (project) => {
                  await refresh();
                  setSelectedId(project.id);
                  setView('history');
                  const session = pathDialog.resume;
                  setPathDialog(null);
                  if (session) resume(session, project);
                })
                .catch(notify)
                .finally(() => setBusy(false));
            }}
          >
            <p className="dialog-description">
              {pathDialog.project
                ? '只變更新程序的啟動位置。原始紀錄與工作目錄不會被修改。'
                : '輸入本機目錄的完整路徑。沒有歷史紀錄，也能開啟 Agent 或 Terminal。'}
            </p>
            {pathDialog.project?.path && (
              <p className="original-path">原始路徑：{pathDialog.project.path}</p>
            )}
            <label className="field-label">
              目錄路徑
              <input
                autoFocus
                required
                placeholder="/Users/you/projects/my-app 或 /home/you/projects/my-app"
                value={pathDialog.path}
                onChange={(event) => setPathDialog({ ...pathDialog, path: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setPathDialog(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy || !pathDialog.path.trim()}>
                {busy ? '儲存中…' : pathDialog.project ? '儲存新位置' : '加入專案'}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {launcher && settings && (
        <Dialog
          title={launcher.split ? '分割並新增面板' : '開始新的工作'}
          onClose={() => setLauncher(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (current) {
                addPane(
                  current,
                  launcher.kind,
                  launcher.cwd.trim(),
                  launcher.profileId,
                  undefined,
                  launcher.split,
                );
                setLauncher(null);
              }
            }}
          >
            <p className="dialog-description">
              在 {current?.name} 開始工作。Agent 沿用 CLI 本身的登入與權限設定。
            </p>
            <div className="launch-options">
              {(['codex', 'claude', 'shell'] as const).map((kind) => (
                <button
                  type="button"
                  className={launcher.kind === kind ? 'selected' : ''}
                  key={kind}
                  onClick={() => setLauncher({ ...launcher, kind })}
                >
                  {kind === 'shell' ? <TerminalSquare size={23} /> : <CommandIcon size={23} />}
                  <strong>{kind === 'shell' ? 'Terminal' : agentName(kind)}</strong>
                  <small>
                    {kind === 'shell'
                      ? '普通 Shell'
                      : boot?.installations.find((i) => i.kind === kind)?.available
                        ? '可啟動'
                        : '需設定 CLI'}
                  </small>
                  {launcher.kind === kind && <Check className="option-check" size={15} />}
                </button>
              ))}
            </div>
            <label className="field-label">
              工作目錄
              <input
                required
                value={launcher.cwd}
                onChange={(event) => setLauncher({ ...launcher, cwd: event.target.value })}
              />
            </label>
            {launcher.kind === 'shell' && (
              <label className="field-label">
                Shell Profile
                <select
                  value={launcher.profileId}
                  onChange={(event) => setLauncher({ ...launcher, profileId: event.target.value })}
                >
                  {settings.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.executable}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="small-muted">外部程序狀態未知。Session Bay 只管理自己啟動的程序。</p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setLauncher(null)}>
                取消
              </button>
              <button className="primary" disabled={!launcher.cwd.trim()}>
                開始工作
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {confirmation && (
        <Dialog title={confirmation.title} onClose={() => !busy && setConfirmation(null)}>
          <p className="dialog-description">{confirmation.text}</p>
          <div className="dialog-actions">
            <button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void confirmation
                  .action()
                  .then(() => setConfirmation(null))
                  .catch(notify)
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? '處理中…' : '結束並關閉'}
            </button>
          </div>
        </Dialog>
      )}
      {palette && (
        <Dialog title="命令面板" onClose={() => setPalette(false)}>
          <div className="palette-input">
            <Search size={18} />
            <input
              autoFocus
              aria-label="搜尋命令或專案"
              placeholder="輸入命令或專案名稱…"
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
            />
          </div>
          <div className="palette-results">
            {commands
              .filter(
                (c) =>
                  c.id !== 'command-palette' &&
                  c.label.toLowerCase().includes(paletteQuery.toLowerCase()),
              )
              .map((command) => (
                <button
                  disabled={command.disabled}
                  key={command.id}
                  onClick={() => {
                    setPalette(false);
                    command.run();
                  }}
                >
                  <span>{command.label}</span>
                  <kbd>{command.shortcut}</kbd>
                </button>
              ))}
            {visibleProjects
              .filter((p) =>
                `${p.name} ${p.path}`.toLowerCase().includes(paletteQuery.toLowerCase()),
              )
              .slice(0, 20)
              .map((project) => (
                <button
                  key={project.id}
                  onClick={() => {
                    setSelectedId(project.id);
                    setView('history');
                    setPalette(false);
                  }}
                >
                  <span>
                    <Folder size={14} />
                    {project.name}
                  </span>
                  <small>{project.path || '未分類'}</small>
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
