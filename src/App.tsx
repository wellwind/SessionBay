import { AgentStatusOverview } from './components/AgentStatusOverview';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Anchor,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  CircleHelp,
  Command as CommandIcon,
  Folder,
  FolderPlus,
  FolderMinus,
  Trash2,
  History,
  Layers3,
  LoaderCircle,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  TerminalSquare,
  X,
  AlertTriangle,
  Square,
  Compass,
  Palette,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { api, errorMessage, isDesktop } from './api';
import { SidebarProjectList } from './components/SidebarProjectList';
import { legacyProjectOrder, readSidebarPreferences, reconcileProjectOrder, reorderProject, saveSidebarPreferences } from './sidebar-preferences';
import type { SidebarPreferences } from './sidebar-preferences';
import { startup } from './startup';
import './workspace-focus.css';
import { resumedTabName } from './display-name';
import { acceptsWorkspaceZoomShortcut, nextWorkspaceZoom, workspaceZoomShortcut, workspaceZoomShortcutHelp, WorkspaceZoomController } from './workspace-zoom';
import { agentCapabilities, agentKinds, bypassFlags, installationState, isAgentEnabled, preferredEnabledAgent } from './agents';
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
  activeWorkspaceTabId,
  selectWorkspaceTab,
  closePane,
  closeSuccessfulShell,
  closeConfirmedPane,
  isSuccessfulShellExit,
  emptyWorkspace,
  mergeWorkspaceProjects,
  paneIds,
  patchWorkspacePane,
  restoreWorkspace,
  reconcileRuntimes,
  renameWorkspaceTab,
  reorderWorkspaceTab,
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
import { RenameDialog } from './components/RenameDialog';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { DirectoryOverview } from './components/DirectoryOverview';
import { agentName, dateLabel, HistoryView } from './components/History';
import { SessionTrash } from './components/SessionTrash';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemeControls, TerminalPreview } from './components/ThemeControls';
import { appearanceOf } from './themes';
import { AppearanceSaveQueue } from './appearance-save-queue';
import { CommandPalette } from './components/CommandPalette';
import { CommandThemePicker } from './components/CommandThemePicker';
import type { ThemePatch, ThemeTarget } from './components/CommandThemePicker';
import type { Appearance } from './themes';
import { useUiTheme } from './use-ui-theme';
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
  onCancel?: () => void;
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
  const [trashOpen, setTrashOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null | undefined>();
  const [navigation, setNavigation] = useState<'projects' | 'directories'>('projects');
  const [allSessionsSearch, setAllSessionsSearch] = useState(false);
  const [view, setView] = useState<'history' | 'workspace'>('history');
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [index, setIndex] = useState<IndexStatus>(noIndex);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearancePreview, setAppearancePreview] = useState<Partial<Appearance> | null>(null);
  const [quickThemeOpen, setQuickThemeOpen] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeSaveError, setThemeSaveError] = useState('');
  const themeSaveInFlight = useRef(false);
  const quickAppearanceRequests = useRef(0);
  const quickAppearanceCurrent = useRef<Partial<Appearance> | null>(null);
  const quickThemeOpenRef = useRef(false);
  quickThemeOpenRef.current = quickThemeOpen;
  const detectionGeneration = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Presentation only: never replace the canvas or change serialized workspace state.
  const [focusMode, setFocusMode] = useState(false);
  const [focusControlsOpen, setFocusControlsOpen] = useState(false);
  const focusToggle = useRef<HTMLButtonElement>(null);
  const focusRestore = useRef({ generation: 0, frame: 0 });
  useEffect(() => () => {
    focusRestore.current.generation++;
    cancelAnimationFrame(focusRestore.current.frame);
  }, []);
  const [sidebar, setSidebar] = useState(readSidebarPreferences);
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  const updateSidebar = (patch: Partial<SidebarPreferences>) => {
    const next = { ...sidebarRef.current, ...patch };
    sidebarRef.current = next;
    setSidebar(next);
    try { saveSidebarPreferences(next); }
    catch { setToast('側欄偏好無法儲存；本次變更仍有效，重新開啟後可能還原。'); }
  };
  useEffect(() => {
    if (!boot) return;
    const current = sidebarRef.current;
    const projectOrder = reconcileProjectOrder(current.projectOrder, projects);
    if (projectOrder === current.projectOrder) return;
    const next = { ...current, projectOrder };
    sidebarRef.current = next;
    setSidebar(next);
    try { saveSidebarPreferences(next); }
    catch { setToast('專案順序無法儲存；重新開啟後可能還原。'); }
  }, [boot, projects]);
  const [projectSearch, setProjectSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<Launcher | null>(null);
  const [launchPreview, setLaunchPreview] = useState<LaunchPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewPending, setPreviewPending] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialog | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ launchKind?: Launcher['kind'] } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: 'tab' | 'project'; id: string; name: string } | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const projectMutation = useRef(false);
  const projectReadGeneration = useRef(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteTheme, setPaletteTheme] = useState<ThemeTarget | null>(null);
  const [commandThemePreview, setCommandThemePreview] = useState<ThemePatch | null>(null);
  const paletteGeneration = useRef(0);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const paletteWasOpen = useRef(false);
  useEffect(() => {
    if (paletteWasOpen.current && !palette && paletteOpener.current?.isConnected) paletteOpener.current.focus();
    paletteWasOpen.current = palette;
  }, [palette]);
  const closePaletteTheme = () => {
    paletteGeneration.current++;
    setPaletteTheme(null);
    setCommandThemePreview(null);
    setThemeSaveError('');
  };
  const closePalette = () => { closePaletteTheme(); setPalette(false); };

  const ready = boot !== null;
  useEffect(() => startup.mounted(), []);
  useEffect(() => {
    if (ready && desktop) startup.ready();
  }, [ready, desktop]);
  const settings = boot?.settings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const visibleSettings = useMemo(() => settings ? { ...settings, ...appearancePreview, ...commandThemePreview } : undefined, [settings, appearancePreview, commandThemePreview]);
  useUiTheme(visibleSettings);
  const [appliedZoom, setAppliedZoom] = useState<number | null>(null);
  const [zoomError, setZoomError] = useState(false);
  const [zoomController] = useState(() => new WorkspaceZoomController(api.setWorkspaceZoom, (percent) => { setAppliedZoom(percent); setZoomError(false); }));
  const [appearanceQueue] = useState(() => new AppearanceSaveQueue({
    getSettings: () => settingsRef.current,
    save: api.saveSettings,
    beforeSave: (patch) => {
      // A color-only save must never restore an obsolete native zoom snapshot.
      if (patch.appZoom !== undefined && !zoomController.isApplied(patch.appZoom))
        return zoomController.apply(patch.appZoom);
    },
    committed: (patch) => {
      settingsRef.current = { ...settingsRef.current!, ...patch };
      setBoot(current => current ? { ...current, settings: { ...current.settings, ...patch } } : current);
    },
    busy: (saving) => { themeSaveInFlight.current = saving; setThemeSaving(saving); },
  }));
  const zoomPercent = visibleSettings?.appZoom ?? 100;
  const hasSettings = !!settings;
  useEffect(() => {
    if (!desktop || !hasSettings) return;
    let cancelled = false;
    setZoomError(false);
    void zoomController.apply(zoomPercent).catch((error) => {
      if (!cancelled) { setZoomError(true); setToast(errorMessage(error)); }
    });
    return () => { cancelled = true; };
  }, [desktop, hasSettings, zoomPercent, zoomController]);
  const knownProjects = useRef<Record<string, Project>>({});
  for (const project of projects) knownProjects.current[project.id] = project;
  const visibleProjects = useMemo(
    () => mergeWorkspaceProjects(projects, workspace, knownProjects.current),
    [projects, workspace],
  );
  const temporaryWorkspace = selectedId === null;
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
  const activeTabId = activeWorkspaceTabId(workspace, selectedId);
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
  const focusPane = activeTab ? workspace.panes[activeTab.focusedPaneId] : undefined;
  const focusAvailable = !!current || temporaryWorkspace;
  const compactWorkspace = focusMode && focusAvailable && !focusControlsOpen;
  const revealSidebar = focusMode && focusControlsOpen;
  const restoreWorkspaceFocus = () => {
    const owner = document.activeElement;
    const paletteOwner = !!owner?.closest('.palette-input, .palette-results');
    const chromeOwner = !!owner?.closest('.app-topbar, .sidebar, .project-header, .statusbar');
    const paletteReturnTarget = paletteOwner ? paletteOpener.current : null;
    const generation = ++focusRestore.current.generation;
    cancelAnimationFrame(focusRestore.current.frame);
    focusRestore.current.frame = requestAnimationFrame(() => {
      const latest = stateRef.current;
      const latestTab = latest.workspace.tabs.find((tab) => tab.id === activeWorkspaceTabId(latest.workspace, latest.selectedId));
      // Known chrome may be removed or CSS-hidden; only neutral focus can transfer from it.
      // A closed palette may also restore its own opener before this frame runs.
      const active = document.activeElement;
      const neutralOwnerTransfer = owner && (paletteOwner || chromeOwner) &&
        (!owner.isConnected || (chromeOwner && owner.getClientRects().length === 0)) &&
        (active === document.body || (paletteOwner && !owner.isConnected && active === paletteReturnTarget));
      // A newer input, navigation, modal or toggle owns focus; never redirect its typing to PTY.
      if (generation !== focusRestore.current.generation || (active !== owner && !neutralOwnerTransfer) ||
        latest.selectedId !== selectedId || latest.view !== view || latestTab?.id !== activeTabId ||
        latestTab?.focusedPaneId !== activeTab?.focusedPaneId || document.querySelector('[role="dialog"]')) return;
      const terminal = [...document.querySelectorAll<HTMLTextAreaElement>('.terminal-pane.focused .xterm-helper-textarea')]
        .find((element) => element.getClientRects().length > 0);
      if (view === 'workspace' && terminal) terminal.focus({ preventScroll: true });
      else focusToggle.current?.focus({ preventScroll: true });
    });
  };
  const toggleFocusMode = () => {
    setFocusMode((value) => !value);
    setFocusControlsOpen(false);
    restoreWorkspaceFocus();
  };
  useEffect(() => {
    if (selectedId && !visibleProjects.some((project) => project.id === selectedId)) {
      setSelectedId(undefined);
      setView('history');
    }
  }, [selectedId, visibleProjects]);
  useEffect(() => {
    if (view === 'workspace' && !activeTab && !temporaryWorkspace) setView('history');
    if (maximizedId && !workspace.panes[maximizedId]) setMaximizedId(null);
  }, [view, activeTab, workspace.panes, maximizedId, temporaryWorkspace]);
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
      const active = current.view === 'workspace' ? tabs.findIndex((tab) => tab.id === activeWorkspaceTabId(current.workspace, current.selectedId)) : -1;
      const index = workspaceTabIndex(event, tabs.length, active);
      const reserved = index !== null || (tabs.length > 0 && workspaceTabIndex(event, 9, 0) !== null);
      if (!reserved) return;
      // Capture before xterm's textarea keydown so reserved tab keys never reach PTY.
      event.preventDefault();
      event.stopPropagation();
      if (index === null) return; // A reserved number beyond the open tabs is a no-op, never PTY input.
      setWorkspace((workspace) => selectWorkspaceTab(workspace, tabs[index]));
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
  const nativeCloseSealed = useRef(false);
  const shellCleanupPending = useRef(new Map<string, Promise<void>>());
  const cleanedShells = useRef(new Map<string, Pane>());
  const pendingPaneClosures = useRef(new Set<Promise<void>>());
  const closedPaneSnapshots = useRef(new Map<string, Pane>());
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
      const saved = restoreWorkspace(data.workspace);
      const restored = reconcileRuntimes(saved, data.runtimes ?? []);
      observedWorkspace.current = JSON.stringify(serializeWorkspace(saved));
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
    const action = async () => {
      closingApp.current = true;
      try {
        if (stateRef.current.boot) {
          await saveQueue.current;
          // Forget and layout persistence form one close operation. Project
          // successful cleanups into the snapshot even before React commits.
          const snapshotNow = () => serializeWorkspace([...cleanedShells.current.values()]
            .reduce(closeSuccessfulShell, [...closedPaneSnapshots.current.values()]
              .reduce(closeConfirmedPane, stateRef.current.workspace)));
          for (;;) {
            await Promise.all([...shellCleanupPending.current.values(), ...pendingPaneClosures.current].map((task) => task.catch(() => undefined)));
            const snapshot = snapshotNow();
            const signature = JSON.stringify(snapshot);
            if (signature !== persistedWorkspace.current) {
              await api.saveWorkspace(snapshot);
              persistedWorkspace.current = signature;
            }
            if (!shellCleanupPending.current.size && !pendingPaneClosures.current.size && JSON.stringify(snapshotNow()) === signature) break;
          }
        }
        nativeCloseSealed.current = true;
        await api.close();
      } catch (error) {
        nativeCloseSealed.current = false;
        closingApp.current = false;
        setWorkspace((current) => ({ ...current }));
        throw error;
      }
    };
    if (!closingApp.current) void action().catch(notify);
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
  const forgettingShells = useRef(new Set<string>());
  useEffect(() => {
    // After the final snapshot, retain newly exited broker records for startup
    // reconciliation; forgetting them now would resurrect saved placeholders.
    if (nativeCloseSealed.current) return;
    for (const [key, target] of closedPaneSnapshots.current) {
      const current = workspace.panes[target.id];
      if (!current || current.startToken !== target.startToken ||
        (target.runtimeId && current.runtimeId !== target.runtimeId)) closedPaneSnapshots.current.delete(key);
    }
    const referenced = new Set(Object.values(workspace.panes).map((pane) => pane.runtimeId));
    for (const id of forgettingShells.current) {
      if (!referenced.has(id) && !shellCleanupPending.current.has(id)) {
        forgettingShells.current.delete(id);
        cleanedShells.current.delete(id);
      }
    }
    for (const pane of Object.values(workspace.panes)) {
      if (!isSuccessfulShellExit(pane) || forgettingShells.current.has(pane.runtimeId!)) continue;
      forgettingShells.current.add(pane.runtimeId!);
      // Forget only this completed runtime. Never use the manual close path,
      // which settles launches and stops processes by pane ID.
      const cleanup = api.forget(pane.runtimeId!).then(() => {
        cleanedShells.current.set(pane.runtimeId!, pane);
        setWorkspace((current) => closeSuccessfulShell(current, pane));
      }).catch(notify).finally(() => { shellCleanupPending.current.delete(pane.runtimeId!); });
      shellCleanupPending.current.set(pane.runtimeId!, cleanup);
    }
  }, [workspace, notify]);
  const focus = useCallback((id: string) => {
    const tab = stateRef.current.workspace.tabs.find((t) => paneIds(t.layout).includes(id));
    if (!tab) return;
    setSelectedId(tab.projectId);
    setAllSessionsSearch(false);
    setView('workspace');
    setMaximizedId(null);
    setWorkspace((w) => ({
      ...selectWorkspaceTab(w, tab),
      tabs: w.tabs.map((t) => (t.id === tab.id ? { ...t, focusedPaneId: id } : t)),
    }));
  }, []);
  const startPane = useCallback(
    (id: string, cwdOverride?: string) =>
      setWorkspace((w) => {
        const pane = w.panes[id];
        if (!pane || ['running', 'starting', 'disconnected'].includes(pane.state)) return w;
        const project = stateRef.current.projects.find((p) => p.id === pane.projectId);
        const cwd =
          cwdOverride ??
          (pane.sessionId ? project?.launchPath || pane.cwd || project?.path || '' : pane.cwd);
        return {
          ...w,
          panes: { ...w.panes, [id]: { ...pane, cwd, runtimeId: undefined, startToken: (pane.startToken ?? 0) + 1 } },
        };
      }),
    [],
  );
  const addPane = (
    project: Project | null,
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
    const projectId = project?.id ?? null;
    const pane: Pane = {
      id,
      kind,
      title:
        session?.title ||
        (kind === 'shell'
          ? settings?.profiles.find((p) => p.id === profileId)?.name || 'Terminal'
          : `${agentName(kind)} 工作`),
      projectId,
      cwd,
      homeDirectory: projectId === null && kind === 'shell' && cwd === '',
      profileId,
      sessionId: session?.id,
      resumeId,
      state: 'placeholder',
      startToken: 1,
    };
    setWorkspace((w) => {
      const tab = split ? w.tabs.find((t) => paneIds(t.layout).includes(split.paneId)) : undefined;
      if (tab && split && tab.projectId === projectId)
        return {
          ...selectWorkspaceTab(w, tab),
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
        };
      const tabId = uid();
      let name = resumedTabName(session?.title) ?? (kind === 'shell' ? 'Terminal' : agentName(kind));
      if (projectId === null) {
        let number = 1;
        while (w.tabs.some((tab) => tab.projectId === null && tab.name === `Terminal ${number}`)) number++;
        name = `Terminal ${number}`;
      }
      const newTab = { id: tabId, projectId, name, focusedPaneId: id,
        layout: { kind: 'pane' as const, paneId: id } };
      return selectWorkspaceTab({ ...w, panes: { ...w.panes, [id]: pane }, tabs: [...w.tabs, newTab] }, newTab);
    });
    setSelectedId(projectId);
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
    if (existing?.state === 'disconnected' && existing.projectId === project?.id) {
      focus(existing.id);
      return;
    }
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
  const openTemporaryTerminal = (split?: Launcher['split']) => {
    if (!settings) return;
    // Empty cwd is intentional. Rust resolves home; saved paths never override it.
    addPane(null, 'shell', '', settings.defaultProfileId, undefined, split);
  };
  const openLauncher = (kind: Launcher['kind'], split?: Launcher['split']) => {
    if (!settings) return;
    if (kind !== 'shell' && !isAgentEnabled(settings, kind)) {
      const fallback = preferredEnabledAgent(settings);
      if (!fallback) { notify('所有 Agent 都已停用，請先在設定 → 來源與工具啟用 Agent。'); return; }
      kind = fallback;
    }
    if (!current) {
      if (kind === 'shell') { openTemporaryTerminal(split); return; }
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
  const removePanes = (ids: string[], onFinish?: () => void) => {
    const panes = ids.map((id) => workspace.panes[id]).filter(Boolean);
    const live = panes.filter((p) => ['running', 'starting', 'disconnected'].includes(p.state) ||
      (p.state === 'placeholder' && (p.startToken ?? 0) > 0));
    const action = () => {
      const task = (async () => {
        try {
          if (nativeCloseSealed.current) return;
          await api.settleLaunches(ids);
          const sameGeneration = (pane: Pane, current: Pane | undefined) => !!current &&
            current.startToken === pane.startToken &&
            (!pane.runtimeId || pane.runtimeId === current.runtimeId);
          const eligible = () => panes.filter((pane) => sameGeneration(pane, stateRef.current.workspace.panes[pane.id]));
          const managed = await api.runtimes();
          const eligibleIds = new Set(eligible().map((pane) => pane.id));
          for (const id of eligibleIds) {
            const current = stateRef.current.workspace.panes[id];
            const records = managed.filter((record) => record.paneId === id);
            if (current.runtimeId && records.length && !records.some((record) => record.id === current.runtimeId))
              throw new Error('此面板的程序已變更，請重新連線後再關閉。');
          }
          const owned = managed.filter((record) => {
            if (!eligibleIds.has(record.paneId)) return false;
            const current = stateRef.current.workspace.panes[record.paneId];
            if (current.runtimeId) return current.runtimeId === record.id;
            const captured = panes.find((pane) => pane.id === record.paneId)!;
            const launching = captured.state === 'starting' ||
              (captured.state === 'placeholder' && (captured.startToken ?? 0) > 0);
            if (!launching) {
              if (['running', 'disconnected'].includes(captured.state))
                throw new Error('無法確認此面板的程序，請重新連線後再關閉。');
              return false; // Never adopt an unrelated broker record.
            }
            if (managed.filter((item) => item.paneId === record.paneId).length !== 1 ||
              record.kind !== captured.kind) throw new Error('無法確認此面板的程序，請重新連線後再關閉。');
            return true;
          });
          const targets = new Set(owned
            .filter((record) => ['running', 'starting'].includes(record.state))
            .map((record) => record.id));
          await Promise.all([...targets].map((id) => api.stop(id)));
          const results = await Promise.allSettled(owned.map(async (record) => {
            await api.forget(record.id);
            return record.id;
          }));
          const forgotten = new Set(results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []));
          const completed = panes.filter((pane) => eligibleIds.has(pane.id) &&
            owned.filter((record) => record.paneId === pane.id).every((record) => forgotten.has(record.id)));
          for (const pane of completed) closedPaneSnapshots.current.set(`${pane.id}:${pane.startToken ?? 0}:${pane.runtimeId ?? ''}`, pane);
          setWorkspace((w) => completed.reduce(closeConfirmedPane, w));
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        } finally { onFinish?.(); }
      })();
      pendingPaneClosures.current.add(task);
      void task.finally(() => { pendingPaneClosures.current.delete(task); }).catch(() => undefined);
      return task;
    };
    if (live.length)
      setConfirmation({
        title: `關閉 ${panes.length} 個面板？`,
        text: `將結束受管程序：${live.map((p) => p.title).join('、')}，並移除面板。其他分頁的程序不受影響。`,
        action, onCancel: onFinish,
      });
    else void action().catch(notify);
  };
  const closeTabPending = useRef(false);
  const requestCloseTab = useRef(() => {});
  requestCloseTab.current = () => {
    if (closingApp.current || closeTabPending.current || composing.current || document.querySelector('[role="dialog"]')) return;
    const current = stateRef.current;
    if (current.view !== 'workspace') return;
    const tab = current.workspace.tabs.find((item) => item.id === activeWorkspaceTabId(current.workspace, current.selectedId));
    if (!tab) return;
    closeTabPending.current = true;
    removePanes(paneIds(tab.layout), () => { closeTabPending.current = false; });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // Cmd+W is owned by the tab layer, including while a modal blocks it.
      if (!/Mac|iPhone|iPad/.test(navigator.platform) || !event.metaKey || event.ctrlKey ||
        event.altKey || event.shiftKey || event.key.toLowerCase() !== 'w') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !event.isComposing && event.keyCode !== 229) requestCloseTab.current();
    };
    window.addEventListener('keydown', key, true);
    let disposed = false;
    let stop: (() => void) | undefined;
    if (desktop) void listen('workspace-close-tab-requested', () => requestCloseTab.current()).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(notify);
    return () => { disposed = true; stop?.(); window.removeEventListener('keydown', key, true); };
  }, [desktop, notify]);
  const effectiveShortcuts = useMemo(
    () => normalizeLegacyShortcuts(settings?.shortcuts ?? {}),
    [settings?.shortcuts],
  );
  const conflicts = useMemo(() => shortcutConflicts(effectiveShortcuts), [effectiveShortcuts]);
  const commands: Command[] = [
    {
      id: 'command-palette',
      label: '開啟命令面板',
      disabled: settingsOpen || quickThemeOpen || themeSaving,
      run: () => {
        paletteOpener.current = document.activeElement as HTMLElement | null;
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
      id: 'temporary-terminal',
      label: '開啟臨時 Terminal（家目錄）',
      run: () => openTemporaryTerminal(),
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
          setSelectedId(undefined);
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
    ...(['ui', 'terminal'] as const).map(target => ({
      id: `theme-${target}`,
      label: target === 'ui' ? '切換介面主題' : '切換 Terminal theme',
      disabled: !settings || settingsOpen || quickThemeOpen || themeSaving,
      run: () => { if (!palette) paletteOpener.current = document.activeElement as HTMLElement | null; paletteGeneration.current++; setThemeSaveError(''); setPalette(true); setPaletteTheme(target); },
    })),
    { id: 'toggle-focus-mode', label: focusMode ? '退出專注模式' : '進入專注模式',
      disabled: !focusMode && !focusAvailable, run: toggleFocusMode },
    { id: 'toggle-sidebar', label: '顯示／隱藏側欄', run: () => {
      if (focusMode) setFocusControlsOpen((value) => !value);
      else setSidebarOpen((value) => !value);
    } },
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
    // A configured focus binding must be consumed before xterm can forward it to PTY.
    const focusKey = (event: KeyboardEvent) => {
      const command = commandRef.current.find((item) => item.id === 'toggle-focus-mode');
      if (command?.shortcut && !conflicts.has(command.id) && matchesShortcut(event, command.shortcut)) {
        key(event);
        if (event.defaultPrevented) event.stopPropagation();
      }
    };
    window.addEventListener('keydown', focusKey, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', focusKey, true); window.removeEventListener('keydown', key); };
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
    await zoomController.apply(next.appZoom ?? 100);
    const saved = await api.saveSettings(next);
    settingsRef.current = saved;
    setBoot((b) => (b ? { ...b, settings: saved, installations: [] } : b));
    setSettingsOpen(false);
    void detectAgents().catch(notify);
    if (first) void scan(false).catch(notify);
  };
  const persistAppearance = (patch: Partial<Appearance>): Promise<boolean> => {
    if (!settingsRef.current || settingsOpen) return Promise.resolve(false);
    return appearanceQueue.persist(patch);
  };
  const quickSaveTheme = async (patch: Partial<Appearance>) => {
    if (!settingsRef.current || settingsOpen || paletteTheme) return;
    quickAppearanceRequests.current++;
    const next = { ...quickAppearanceCurrent.current, ...patch };
    quickAppearanceCurrent.current = next;
    setAppearancePreview(next);
    setThemeSaveError('');
    try { await persistAppearance(patch); }
    catch (error) {
      const message = `外觀變更未能保存；保留上次儲存設定：${errorMessage(error)}`;
      setThemeSaveError(message);
      if (!quickThemeOpenRef.current) notify(message);
    } finally {
      if (--quickAppearanceRequests.current === 0) {
        quickAppearanceCurrent.current = null;
        setAppearancePreview(null);
      }
    }
  };
  const commitCommandTheme = async (patch: ThemePatch) => {
    if (!paletteTheme || themeSaveInFlight.current || settingsOpen || quickThemeOpen) return;
    const generation = paletteGeneration.current;
    setThemeSaveError('');
    setCommandThemePreview(patch);
    try {
      const saved = await persistAppearance(patch);
      if (generation === paletteGeneration.current) {
        if (saved) closePalette();
        else {
          setCommandThemePreview(null);
          setThemeSaveError('主題尚未儲存，已還原目前儲存的外觀；請重試。');
        }
      }
    } catch (error) {
      const message = `主題未能儲存，已還原目前儲存的外觀；可重試：${errorMessage(error)}`;
      if (generation === paletteGeneration.current) {
        setCommandThemePreview(null);
        setThemeSaveError(message);
      } else notify(message);
    }
  };
  const zoomShortcutRef = useRef((event: KeyboardEvent) => { void event; });
  zoomShortcutRef.current = (event) => {
    if (!settings || settingsOpen || composing.current || document.querySelector('[role="dialog"]') || !acceptsWorkspaceZoomShortcut(event.target)) return;
    const action = workspaceZoomShortcut(event);
    if (!action) return;
    // Capture before xterm so reserved zoom keys, including boundary no-ops, never reach PTY.
    event.preventDefault();
    event.stopPropagation();
    const size = quickAppearanceCurrent.current?.appZoom ?? settings.appZoom ?? 100;
    const next = nextWorkspaceZoom(size, action);
    if (next !== size || !zoomController.isApplied(next)) void quickSaveTheme({ appZoom: next });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => zoomShortcutRef.current(event);
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
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
  const curateSession = (session: Session) => {
    const project = projects.find((p) => p.id === session.projectId);
    if (project) void saveMembership(project, true);
    else notify('找不到工作目錄，請先重新整理索引。');
  };
  const projectOrder = reconcileProjectOrder(sidebar.projectOrder, projects);
  const orderIndex = new Map(projectOrder.map((id, index) => [id, index]));
  const sortedProjects = [...projects]
    .filter((p) => navigation === 'projects' ? p.curated : p.sessionCount > 0)
    .filter((p) => `${p.name} ${p.path ?? ''}`.toLowerCase().includes(projectSearch.toLowerCase()))
    .sort((a, b) => navigation === 'projects'
      ? (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity) || legacyProjectOrder(a, b)
      : legacyProjectOrder(a, b));
  const listCollapsed = navigation === 'projects' ? sidebar.projectsCollapsed : sidebar.directoriesCollapsed;
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
    <div className={`app-shell${compactWorkspace ? ' workspace-focus' : ''}`} data-focus-mode={focusMode} data-app-shell data-backend-ready={ready && desktop}>
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
          {focusMode && !focusAvailable && <button onClick={toggleFocusMode} aria-label="退出專注模式"><Minimize2 size={16} />退出專注</button>}
          <button className="secondary temporary-terminal-button" disabled={!boot || !desktop}
            title="在家目錄開啟臨時 Terminal，不建立專案" aria-label="開啟臨時 Terminal"
            onClick={() => openTemporaryTerminal()}>
            <TerminalSquare size={16} aria-hidden="true" /><span>臨時 Terminal</span>
          </button>
          <span className="local-badge">
            <span className="tiny-dot" />
            本機優先
          </span>
          <button className="icon-button theme-quick-trigger" aria-label="快速切換主題" title="快速切換主題"
            disabled={!settings || settingsOpen || themeSaving || palette}
            onClick={() => { setThemeSaveError(''); setQuickThemeOpen(true); }}>
            <Palette size={19} />
          </button>
          <button
            className="icon-button"
            aria-label="設定與資料來源"
            title="設定與資料來源"
            disabled={!boot || themeSaving || palette || quickThemeOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>
      <div className="app-body">
        {(sidebarOpen || revealSidebar) && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              <span>工作總覽</span>
              <button
                className="icon-button"
                aria-label="隱藏側欄"
                onClick={() => { if (revealSidebar) { setFocusControlsOpen(false); restoreWorkspaceFocus(); } else setSidebarOpen(false); }}
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
              <button className="sidebar-section-toggle" aria-expanded={!listCollapsed} aria-controls="sidebar-project-content"
                onClick={() => updateSidebar(navigation === 'projects' ? { projectsCollapsed: !listCollapsed } : { directoriesCollapsed: !listCollapsed })}>
                {listCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{navigationName}</span>
              </button>
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
            <div id="sidebar-project-content" className="sidebar-project-content" hidden={listCollapsed}>
            <div className="project-search search-field">
              <Search size={13} />
              <input
                aria-label={navigation === 'projects' ? '搜尋專案' : '搜尋所有目錄'}
                placeholder={navigation === 'projects' ? '尋找專案…' : '尋找目錄…'}
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </div>
            <SidebarProjectList projects={sortedProjects} selectedId={selectedId} label={navigationName}
              reorderable={navigation === 'projects'} onSelect={selectProject}
              onReorder={(id, target, after) => updateSidebar({ projectOrder: reorderProject(reconcileProjectOrder(sidebarRef.current.projectOrder, projects), id, target, after) })}
              empty={projectSearch ? `沒有符合的${navigationName}` : navigation === 'projects'
                ? '尚未加入專案。可從所有目錄挑選，或加入／建立專案。'
                : '尚未找到包含工作階段的目錄。請確認資料來源並更新索引。'} />
            </div>
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
                <div className="sidebar-section"><button className="sidebar-section-toggle" aria-expanded={!sidebar.workspacesCollapsed} aria-controls="sidebar-open-workspaces"
                  onClick={() => updateSidebar({ workspacesCollapsed: !sidebar.workspacesCollapsed })}>
                  {sidebar.workspacesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>開啟中的工作區</span></button><span>{workspace.tabs.length}</span></div>
                <nav id="sidebar-open-workspaces" hidden={sidebar.workspacesCollapsed}>
                  {workspace.tabs.map((tab) => {
                    const project = visibleProjects.find((p) => p.id === tab.projectId);
                    return <button key={tab.id} className={view === 'workspace' && activeTabId === tab.id ? 'active' : ''}
                      aria-label={`開啟工作區 ${tab.projectId === null ? '臨時 Terminal' : project?.name || '工作目錄'} ${tab.name}`}
                      title={tab.projectId === null ? '不屬於任何專案' : project?.launchPath || project?.path || '目錄待確認'} onClick={() => focus(tab.focusedPaneId)}>
                      <TerminalSquare size={14} /><span><strong>{tab.projectId === null ? '臨時 Terminal' : project?.name || '工作目錄'}</strong>
                        <small>{tab.name}{project?.workspaceOnly ? ' · 僅工作區' : ''}</small></span>
                    </button>;
                  })}
                </nav>
              </section>
            )}
            {boot && <AgentStatusOverview workspace={workspace} projects={visibleProjects} onFocus={focus} />}
            <div className="sidebar-bottom">
              <span className="eyebrow">你的工作，留在本機</span>
              <p>搜尋與預覽不會啟動 Agent，也不會上傳對話。</p>
              <button onClick={() => setSettingsOpen(true)} disabled={!boot || themeSaving || palette || quickThemeOpen}>
                <CircleHelp size={14} />
                資料來源與支援範圍
                <ChevronRight size={14} />
              </button>
            </div>
          </aside>
        )}
        <main className="main-content" id="main-workspace" tabIndex={-1}>
          <div className="project-header">
            <div className="project-heading">
              <nav className="breadcrumb" aria-label="目前位置">
                {!sidebarOpen && !revealSidebar && (
                  <button
                    className="icon-button"
                    aria-label="顯示側欄"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <Layers3 size={16} />
                  </button>
                )}
                <span>Session Bay</span>
                <ChevronRight size={12} />
                {current || allSessionsSearch || temporaryWorkspace ? <button className="breadcrumb-back" onClick={() => selectNavigation(navigation)}>{navigationName}</button> : <span aria-current="page">{navigationName}</span>}
                {temporaryWorkspace && <><ChevronRight size={12} /><span aria-current="page">臨時 Terminal</span></>}
                {current && <><ChevronRight size={12} /><span aria-current="page" title={current.name}>{current.name}</span></>}
                {allSessionsSearch && !current && <><ChevronRight size={12} /><span aria-current="page">搜尋所有工作階段</span></>}
              </nav>
              <div className="project-title-row">
                <h1 title={temporaryWorkspace ? '臨時 Terminal' : current?.name ?? (allSessionsSearch ? '搜尋所有工作階段' : navigationName)}>
                  {temporaryWorkspace ? '臨時 Terminal' : current?.name ?? (allSessionsSearch ? '搜尋所有工作階段' : navigationName)}
                </h1>
                {current && !current.workspaceOnly && <button className="icon-button project-rename" disabled={projectBusy}
                  title="重新命名專案" aria-label="重新命名專案"
                  onClick={event => { event.currentTarget.focus(); setRenameTarget({ kind: 'project', id: current.id, name: current.name }); }}>
                  <Pencil size={16} />
                </button>}
              </div>
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
                  temporaryWorkspace ? '新 Terminal 從家目錄開始，使用預設 Shell Profile；不會加入任何專案。'
                    : navigation === 'projects' ? '管理你選入的專案，專注在真正有意義的工作。'
                    : '保留所有工作階段的目錄分組。選擇目錄瀏覽對話，或加入專案。'
                )}
              </div>
            </div>
            <div className="header-buttons">
              <button className="icon-button" title="資源回收筒" aria-label="資源回收筒" disabled={!boot} onClick={() => setTrashOpen(true)}><Trash2 size={17} /></button>
              {navigation === 'directories' && !current && !temporaryWorkspace && <button className="secondary" disabled={!boot}
                onClick={() => { setAllSessionsSearch((value) => !value); setView('history'); }}>
                {allSessionsSearch ? <Folder size={15} /> : <Search size={15} />}
                {allSessionsSearch ? '返回目錄總覽' : '搜尋所有工作階段'}
              </button>}
              {current && !current.workspaceOnly && <button className="icon-button" disabled={projectBusy}
                aria-label={current.curated ? '移出專案' : '加入專案'}
                title={current.curated ? '移出專案清單；不刪除對話、檔案或關閉程序' : '將這個工作目錄加入專案清單'}
                onClick={() => void saveMembership(current, !current.curated)}>
                {current.curated ? <FolderMinus size={17} /> : <FolderPlus size={17} />}
              </button>}
              {temporaryWorkspace ? <button className="primary" onClick={() => openTemporaryTerminal()}>
                <Plus size={16} />新增臨時 Terminal
              </button> : current ? <>
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
              {(current || allSessionsSearch || temporaryWorkspace) && <div className="workspace-tabs" title={workspaceTabShortcutHelp}>
                {focusMode && focusAvailable && <button className="focus-project-control" aria-label={focusControlsOpen ? '收起完整控制列' : '展開完整控制列'}
                  aria-expanded={focusControlsOpen} title="顯示專案、設定與完整操作"
                  onClick={() => { setFocusControlsOpen((value) => !value); if (focusControlsOpen) restoreWorkspaceFocus(); }}>
                  <Layers3 size={16} aria-hidden="true" /><span>{current?.name ?? '臨時 Terminal'}</span>
                </button>}
                {!temporaryWorkspace && <button
                  className={view === 'history' ? 'active history-tab' : 'history-tab'}
                  onClick={() => setView('history')}
                >
                  <History size={14} />
                  歷史 Session
                </button>}
                <WorkspaceTabs tabs={workspace.tabs.filter((tab) => tab.projectId === selectedId)}
                  activeId={view === 'workspace' ? activeTabId : undefined}
                  onSelect={(tab) => {
                    setWorkspace((w) => selectWorkspaceTab(w, tab));
                    setView('workspace');
                    setMaximizedId(null);
                  }}
                  onRename={(tab) => setRenameTarget({ kind: 'tab', id: tab.id, name: tab.name })}
                  onClose={(tab) => removePanes(paneIds(tab.layout))}
                  onReorder={(id, targetId, after) => setWorkspace((w) => reorderWorkspaceTab(w, id, targetId, after))} />
                {(current || temporaryWorkspace) && (
                  <button
                    className="icon-button"
                    aria-label="新增工作區分頁"
                    onClick={() => openLauncher('shell')}
                  >
                    <Plus size={16} />
                  </button>
                )}
                {focusAvailable && <button ref={focusToggle} className="focus-mode-toggle" aria-pressed={focusMode}
                  aria-label={focusMode ? '退出專注模式' : '進入專注模式'}
                  title={focusMode ? '退出專注模式' : '進入專注模式（保留分頁與面板）'} onClick={toggleFocusMode}>
                  {focusMode ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
                  <span>{focusMode ? '退出專注' : '專注'}</span>
                </button>}
              </div>}
              <div className="main-work-area" id="navigation-content" role="tabpanel" aria-labelledby={`navigation-${navigation}`}>
                {temporaryWorkspace && !activeTab && <div className="empty-state">
                  <TerminalSquare size={30} aria-hidden="true" /><h2>目前沒有臨時 Terminal</h2>
                  <p>隨時從家目錄開啟新的命令列，不需要建立專案。</p>
                  <button className="primary" onClick={() => openTemporaryTerminal()}>開啟新的臨時 Terminal</button>
                </div>}
                <div
                  className="history-mount"
                  style={{ display: view === 'history' ? undefined : 'none' }}
                >
                  {current || allSessionsSearch ? <HistoryView
                    projectId={selectedId ?? undefined}
                    projects={projects}
                    refreshToken={refreshToken}
                    onHistoryChanged={refresh}
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
                    settings={visibleSettings ?? settings}
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
                      } else {
                        void api.runtimes().then((records) => {
                          if (!records.some((record) => record.id === info.id && record.paneId === info.paneId))
                            throw new Error('此受管程序已不在背景程序清單中，請重新整理後再試。');
                          let recovered = reconcileRuntimes(closePane(stateRef.current.workspace, newId), records);
                          const tab = recovered.tabs.find((item) => paneIds(item.layout).includes(info.paneId));
                          if (tab) recovered = selectWorkspaceTab(recovered, tab);
                          setWorkspace(recovered);
                          if (tab) setSelectedId(tab.projectId);
                          setAllSessionsSearch(false);
                          setView('workspace');
                          setMaximizedId(null);
                        }).catch((error) => patchPane(newId, { state: 'failed', error: errorMessage(error) }));
                      }
                    }}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
      <footer className={`statusbar${index.running || index.errors.length || index.cancelled || zoomError || themeSaving ? ' statusbar-important' : ''}`}>
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
          {visibleSettings && <span role="status" aria-live="polite" title={workspaceZoomShortcutHelp}>工作台 {appliedZoom ?? 100}%{zoomError ? ' · 縮放套用失敗' : appliedZoom !== zoomPercent ? ' · 套用中' : ''}{themeSaving ? ' · 儲存中' : ''}</span>}
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
      {quickThemeOpen && visibleSettings && (
        <Dialog title="快速切換主題" onClose={() => setQuickThemeOpen(false)}>
          <div className="theme-quick-content">
            <p className="theme-quick-help">每次選擇立即套用並儲存，關閉選單會保留。介面與終端可以各自搭配。</p>
            <ThemeControls value={appearanceOf(visibleSettings)} disabled={themeSaving}
              onChange={(patch) => void quickSaveTheme(patch)} />
            <TerminalPreview value={appearanceOf(visibleSettings)} />
            <div className="theme-quick-status" role="status">{themeSaving ? '正在儲存主題…' : themeSaveError ? '目前顯示上次儲存的主題' : '主題已儲存在本機'}</div>
            {themeSaveError && <p className="theme-quick-error" role="alert">{themeSaveError}</p>}
          </div>
        </Dialog>
      )}
      {trashOpen && <SessionTrash onClose={() => setTrashOpen(false)} onChanged={refresh} refreshToken={refreshToken} />}
      {settingsOpen && settings && boot && (
        <SettingsPanel
          settings={settings}
          installations={boot.installations}
          index={index}
          onboarding={!settings.onboardingComplete}
          onSave={saveSettings}
          onClose={() => { setAppearancePreview(null); setSettingsOpen(false); }}
          onPreviewAppearance={setAppearancePreview}
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
              if (current && launchPreview && !previewPending && !previewError && (launcher.kind === 'shell' || (isAgentEnabled(settings, launcher.kind) && boot?.installations.find((item) => item.kind === launcher.kind)?.available !== false))) {
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
                disabled={!preferredEnabledAgent(settings)}
                onClick={() => setLauncher({ ...launcher, kind: preferredEnabledAgent(settings) ?? settings.defaultAgent, resumeId: undefined })}>
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
                    disabled: !isAgentEnabled(settings, kind) || installation?.available === false,
                    description: !isAgentEnabled(settings, kind) ? '已停用，請至設定啟用' : installationState(installation).text };
                })} />
              {!isAgentEnabled(settings, launcher.kind) && <span className="inline-warning">此 Agent 已停用，請先在設定中啟用。</span>}
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
              <button className="primary" disabled={!launcher.cwd.trim() || previewPending || !launchPreview || !!previewError || (launcher.kind !== 'shell' && (!isAgentEnabled(settings, launcher.kind) || boot?.installations.find((item) => item.kind === launcher.kind)?.available === false))}>
                開始工作
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {renameTarget && <RenameDialog key={`${renameTarget.kind}:${renameTarget.id}`}
        title={renameTarget.kind === 'tab' ? '重新命名分頁' : '重新命名專案'} name={renameTarget.name}
        description={renameTarget.kind === 'tab' ? '只修改分頁顯示名稱，保留面板、程序與工作位置。' : '只修改顯示名稱，實際資料夾、路徑與對話歷史維持原樣。'}
        onClose={() => setRenameTarget(null)} onSave={async (name) => {
          if (renameTarget.kind === 'tab') {
            if (!stateRef.current.workspace.tabs.some((tab) => tab.id === renameTarget.id)) throw new Error('此分頁已關閉，請重新選擇。');
            setWorkspace((w) => renameWorkspaceTab(w, renameTarget.id, name));
            return;
          }
          if (projectMutation.current) throw new Error('專案正在更新，請稍後再試。');
          projectMutation.current = true;
          setProjectBusy(true);
          try {
            const result = await api.updateProject(renameTarget.id, { name });
            projectReadGeneration.current++;
            setProjects((previous) => previous.map((project) => project.id === result.id ? result : project));
          } finally { projectMutation.current = false; setProjectBusy(false); }
        }} />}
      {confirmation && (
        <Dialog title={confirmation.title} onClose={() => { if (!busy) { confirmation.onCancel?.(); setConfirmation(null); } }}>
          <p className="dialog-description">{confirmation.text}</p>
          <div className="dialog-actions">
            <button className="secondary" disabled={busy} onClick={() => { confirmation.onCancel?.(); setConfirmation(null); }}>
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
        <Dialog title="命令面板" onClose={closePalette}>
          {paletteTheme && settings ? <CommandThemePicker key={paletteTheme} target={paletteTheme}
            value={appearanceOf(settings)} saving={themeSaving} error={themeSaveError}
            onPreview={setCommandThemePreview} onCommit={patch => void commitCommandTheme(patch)}
            onBack={closePaletteTheme} /> : <CommandPalette query={paletteQuery} onQueryChange={setPaletteQuery}
            options={[
              ...commands.filter(command => command.id !== 'command-palette').map(command => ({
                id: `command-${command.id}`, label: command.label, search: command.label,
                detail: <kbd>{command.shortcut}</kbd>, disabled: command.disabled,
                run: () => { if (!command.id.startsWith('theme-')) closePalette(); command.run(); },
              })),
              ...projects.filter(project => project.curated)
                .filter(project => `${project.name} ${project.path}`.toLowerCase().includes(paletteQuery.toLowerCase()))
                .slice(0, 20).map(project => ({
                  id: `project-${project.id}`, label: <><Folder size={14} />{project.name}</>,
                  search: `${project.name} ${project.path}`, detail: <small>{project.path || '未分類'}</small>,
                  run: () => { setSelectedId(project.id); setView('history'); closePalette(); },
                })),
            ]} />}
        </Dialog>
      )}
    </div>
  );
}
