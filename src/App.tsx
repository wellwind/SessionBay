import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Anchor,
  ArrowRight,
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
  Square,
  Compass,
} from 'lucide-react';
import { api, errorMessage, isDesktop } from './api';
import { startup } from './startup';
import { agentCapabilities, agentKinds, bypassFlags, installationState } from './agents';
import { AgentIcon } from './components/AgentIcon';
import { Select } from './components/controls';
import type {
  AgentKind,
  Bootstrap,
  IndexStatus,
  LaunchPreview,
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
  patchWorkspacePane,
  restoreWorkspace,
  serializeWorkspace,
  setRatio,
  splitNode,
  uid,
} from './workspace';
import { matchesShortcut, normalizeLegacyShortcuts, shortcutConflicts, workspaceTabIndex, workspaceTabShortcutHelp } from './commands';
import type { Command } from './commands';
import { Dialog } from './components/Dialog';
import { ProjectDialog } from './components/ProjectDialog';
import { DirectoryPathField } from './components/DirectoryPathField';
import { DirectoryOverview } from './components/DirectoryOverview';
import { agentName, dateLabel, HistoryView } from './components/History';
import { SettingsPanel } from './components/SettingsPanel';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
interface Launcher {
  resumeId?: string;
  kind: 'shell' | AgentKind;
  cwd: string;
  profileId: string;
  split?: { paneId: string; axis: 'horizontal' | 'vertical' };
}
interface PathDialog {
  path: string;
  project?: Project;
  resume?: Session;
  curate?: boolean;
  launch?: { kind: Launcher['kind']; split?: Launcher['split'] };
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
  const [navigation, setNavigation] = useState<'projects' | 'directories'>('projects');
  const [allSessionsSearch, setAllSessionsSearch] = useState(false);
  const [view, setView] = useState<'history' | 'workspace'>('history');
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [index, setIndex] = useState<IndexStatus>(noIndex);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const detectionGeneration = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectSearch, setProjectSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<Launcher | null>(null);
  const [launchPreview, setLaunchPreview] = useState<LaunchPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialog | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ launchKind?: Launcher['kind'] } | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectMutation = useRef(false);
  const projectReadGeneration = useRef(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const ready = boot !== null;
  useEffect(() => startup.mounted(), []);
  useEffect(() => {
    if (ready && desktop) startup.ready();
  }, [ready, desktop]);
  const settings = boot?.settings;
  const theme = settings?.theme;
  const knownProjects = useRef<Record<string, Project>>({});
  for (const project of projects) knownProjects.current[project.id] = project;
  const visibleProjects = useMemo(
    () => mergeWorkspaceProjects(projects, workspace, knownProjects.current),
    [projects, workspace],
  );
  const current = visibleProjects.find((p) => p.id === selectedId);
  const launchProjectId = current && !current.workspaceOnly ? current.id : undefined;
  useEffect(() => {
    setLaunchPreview(null);
    setPreviewError('');
    if (!launcher || !settings) { setPreviewPending(false); return; }
    let cancelled = false;
    setPreviewPending(true);
    const timer = setTimeout(() => {
      void api.preview({ paneId: 'launch-preview', kind: launcher.kind, projectId: launchProjectId,
        cwd: launcher.cwd.trim(), profileId: launcher.profileId, resumeId: launcher.resumeId?.trim() || undefined,
        cols: 80, rows: 24 })
        .then((result) => { if (!cancelled) setLaunchPreview(result); })
        .catch((error) => { if (!cancelled) setPreviewError(errorMessage(error)); })
        .finally(() => { if (!cancelled) setPreviewPending(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [launcher, launchProjectId, settings]);
  const activeTabId = selectedId ? workspace.activeTabByProject[selectedId] : undefined;
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
  const focusPane = activeTab ? workspace.panes[activeTab.focusedPaneId] : undefined;
  useEffect(() => {
    if (selectedId && !visibleProjects.some((project) => project.id === selectedId)) {
      setSelectedId(undefined);
      setView('history');
    }
  }, [selectedId, visibleProjects]);
  useEffect(() => {
    if (view === 'workspace' && !activeTab) setView('history');
    if (maximizedId && !workspace.panes[maximizedId]) setMaximizedId(null);
  }, [view, activeTab, workspace.panes, maximizedId]);
  const stateRef = useRef({ workspace, selectedId, boot, view, navigation, projects: visibleProjects });
  stateRef.current = { workspace, selectedId, boot, view, navigation, projects: visibleProjects };
  const composing = useRef(false);
  useEffect(() => {
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composing.current || event.keyCode === 229 || document.querySelector('[role="dialog"]')) return;
      const current = stateRef.current;
      const tabs = current.workspace.tabs.filter((tab) => tab.projectId === current.selectedId);
      const active = current.view === 'workspace' ? tabs.findIndex((tab) => tab.id === current.workspace.activeTabByProject[current.selectedId ?? '']) : -1;
      const index = workspaceTabIndex(event, tabs.length, active);
      const reserved = index !== null || (tabs.length > 0 && workspaceTabIndex(event, 9, 0) !== null);
      if (!reserved) return;
      // Capture before xterm's textarea keydown so reserved tab keys never reach PTY.
      event.preventDefault();
      event.stopPropagation();
      if (index === null) return; // A reserved number beyond the open tabs is a no-op, never PTY input.
      setWorkspace((workspace) => ({ ...workspace, activeTabByProject: { ...workspace.activeTabByProject, [tabs[index].projectId]: tabs[index].id } }));
      setView('workspace');
      setMaximizedId(null);
    };
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
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
    const generation = ++projectReadGeneration.current;
    const result = await api.projects();
    if (generation === projectReadGeneration.current) {
      setProjects(result);
      setRefreshToken((t) => t + 1);
    }
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
      startup.backendError(errorMessage(error));
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
      setWorkspace((w) => patchWorkspacePane(w, id, patch)),
    [],
  );
  const focus = useCallback((id: string) => {
    const tab = stateRef.current.workspace.tabs.find((t) => paneIds(t.layout).includes(id));
    if (!tab) return;
    setSelectedId(tab.projectId);
    setAllSessionsSearch(false);
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
          (pane.sessionId ? project?.launchPath || pane.cwd || project?.path || '' : pane.cwd);
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
    resumeId?: string,
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
      resumeId,
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
    setAllSessionsSearch(false);
    setView('workspace');
    setMaximizedId(null);
  };
  const resume = (session: Session, override?: Project) => {
    if (session.resumeDisabledReason) {
      notify(session.resumeDisabledReason);
      return;
    }
    const existing = Object.values(workspace.panes).find((p) => p.sessionId === session.id);
    const project = override ?? visibleProjects.find((p) => p.id === session.projectId);
    const resumeCwd = project?.launchPath || session.cwd || existing?.cwd || project?.path || '';
    const needsLocation = !resumeCwd || (project && !project.path && !project.launchPath) || (project && !project.exists && resumeCwd === (project.launchPath || project.path));
    // The backend owns provider/source-qualified deduplication. A catalog ID can
    // survive a source-root change; never focus a live pane by catalog ID alone.
    if (existing && existing.projectId === project?.id && !['running', 'starting'].includes(existing.state)) {
      if (project && needsLocation) {
        setPathDialog({ project, path: project.launchPath || project.path || '', resume: session });
        return;
      }
      focus(existing.id);
      startPane(existing.id, resumeCwd);
      return;
    }
    if (!project) {
      notify('找不到 Session 所屬專案，請先重新整理索引。');
      return;
    }
    if (needsLocation) {
      setPathDialog({ project, path: project.launchPath || project.path || '', resume: session });
      return;
    }
    addPane(
      project,
      session.kind,
      resumeCwd,
      settings?.defaultProfileId ?? '',
      session,
    );
  };
  const openLauncher = (kind: Launcher['kind'], split?: Launcher['split']) => {
    if (!settings) return;
    if (!current) {
      setProjectDialog({ launchKind: kind });
      return;
    }
    if (!current.exists || !(current.launchPath || current.path)) {
      setPathDialog({ project: current, path: current.launchPath || current.path || '', launch: { kind, split } });
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
    () => normalizeLegacyShortcuts(settings?.shortcuts ?? {}),
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
      label: current ? '搜尋此目錄的工作階段' : '搜尋所有工作階段',
      run: () => {
        if (!current) {
          setNavigation('directories');
          setAllSessionsSearch(true);
        }
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
      if (event.defaultPrevented || event.isComposing || composing.current || event.keyCode === 229 || document.querySelector('[role="dialog"]'))
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
  const detectAgents = async () => {
    const generation = ++detectionGeneration.current;
    try {
      const installations = await api.detect();
      if (generation === detectionGeneration.current)
        setBoot((b) => (b ? { ...b, installations } : b));
    } catch (error) {
      if (generation === detectionGeneration.current) throw error;
    }
  };
  const saveSettings = async (next: Settings) => {
    const first = !settings?.onboardingComplete;
    ++detectionGeneration.current;
    const saved = await api.saveSettings(next);
    setBoot((b) => (b ? { ...b, settings: saved, installations: [] } : b));
    setSettingsOpen(false);
    void detectAgents().catch(notify);
    if (first) void scan(false).catch(notify);
  };
  const saveMembership = async (project: Project, curated: boolean) => {
    if (projectMutation.current) return;
    if (curated && !project.path && !project.launchPath) {
      setPathDialog({ project, path: '', curate: true });
      return;
    }
    projectMutation.current = true;
    setProjectBusy(true);
    try {
      const result = await api.updateProject(project.id, { curated });
      projectReadGeneration.current++;
      setProjects((previous) => previous.map((p) => p.id === result.id ? result : p));
      if (!curated && stateRef.current.navigation === 'projects' && stateRef.current.selectedId === project.id &&
          !stateRef.current.workspace.tabs.some((tab) => tab.projectId === project.id)) {
        setSelectedId(undefined);
        setView('history');
      }
    } catch (error) { notify(error); }
    finally { projectMutation.current = false; setProjectBusy(false); }
  };
  const setPinned = async (project: Project) => {
    if (projectMutation.current) return;
    projectMutation.current = true;
    setProjectBusy(true);
    try {
      const result = await api.updateProject(project.id, { pinned: !project.pinned });
      projectReadGeneration.current++;
      setProjects((previous) => previous.map((p) => p.id === result.id ? result : p));
    } catch (error) { notify(error); }
    finally { projectMutation.current = false; setProjectBusy(false); }
  };
  const curateSession = (session: Session) => {
    const project = projects.find((p) => p.id === session.projectId);
    if (project) void saveMembership(project, true);
    else notify('找不到工作目錄，請先重新整理索引。');
  };
  const sortedProjects = [...projects]
    .filter((p) => navigation === 'projects' ? p.curated : p.sessionCount > 0)
    .filter((p) => `${p.name} ${p.path ?? ''}`.toLowerCase().includes(projectSearch.toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
        a.name.localeCompare(b.name),
    );
  const selectNavigation = (page: 'projects' | 'directories') => {
    setNavigation(page);
    setSelectedId(undefined);
    setAllSessionsSearch(false);
    setProjectSearch('');
    setView('history');
    setMaximizedId(null);
  };
  const selectProject = (project: Project) => {
    setSelectedId(project.id);
    setAllSessionsSearch(false);
    setView('history');
    setMaximizedId(null);
  };
  const navigationName = navigation === 'projects' ? '專案' : '所有目錄';
  const projectCount = projects.filter((project) => project.curated).length;
  const directoryCount = projects.filter((project) => project.sessionCount > 0).length;
  const activeCount = Object.values(workspace.panes).filter(
    (p) => p.state === 'running' || p.state === 'starting',
  ).length;
  return (
    <div className="app-shell" data-app-shell data-backend-ready={ready && desktop}>
      <a className="skip-link" href="#main-workspace">跳至主要工作區</a>
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">
            <Anchor size={22} />
          </div>
          <span>
            Session Bay<span className="brand-tag">WORKSPACE</span>
          </span>
        </div>
        <div className="navigation-tabs" role="tablist" aria-label="導覽頁面">
            {(['projects', 'directories'] as const).map((page) => <button key={page} type="button"
              id={`navigation-${page}`} role="tab" aria-selected={navigation === page}
              tabIndex={navigation === page ? 0 : -1} aria-controls="navigation-content"
              onClick={() => selectNavigation(page)} onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const next = event.key === 'Home' ? 'projects' : event.key === 'End' ? 'directories'
                    : page === 'projects' ? 'directories' : 'projects';
                  selectNavigation(next);
                  document.getElementById(`navigation-${next}`)?.focus();
                }
              }}>
              {page === 'projects' ? <Folder size={16} aria-hidden="true" /> : <Compass size={16} aria-hidden="true" />}
              {page === 'projects' ? '專案' : '所有目錄'}
              <span>{page === 'projects' ? projectCount : directoryCount}</span>
            </button>)}
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
              className={`sidebar-global ${selectedId === undefined && !allSessionsSearch ? 'active' : ''}`}
              onClick={() => selectNavigation(navigation)}
            >
              <Compass size={17} />
              {navigation === 'projects' ? '專案總覽' : '目錄總覽'}<span>{navigation === 'projects' ? projectCount : directoryCount}</span>
            </button>
            <div className="sidebar-section">
              <span>{navigationName}</span>
              <button
                className="icon-button"
                title="加入專案"
                aria-label="加入專案"
                disabled={!boot}
                onClick={() => setProjectDialog({})}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="project-search search-field">
              <Search size={13} />
              <input
                aria-label={navigation === 'projects' ? '搜尋專案' : '搜尋所有目錄'}
                placeholder={navigation === 'projects' ? '尋找專案…' : '尋找目錄…'}
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </div>
            <nav className="project-list" aria-label={navigationName}>
              {sortedProjects.map((project) => (
                <div
                  key={project.id}
                  className={`project-row ${selectedId === project.id ? 'active' : ''}`}
                >
                  <button
                    className="project-main"
                    onClick={() => selectProject(project)}
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
                  {project.curated && <button
                    className={`project-pin ${project.pinned ? 'pinned' : ''}`}
                    aria-label={
                      project.pinned ? `取消置頂 ${project.name}` : `置頂 ${project.name}`
                    }
                    disabled={projectBusy}
                    onClick={() => void setPinned(project)}
                  >
                    <Pin size={12} />
                  </button>}
                </div>
              ))}
              {!sortedProjects.length && (
                <p className="sidebar-empty">
                  {projectSearch ? `沒有符合的${navigationName}` : navigation === 'projects'
                    ? '尚未加入專案。可從所有目錄挑選，或加入／建立專案。'
                    : '尚未找到包含工作階段的目錄。請確認資料來源並更新索引。'}
                </p>
              )}
            </nav>
            <button
              className="add-project"
              disabled={!boot}
              onClick={() => setProjectDialog({})}
            >
              <FolderPlus size={16} />
              加入／建立專案
            </button>
            {workspace.tabs.length > 0 && (
              <section className="open-workspaces" aria-label="開啟中的工作區">
                <div className="sidebar-section"><span>開啟中的工作區</span><span>{workspace.tabs.length}</span></div>
                <nav>
                  {workspace.tabs.map((tab) => {
                    const project = visibleProjects.find((p) => p.id === tab.projectId);
                    return <button key={tab.id} className={view === 'workspace' && activeTabId === tab.id ? 'active' : ''}
                      aria-label={`開啟工作區 ${project?.name || '工作目錄'} ${tab.name}`}
                      title={project?.launchPath || project?.path || '目錄待確認'} onClick={() => focus(tab.focusedPaneId)}>
                      <TerminalSquare size={14} /><span><strong>{project?.name || '工作目錄'}</strong>
                        <small>{tab.name}{project?.workspaceOnly ? ' · 僅工作區' : ''}</small></span>
                    </button>;
                  })}
                </nav>
              </section>
            )}
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
        <main className="main-content" id="main-workspace" tabIndex={-1}>
          <div className="project-header">
            <div>
              <nav className="breadcrumb" aria-label="目前位置">
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
                {current || allSessionsSearch ? <button className="breadcrumb-back" onClick={() => selectNavigation(navigation)}>{navigationName}</button> : <span aria-current="page">{navigationName}</span>}
                {current && <><ChevronRight size={12} /><span aria-current="page">{current.name}</span></>}
                {allSessionsSearch && !current && <><ChevronRight size={12} /><span aria-current="page">搜尋所有工作階段</span></>}
              </nav>
              <h1>
                {current?.name ?? (allSessionsSearch ? '搜尋所有工作階段' : navigationName)}
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
                  navigation === 'projects' ? '管理你選入的專案，專注在真正有意義的工作。'
                    : '保留所有工作階段的目錄分組。選擇目錄瀏覽對話，或加入專案。'
                )}
              </div>
            </div>
            <div className="header-buttons">
              {navigation === 'directories' && !current && <button className="secondary" disabled={!boot}
                onClick={() => { setAllSessionsSearch((value) => !value); setView('history'); }}>
                {allSessionsSearch ? <Folder size={15} /> : <Search size={15} />}
                {allSessionsSearch ? '返回目錄總覽' : '搜尋所有工作階段'}
              </button>}
              {current && !current.workspaceOnly && <button className="secondary" disabled={projectBusy}
                title={current.curated ? '只移出專案清單，不刪除對話、檔案或關閉程序' : '將這個工作目錄加入專案清單'}
                onClick={() => void saveMembership(current, !current.curated)}>
                {current.curated ? '移出專案' : '加入專案'}
              </button>}
              {current ? <>
                <button className="secondary" onClick={() => runCommand('new-terminal')}>
                  <TerminalSquare size={16} />Terminal
                </button>
                <button className="primary" onClick={() => runCommand('new-agent')}>
                  <Plus size={16} />新增工作
                </button>
              </> : <button className="primary" disabled={!boot} onClick={() => setProjectDialog({})}>
                <FolderPlus size={16} />加入／建立專案
              </button>}
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
              {(current || allSessionsSearch) && <div className="workspace-tabs" title={workspaceTabShortcutHelp}>
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
              </div>}
              <div className="main-work-area" id="navigation-content" role="tabpanel" aria-labelledby={`navigation-${navigation}`}>
                <div
                  className="history-mount"
                  style={{ display: view === 'history' ? undefined : 'none' }}
                >
                  {current || allSessionsSearch ? <HistoryView
                    projectId={selectedId}
                    projects={projects}
                    refreshToken={refreshToken}
                    onResume={resume}
                    onCurate={curateSession}
                    curating={projectBusy}
                    onNew={() => openLauncher(settings?.defaultAgent ?? 'codex')}
                  /> : <DirectoryOverview page={navigation} projects={sortedProjects} searching={!!projectSearch}
                    busy={projectBusy} onSelect={selectProject} onMembership={saveMembership}
                    onAdd={() => setProjectDialog({})} onDirectories={() => selectNavigation('directories')} />}
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
                : '本機 Agent 工作台'}
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
          onDetectShells={api.detectShells}
          onDetectHistorySources={api.detectHistorySources}
          onDetect={detectAgents}
        />
      )}
      {projectDialog && <ProjectDialog onClose={() => setProjectDialog(null)} onSaved={async (project) => {
        await refresh();
        setNavigation('projects');
        setAllSessionsSearch(false);
        setSelectedId(project.id);
        setView('history');
        if (projectDialog.launchKind && settings) setLauncher({ kind: projectDialog.launchKind,
          cwd: project.launchPath || project.path || '', profileId: settings.defaultProfileId });
        setProjectDialog(null);
      }} />}
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
                ? api.updateProject(pathDialog.project.id, { launchPath: pathDialog.path.trim(), ...(pathDialog.curate ? { curated: true } : {}) })
                : api.addProject(pathDialog.path.trim());
              void task
                .then(async (project) => {
                  await refresh();
                  setAllSessionsSearch(false);
                  setSelectedId(project.id);
                  setView('history');
                  const session = pathDialog.resume;
                  setPathDialog(null);
                  if (session) resume(session, project);
                  else if (pathDialog.launch && settings) setLauncher({ ...pathDialog.launch,
                    cwd: project.launchPath || project.path || '', profileId: settings.defaultProfileId });
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
            <DirectoryPathField key={pathDialog.project?.id ?? 'new'} label="目錄路徑"
              autoFocus required disabled={busy}
              placeholder="/Users/you/projects/my-app 或 /home/you/projects/my-app"
              value={pathDialog.path}
              onChange={(path) => setPathDialog((current) => current ? { ...current, path } : null)} />
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
              if (current && launchPreview && !previewPending && !previewError && (launcher.kind === 'shell' || boot?.installations.find((item) => item.kind === launcher.kind)?.available !== false)) {
                addPane(
                  current,
                  launcher.kind,
                  launcher.cwd.trim(),
                  launcher.profileId,
                  undefined,
                  launcher.split,
                  launcher.resumeId?.trim() || undefined,
                );
                setLauncher(null);
              }
            }}
          >
            <p className="dialog-description">
              在 {current?.name} 開始工作。Agent 沿用 CLI 本身的登入與權限設定。
            </p>
            <div className="launch-kind-switch" role="group" aria-label="工作類型">
              <button type="button" aria-pressed={launcher.kind === 'shell'}
                onClick={() => setLauncher({ ...launcher, kind: 'shell', resumeId: undefined })}>
                <TerminalSquare size={19} />Shell<span>命令列工作</span>
              </button>
              <button type="button" aria-pressed={launcher.kind !== 'shell'}
                onClick={() => setLauncher({ ...launcher, kind: settings.defaultAgent, resumeId: undefined })}>
                <CommandIcon size={19} />Agent<span>AI 協作</span>
              </button>
            </div>
            {launcher.kind !== 'shell' && <label className="field-label">
              Agent
              <Select aria-label="Agent" value={launcher.kind}
                onChange={(kind) => setLauncher({ ...launcher, kind: kind as AgentKind, resumeId: undefined })}
                options={agentKinds.map((kind) => {
                  const installation = boot?.installations.find((item) => item.kind === kind);
                  return { value: kind, label: agentName(kind), icon: <AgentIcon kind={kind} />,
                    disabled: installation?.available === false,
                    description: installationState(installation).text };
                })} />
              {boot?.installations.find((item) => item.kind === launcher.kind)?.available === false &&
                <span className="inline-warning">未偵測到這個 Agent，請先在設定中指定執行檔並重新偵測。</span>}
            </label>}
            <DirectoryPathField key={`${current?.id}:${launcher.kind}`} label="工作目錄"
              required value={launcher.cwd}
              onChange={(cwd) => setLauncher((current) => current ? { ...current, cwd } : null)} />
            {launcher.kind !== 'shell' && agentCapabilities[launcher.kind].resume.manualId && (
              <label className="field-label">接續對話 ID（選填）
                <input value={launcher.resumeId || ''} placeholder="留空開始新對話；填入原工具的對話 ID"
                  onChange={(event) => setLauncher({ ...launcher, resumeId: event.target.value })} />
                <span className="small-muted">{agentCapabilities[launcher.kind].resume.description}
                  {!agentCapabilities[launcher.kind].history.supported && ' 尚不支援自動索引／預覽其歷史。'}</span>
              </label>
            )}
            {launcher.kind === 'shell' && (
              <label className="field-label">
                Shell Profile
                <Select aria-label="Shell Profile" value={launcher.profileId}
                  onChange={(profileId) => setLauncher({ ...launcher, profileId })}
                  options={settings.profiles.map((profile) => ({ value: profile.id,
                    label: profile.name, description: profile.executable }))} />
              </label>
            )}
            <div className="launch-preview" aria-label="啟動參數預覽" aria-live="polite">
              <strong>實際啟動預覽</strong>
              {previewPending ? <p>正在檢查執行檔與目錄…</p> : previewError ? <p role="alert">{previewError}</p> : launchPreview && <>
                <pre>{JSON.stringify([launchPreview.executable, ...launchPreview.args], null, 2)}</pre>
                <p>工作目錄：{launchPreview.cwd}</p>
              </>}
            </div>
            {launcher.kind !== 'shell' && settings.agentOptions?.[launcher.kind]?.bypassPermissions &&
              <p className="inline-warning">已啟用高風險權限模式。預設 {bypassFlags[launcher.kind]}；實際參數以上方預覽為準。Agent 可能不詢問就讀寫或刪除檔案。</p>}
            <p className="small-muted">外部程序狀態未知。Session Bay 只管理自己啟動的程序。</p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setLauncher(null)}>
                取消
              </button>
              <button className="primary" disabled={!launcher.cwd.trim() || previewPending || !launchPreview || !!previewError || (launcher.kind !== 'shell' && boot?.installations.find((item) => item.kind === launcher.kind)?.available === false)}>
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
          <div className="palette-input search-field">
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
            {projects.filter((p) => p.curated)
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
