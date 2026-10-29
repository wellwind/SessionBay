import { ResponsiveControls } from './components/ResponsiveControls';
import { TerminalFileDialog } from './components/TerminalFileDialog';
import type { TerminalFileOpen } from './terminal-file-links';
import type { FileReference, Pane as FileLinkPane } from './types';
import { RuntimeActivityProvider, RuntimeActivityIndicator } from './components/RuntimeActivity';
import { AttentionNotifier } from './components/AttentionNotifier';
import { UpdateNotice } from './components/UpdateNotice';
import { projectOpenCount, tabRuntimeSummary } from './project-runtime';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Anchor,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Command as CommandIcon,
  Folder,
  Files,
  FolderPlus,
  GitBranch,
  Star,
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
  LayoutGrid,
} from 'lucide-react';
import { api, errorMessage, isDesktop } from './api';
import { closeFocusedExplorer } from './components/explorer-focus';
import { SidebarProjectList } from './components/SidebarProjectList';
import { ProjectNavigation } from './components/ProjectNavigation';
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
  LaunchRequest,
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
  closeSuccessfulExit,
  closeConfirmedPane,
  isSuccessfulAutoCloseExit,
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
  createSplitTab,
  movePaneHome,
  movePaneIntoSplit,
  tabProjectIds,
} from './workspace';
import { matchesShortcut, normalizeLegacyShortcuts, shortcutConflicts, workspaceTabIndex } from './commands';
import type { Command } from './commands';
import { Dialog } from './components/Dialog';
import { ProjectDialog } from './components/ProjectDialog';
import { DirectoryPathField } from './components/DirectoryPathField';
import { RenameDialog } from './components/RenameDialog';
import { FocusModeButton } from './components/FocusModeButton';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { DirectoryOverview } from './components/DirectoryOverview';
import { agentName, dateLabel, HistoryView } from './components/History';
import { SessionTrash } from './components/SessionTrash';
import { DevBadge } from './components/DevBadge';
import { isDevBuild } from './app-identity';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemeControls, TerminalPreview } from './components/ThemeControls';
import { appearanceOf } from './themes';
import { AppearanceSaveQueue } from './appearance-save-queue';
import { ProjectQuickSwitcher } from './components/ProjectQuickSwitcher';
// Git tools load on first use so the workbench bundle stays small.
const GitWorkbench = lazy(() => import('./git/GitWorkbench'));
import { FileIcon } from './components/ExplorerTree';
import { CommandPalette } from './components/CommandPalette';
import { CommandThemePicker } from './components/CommandThemePicker';
import type { ThemePatch, ThemeTarget } from './components/CommandThemePicker';
import type { Appearance } from './themes';
import { useUiTheme } from './use-ui-theme';
import { ActivityShell } from './components/ActivityShell';
import type { ActivityContribution } from './components/ActivityShell';
import { WorkspaceCanvas } from './components/WorkspaceCanvas';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { SplitExistingPicker } from './components/SplitExistingPicker';
import { projectColor, projectColorSlots, projectInitials } from './project-identity';
import { WorkspaceFiles } from './components/WorkspaceFiles';
import './project-files-workspace.css';
import { markWelcomeSeen, shouldShowWelcome } from './welcome';
import { t } from './i18n';
interface Launcher {
  resumeId?: string;
  kind: 'shell' | AgentKind;
  cwd: string;
  profileId: string;
  split?: { paneId: string; axis: 'horizontal' | 'vertical' };
  /** Split only: pick an open pane or history Session of any project instead of starting new work. */
  existing?: boolean;
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
  const quickRequestNonce = useRef(0);
  const [quickRuntimeFocus, setQuickRuntimeFocus] = useState<{ paneId: string; nonce: number }>();
  const [quickOpen, setQuickOpen] = useState(false);
  const [filePaths, setFilePaths] = useState<Record<string, string[]>>({});
  const [fileOpenRequest, setFileOpenRequest] = useState<{ projectId: string; path: string; nonce: number; reference?: FileReference }>();
  const [terminalFileIntent, setTerminalFileIntent] = useState<{ pane: FileLinkPane & { projectId: string; runtimeId: string }; request: TerminalFileOpen; generation: number; nonce: number }>();
  const [historyOpenRequest, setHistoryOpenRequest] = useState<{ session: Session; nonce: number }>();
  const onFileTabsChange = useCallback((projectId: string, paths: string[]) => {
    setFilePaths(previous => ({ ...previous, [projectId]: paths }));
  }, []);
  const [fileTabsHost, setFileTabsHost] = useState<HTMLDivElement | null>(null);
  const [fileSidebarHost, setFileSidebarHost] = useState<HTMLDivElement | null>(null);
  const [fileDocumentHost, setFileDocumentHost] = useState<HTMLDivElement | null>(null);
  const [visitedFileProjects, setVisitedFileProjects] = useState<string[]>([]);
  const [projectActivities, setProjectActivities] = useState<Record<string, { normal: string | null; zen: string | null }>>({});
  const projectViews = useRef<Record<string, 'history' | 'workspace' | 'files' | 'git'>>({});
  const initialProjectActivities = useRef<Record<string, string | null>>({});
  const [historySidebarHost, setHistorySidebarHost] = useState<HTMLDivElement | null>(null);
  const filesToggle = useRef<HTMLButtonElement>(null);
  const gitToggle = useRef<HTMLButtonElement>(null);
  const [gitSidebarHost, setGitSidebarHost] = useState<HTMLDivElement | null>(null);
  const [visitedGitProjects, setVisitedGitProjects] = useState<string[]>([]);
  const [gitTabsHost, setGitTabsHost] = useState<HTMLDivElement | null>(null);
  const [gitDocumentHost, setGitDocumentHost] = useState<HTMLDivElement | null>(null);
  const [gitDocumentCounts, setGitDocumentCounts] = useState<Record<string, number>>({});
  const onGitDocumentsChange = useCallback((projectId: string, count: number) => {
    setGitDocumentCounts(previous => previous[projectId] === count ? previous : { ...previous, [projectId]: count });
  }, []);
  const projectsToggle = useRef<HTMLButtonElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null | undefined>();
  // The all-workspaces grid is a view over every pane; terminals stay mounted underneath.
  const [workspaceOverview, setWorkspaceOverview] = useState(false);
  const [overviewReturn, setOverviewReturn] = useState(false);
  // A worktree opened with "start work" opens the launcher once it is the current project.
  const pendingWorktreeLaunch = useRef<string | null>(null);
  const beforeOverview = useRef<{ selectedId: string | null | undefined; view: 'history' | 'workspace' | 'files' | 'git' } | null>(null);
  const [navigation, setNavigation] = useState<'projects' | 'directories'>('projects');
  const [allSessionsSearch, setAllSessionsSearch] = useState(false);
  const lastHistoryProject = useRef<string | null | undefined>(undefined);
  const [view, setView] = useState<'history' | 'workspace' | 'files' | 'git'>('history');
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [index, setIndex] = useState<IndexStatus>(noIndex);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
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
    catch { setToast(t('Sidebar preferences could not be saved; the change applies for now but may revert after reopening.')); }
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
    catch { setToast(t('The project order could not be saved and may revert after reopening.')); }
  }, [boot, projects]);
  const [projectSearch, setProjectSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<Launcher | null>(null);
  const [freshLaunchPending, setFreshLaunchPending] = useState(false);
  const freshLaunchInFlight = useRef(false);
  type HookSkip = { request: LaunchRequest; generation: number; message: string; confirming?: boolean; settle: (confirmed: boolean) => void };
  const [hookSkip, setHookSkip] = useState<HookSkip | null>(null);
  const hookSkipRef = useRef<HookSkip | null>(null);
  const cancelHookSkip = useCallback(() => {
    const pending = hookSkipRef.current;
    if (!pending) return;
    hookSkipRef.current = null;
    setHookSkip(null);
    void api.cancelFresh(pending.request.paneId).catch(() => {});
    pending.settle(false);
  }, []);
  const finishHookSkip = (confirmed: boolean) => {
    const pending = hookSkipRef.current;
    if (!pending || pending.confirming) return;
    pending.confirming = true; // Block duplicate activation, but retain cancellation until IPC settles.
    setHookSkip(null);
    const valid = pending.generation === launchContext.current.generation && mounted.current && !closingApp.current;
    if (!confirmed || !valid) void api.cancelFresh(pending.request.paneId).catch(() => {});
    pending.settle(confirmed && valid);
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
  const confirmationLock = useRef(false);
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
  // Selecting any project or the temporary workspace (including zooming into a card) leaves the grid.
  useEffect(() => { if (selectedId !== undefined) setWorkspaceOverview(false); }, [selectedId]);
  const activeTabId = activeWorkspaceTabId(workspace, selectedId);
  const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
  // Side tools follow the focused pane in a mixed tab; the page (tabs, title) stays with `current`.
  const focusedMixedPane = view === 'workspace' && !workspaceOverview && activeTab?.mixed
    ? workspace.panes[activeTab.focusedPaneId] : undefined;
  const toolProject = focusedMixedPane
    ? visibleProjects.find((p) => p.id === focusedMixedPane.projectId)
    : current;
  const projectSlots = useMemo(() => projectColorSlots(visibleProjects.map((p) => p.id)), [visibleProjects]);
  const projectBadge = useCallback((projectId: string | null) => {
    const name = projectId === null ? t('Temporary terminal') : visibleProjects.find((p) => p.id === projectId)?.name ?? t('Workspace-only project');
    return { initials: projectInitials(name), name, color: projectColor(projectId, projectSlots) };
  }, [visibleProjects, projectSlots]);
  const manuallyClosedActivities = useRef(new Set<string>());
  const hadProjectTabs = useRef<Record<string, boolean>>({});
  const activityMode = focusMode ? 'zen' : 'normal';
  // Which side panel is open belongs to the page, so focusing another pane in a mixed tab
  // never opens or closes panels (and never shifts the layout under the pointer).
  if (current && !(current.id in initialProjectActivities.current)) initialProjectActivities.current[current.id] =
    workspace.tabs.some(tab => tab.projectId === current.id) ? null : 'sessions';
  const defaultActivity = current ? initialProjectActivities.current[current.id] : null;
  const activeActivity = current ? projectActivities[current.id]?.[activityMode] ??
    (projectActivities[current.id] ? null : focusMode ? null : defaultActivity) : null;
  const setActiveActivity = (id: string | null) => {
    if (!current) return;
    if (id === null) manuallyClosedActivities.current.add(current.id);
    else manuallyClosedActivities.current.delete(current.id);
    setProjectActivities(previous => ({ ...previous, [current.id]: {
      ...(previous[current.id] ?? { normal: defaultActivity, zen: null }), [activityMode]: id,
    } }));
  };
  const currentProjectId = current?.id;
  const hasProjectTabs = !!current && (workspace.tabs.some(tab => tab.projectId === current.id) || !!filePaths[current.id]?.length || !!gitDocumentCounts[current.id]);
  useEffect(() => {
    if (!currentProjectId) return;
    const hadTabs = hadProjectTabs.current[currentProjectId];
    hadProjectTabs.current[currentProjectId] = hasProjectTabs;
    if (hadTabs && !hasProjectTabs && !manuallyClosedActivities.current.has(currentProjectId)) {
      setProjectActivities(previous => ({ ...previous, [currentProjectId]: { normal: 'sessions', zen: previous[currentProjectId]?.zen ?? null } }));
      setView('history');
    }
  }, [currentProjectId, hasProjectTabs]);
  useEffect(() => { setQuickOpen(false); }, [currentProjectId]);
  if (current) projectViews.current[current.id] = view;
  const historyVisible = !!toolProject || allSessionsSearch;
  const historyEnabled = historyVisible;
  if (historyEnabled) lastHistoryProject.current = toolProject?.id ?? null;
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
  useEffect(() => {
    if (toolProject && !toolProject.workspaceOnly) setVisitedFileProjects((ids) => ids.includes(toolProject.id) ? ids : [...ids, toolProject.id]);
  }, [toolProject]);
  const filesAvailable = !!toolProject && !toolProject.workspaceOnly;
  const filesVisible = filesAvailable && activeActivity === 'files';
  const gitVisible = filesAvailable && activeActivity === 'git';
  useEffect(() => {
    if (gitVisible && toolProject) setVisitedGitProjects((ids) => ids.includes(toolProject.id) ? ids : [...ids, toolProject.id]);
  }, [gitVisible, toolProject]);
  const hideGitSidebar = () => {
    setActiveActivity(null);
    gitToggle.current?.focus({ preventScroll: true });
  };
  const showSessions = () => setActiveActivity('sessions');
  const hideFilesSidebar = () => {
    setActiveActivity(null);
    filesToggle.current?.focus({ preventScroll: true });
  };
  const focusPane = activeTab ? workspace.panes[activeTab.focusedPaneId] : undefined;
  const focusAvailable = !!current || temporaryWorkspace;
  const compactWorkspace = focusMode && focusAvailable && !focusControlsOpen;
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
  const stateRef = useRef({ workspace, selectedId, boot, view, navigation, launcher, projects: visibleProjects });
  stateRef.current = { workspace, selectedId, boot, view, navigation, launcher, projects: visibleProjects };
  const launchContextKey = JSON.stringify([selectedId, navigation, view, allSessionsSearch, activeTabId,
    activeTab?.focusedPaneId, settingsOpen, palette, quickThemeOpen, !!pathDialog, !!projectDialog, !!confirmation, !!renameTarget, settings]);
  const launchContext = useRef({ key: launchContextKey, launcher, generation: 0 });
  // Closing the submitted launcher is expected. Opening or editing another
  // launcher invalidates its ownership even if that newer dialog closes too.
  if (launchContext.current.key !== launchContextKey || (launcher && launchContext.current.launcher !== launcher))
    launchContext.current = { key: launchContextKey, launcher, generation: launchContext.current.generation + 1 };
  else launchContext.current.launcher = launcher;
  const fileContextKey = JSON.stringify([launchContextKey, focusMode, maximizedId, current?.path, current?.launchPath]);
  const fileContext = useRef({ key: fileContextKey, generation: 0 });
  if (fileContext.current.key !== fileContextKey) fileContext.current = { key: fileContextKey, generation: fileContext.current.generation + 1 };
  const fileIntentValid = useCallback((intent: NonNullable<typeof terminalFileIntent>) => {
    const pane = stateRef.current.workspace.panes[intent.pane.id];
    return mounted.current && !closingApp.current && intent.generation === fileContext.current.generation &&
      stateRef.current.selectedId === intent.pane.projectId && stateRef.current.view === 'workspace' &&
      pane?.runtimeId === intent.pane.runtimeId && pane.projectId === intent.pane.projectId && pane.startToken === intent.pane.startToken;
  }, []);
  useEffect(() => { if (terminalFileIntent && !fileIntentValid(terminalFileIntent)) setTerminalFileIntent(undefined); }, [terminalFileIntent, fileContextKey, workspace, fileIntentValid]);
  useEffect(() => {
    if (hookSkipRef.current && hookSkipRef.current.generation !== launchContext.current.generation) cancelHookSkip();
  });
  useEffect(() => cancelHookSkip, [cancelHookSkip]);
  useEffect(() => {
    if (!hookSkip) return;
    const expires = Number(hookSkip.request.paneId.split(':')[0]) + 10 * 60 * 1000;
    const timer = window.setTimeout(cancelHookSkip, Math.max(0, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [hookSkip, cancelHookSkip]);
  const composing = useRef(false);
  useEffect(() => {
    const start = () => { composing.current = true; };
    const end = () => { composing.current = false; };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || composing.current || event.keyCode === 229 || document.querySelector('[role="dialog"]')) return;
      const current = stateRef.current;
      if ((current.view === 'files' || current.view === 'git') && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) requestCloseTab.current();
        return;
      }
      const tabs = current.workspace.tabs.filter((tab) => tab.projectId === current.selectedId);
      const fileButtons = [...document.querySelectorAll<HTMLButtonElement>('.project-file-tabs-host [role="tab"]')].filter((button) => !button.closest('[hidden]'));
      const active = current.view === 'workspace' ? tabs.findIndex((tab) => tab.id === activeWorkspaceTabId(current.workspace, current.selectedId))
        : current.view === 'files' ? tabs.length + fileButtons.findIndex((button) => button.getAttribute('aria-selected') === 'true') : -1;
      const count = tabs.length + fileButtons.length;
      const index = workspaceTabIndex(event, count, active);
      const reserved = index !== null || (count > 0 && workspaceTabIndex(event, 9, 0) !== null);
      if (!reserved) return;
      // Capture before xterm's textarea keydown so reserved tab keys never reach PTY.
      event.preventDefault();
      event.stopPropagation();
      if (index === null) return; // A reserved number beyond the open tabs is a no-op, never PTY input.
      if (index >= tabs.length) { fileButtons[index - tabs.length]?.click(); fileButtons[index - tabs.length]?.focus(); return; }
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
  const exitCleanupPending = useRef(new Map<string, Promise<void>>());
  const cleanedExits = useRef(new Map<string, Pane>());
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
      const welcome = shouldShowWelcome(data.settings.onboardingComplete);
      setWelcomeOpen(welcome);
      setSettingsOpen(welcome);
      if (data.warnings.length) notify(data.warnings.join(t('; ')));
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
  const persistCurrentWorkspace = useCallback(async () => {
    if (stateRef.current.boot) {
      await saveQueue.current;
      // Forget and layout persistence form one close operation. Project
      // successful cleanups into the snapshot even before React commits.
      const snapshotNow = () => serializeWorkspace([...cleanedExits.current.values()]
        .reduce(closeSuccessfulExit, [...closedPaneSnapshots.current.values()]
          .reduce(closeConfirmedPane, stateRef.current.workspace)));
      for (;;) {
        await Promise.all([...exitCleanupPending.current.values(), ...pendingPaneClosures.current].map((task) => task.catch(() => undefined)));
        const snapshot = snapshotNow();
        const signature = JSON.stringify(snapshot);
        if (signature !== persistedWorkspace.current) {
          await api.saveWorkspace(snapshot);
          persistedWorkspace.current = signature;
        }
        if (!exitCleanupPending.current.size && !pendingPaneClosures.current.size && JSON.stringify(snapshotNow()) === signature) break;
      }
    }
  }, []);
  const reloadWindow = useCallback(async () => {
    if (closingApp.current) throw new Error(t('The window is saving or closing; try again shortly.'));
    cancelHookSkip();
    closingApp.current = true;
    try {
      await persistCurrentWorkspace();
      startup.reloadWindow();
    } catch (error) {
      closingApp.current = false;
      setWorkspace((current) => ({ ...current }));
      throw new Error(t('Reload cancelled because the workspace could not be saved: {{error}}', { error: errorMessage(error) }));
    }
  }, [persistCurrentWorkspace, cancelHookSkip]);
  useEffect(() => {
    // Keep the last committed handler after a fatal React unmount so the
    // dependency-free startup fallback can still persist the latest workspace.
    window.SessionBayReload = reloadWindow;
  }, [reloadWindow]);
  const closeApplication = useCallback(() => {
    const action = async () => {
      cancelHookSkip();
      closingApp.current = true;
      try {
        await persistCurrentWorkspace();
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
  }, [notify, persistCurrentWorkspace, cancelHookSkip]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const listeners: (() => void)[] = [];
    for (const task of [
      listen('app-close-requested', closeApplication),
      listen<string>('app-close-error', (event) => notify(event.payload)),
      // A clicked attention notification names the pane that raised it.
      listen<string | null>('notification-activated', (event) => { if (event.payload) focusRef.current(event.payload); }),
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
  const forgettingExits = useRef(new Set<string>());
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
    for (const id of forgettingExits.current) {
      if (!referenced.has(id) && !exitCleanupPending.current.has(id)) {
        forgettingExits.current.delete(id);
        cleanedExits.current.delete(id);
      }
    }
    for (const pane of Object.values(workspace.panes)) {
      if (!isSuccessfulAutoCloseExit(pane) || forgettingExits.current.has(pane.runtimeId!)) continue;
      forgettingExits.current.add(pane.runtimeId!);
      // Forget only this completed runtime. Never use the manual close path,
      // which settles launches and stops processes by pane ID.
      const cleanup = api.forget(pane.runtimeId!).then(() => {
        cleanedExits.current.set(pane.runtimeId!, pane);
        setWorkspace((current) => closeSuccessfulExit(current, pane));
      }).catch(notify).finally(() => { exitCleanupPending.current.delete(pane.runtimeId!); });
      exitCleanupPending.current.set(pane.runtimeId!, cleanup);
    }
  }, [workspace, notify]);
  const consumedRuntimeFocus = useRef<typeof quickRuntimeFocus>(undefined);
  useEffect(() => {
    if (!quickRuntimeFocus || quickOpen || consumedRuntimeFocus.current === quickRuntimeFocus) return;
    consumedRuntimeFocus.current = quickRuntimeFocus;
    const owner = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const latest = stateRef.current;
      const tab = latest.workspace.tabs.find(item => item.id === activeWorkspaceTabId(latest.workspace, latest.selectedId));
      if (latest.view !== 'workspace' || tab?.focusedPaneId !== quickRuntimeFocus.paneId ||
        document.activeElement !== owner || document.querySelector('[role="dialog"]')) return;
      const terminal = [...document.querySelectorAll<HTMLTextAreaElement>('.terminal-pane.focused .xterm-helper-textarea')]
        .find(element => element.getClientRects().length > 0);
      terminal?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [quickRuntimeFocus, quickOpen]);
  const focusRef = useRef<(id: string) => void>(() => {});
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
  focusRef.current = focus;
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
    if (Object.keys(stateRef.current.workspace.panes).length >= 128) {
      notify(t('You have reached the limit of 128 panes. Close panes you no longer need first.'));
      return false;
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
          : t('{{agent}} work', { agent: agentName(kind) })),
      projectId,
      cwd,
      homeDirectory: projectId === null && kind === 'shell' && cwd === '',
      profileId,
      sessionId: session?.id,
      resumeId,
      state: 'placeholder',
      startToken: 1,
    };
    const insert = (pane: Pane) => {
      const id = pane.id;
      setWorkspace((w) => {
        const tab = split ? w.tabs.find((t) => paneIds(t.layout).includes(split.paneId)) : undefined;
        // A split may receive another project's work (e.g. a resumed Session); the tab becomes mixed.
        if (tab && split)
          return {
            ...selectWorkspaceTab(w, tab),
            panes: { ...w.panes, [id]: pane },
            tabs: w.tabs.map((t) =>
              t.id === tab.id
                ? {
                    ...t,
                    focusedPaneId: id,
                    layout: splitNode(t.layout, split.paneId, id, split.axis),
                    ...(t.mixed || t.projectId !== projectId ? { mixed: true } : {}),
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
      const splitOwner = split ? stateRef.current.workspace.tabs.find((t) => paneIds(t.layout).includes(split.paneId))?.projectId : undefined;
      setSelectedId(splitOwner !== undefined ? splitOwner : projectId);
      setAllSessionsSearch(false);
      setView('workspace');
      setMaximizedId(null);
    };
    if (kind !== 'shell' && !session && !resumeId) {
      // Lock before awaiting IPC or rendering; repeated submit events cannot
      // create another intent while the detached launch outcome is unknown.
      if (freshLaunchInFlight.current) return false;
      freshLaunchInFlight.current = true;
      setFreshLaunchPending(true);
      const generation = launchContext.current.generation;
      const before = stateRef.current.workspace;
      const targetPane = split ? before.panes[split.paneId] : undefined;
      const targetTab = split ? before.tabs.find((tab) => paneIds(tab.layout).includes(split.paneId)) : undefined;
      void (async () => {
        let confirmedLaunch = false;
        try {
          const request: LaunchRequest = { paneId: `${Date.now()}:${crypto.randomUUID()}`, kind,
            projectId: project && !project.workspaceOnly ? project.id : undefined,
            cwd, profileId, cols: 80, rows: 24 };
          let info;
          try {
            info = await api.launchFresh(request);
          } catch (error) {
            const message = errorMessage(error);
            const marker = '[SESSIONBAY_LAUNCH_NOT_STARTED] ';
            if (!message.startsWith(marker)) throw error;
            if (!mounted.current || closingApp.current || generation !== launchContext.current.generation) {
              void api.cancelFresh(request.paneId).catch(() => {});
              return;
            }
            const confirmed = await new Promise<boolean>((settle) => {
              const pending = { request, generation, message: message.slice(marker.length), settle };
              hookSkipRef.current = pending;
              setHookSkip(pending);
            });
            if (!confirmed) return;
            info = await api.launchFreshWithoutHooks(request);
          }
          confirmedLaunch = true;
          if (!mounted.current || closingApp.current) return;
          const latest = stateRef.current;
          const latestProject = latest.projects.find((entry) => entry.id === projectId);
          const latestTarget = split ? latest.workspace.panes[split.paneId] : undefined;
          const latestTab = split ? latest.workspace.tabs.find((tab) => tab.id === targetTab?.id) : undefined;
          const targetChanged = split && (!targetPane || !latestTarget || !latestTab ||
            latestTarget.runtimeId !== targetPane.runtimeId || latestTarget.startToken !== targetPane.startToken ||
            latestTarget.kind !== targetPane.kind || latestTarget.cwd !== targetPane.cwd ||
            latestTarget.projectId !== projectId || latestTab.layout !== targetTab?.layout);
          const contextChanged = generation !== launchContext.current.generation || latest.launcher !== null ||
            !latestProject || latestProject.path !== project?.path || latestProject.launchPath !== project?.launchPath ||
            latestProject.workspaceOnly !== project?.workspaceOnly || latestProject.exists !== project?.exists ||
            targetChanged || Object.keys(latest.workspace.panes).length >= 128;
          if (contextChanged) {
            // A newer navigation or edited/closed split target owns the UI.
            // Recover only this confirmed runtime without resurrecting its old
            // target, stealing focus, or stopping a successfully started Agent.
            const records = (await api.runtimes()).filter((record) => record.id === info.id && record.paneId === info.paneId);
            if (!mounted.current || closingApp.current) return;
            if (!records.length) throw new Error(t('The background process list does not include the agent that was just started yet'));
            setWorkspace((w) => reconcileRuntimes(w, records));
            notify(t('The agent started in the background and stays in its project; open it from the work tabs.'));
            return;
          }
          insert({ ...pane, startToken: undefined, id: info.paneId, runtimeId: info.id, cwd: info.cwd,
            state: ['starting', 'running', 'exited', 'failed', 'interrupted'].includes(info.state)
              ? info.state as Pane['state'] : 'disconnected',
            exitCode: info.exitCode });
        } catch (error) {
          if (mounted.current && !closingApp.current) {
            const message = errorMessage(error);
            const notStarted = '[SESSIONBAY_LAUNCH_NOT_STARTED] ';
            if (!confirmedLaunch && message.startsWith(notStarted)) notify(message.slice(notStarted.length));
            else notify(t('{{status}}: {{error}}. Refresh the workbench or reopen Session Bay to check background processes before starting it again.', { status: confirmedLaunch ? t('The agent started in the background, but its work tab could not be restored') : t('Could not confirm whether the agent started'), error: message }));
          }
        } finally {
          // A confirmed intent remains cancellable while backend admission is pending.
          hookSkipRef.current = null;
          freshLaunchInFlight.current = false;
          if (mounted.current) setFreshLaunchPending(false);
        }
      })();
      return true;
    }
    insert(pane);
    return true;
  };
  const resume = (session: Session, override?: Project, split?: Launcher['split']) => {
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
      notify(t('Cannot find the project of this session; refresh the index first.'));
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
      split,
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
      if (!fallback) { notify(t('All agents are disabled. Enable one in Settings → Sources and tools first.')); return; }
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
  useEffect(() => {
    if (!current || pendingWorktreeLaunch.current !== current.id) return;
    pendingWorktreeLaunch.current = null;
    openLauncher(settings?.defaultAgent ?? 'codex');
  });
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
              throw new Error(t('The process of this pane changed; reconnect before closing it.'));
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
                throw new Error(t('Cannot confirm the process of this pane; reconnect before closing it.'));
              return false; // Never adopt an unrelated broker record.
            }
            if (managed.filter((item) => item.paneId === record.paneId).length !== 1 ||
              record.kind !== captured.kind) throw new Error(t('Cannot confirm the process of this pane; reconnect before closing it.'));
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
        title: t('Close {{count}} panes?', { count: panes.length }),
        text: t('This ends the managed processes {{names}} and removes the panes. Processes in other tabs are not affected.', { names: live.map((p) => p.title).join(t(', ')) }),
        action, onCancel: onFinish,
      });
    else void action().catch(notify);
  };
  const closeTabPending = useRef(false);
  const requestCloseTab = useRef(() => {});
  requestCloseTab.current = () => {
    if (closingApp.current || closeTabPending.current || composing.current || document.querySelector('[role="dialog"]')) return;
    const current = stateRef.current;
    if (current.view === 'files') {
      document.querySelector<HTMLElement>('[data-file-explorer]')?.dispatchEvent(new Event('explorer-close-file'));
      return;
    }
    if (current.view === 'git') {
      document.querySelector<HTMLElement>('[data-git-workbench]')?.dispatchEvent(new Event('git-close-document'));
      return;
    }
    if (closeFocusedExplorer()) return;
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
  const openWorkspaceOverview = () => {
    if (!workspaceOverview) beforeOverview.current = { selectedId, view };
    setOverviewReturn(false);
    setSelectedId(undefined);
    setAllSessionsSearch(false);
    setView('history');
    setMaximizedId(null);
    setWorkspaceOverview(true);
  };
  const closeWorkspaceOverview = () => {
    const previous = beforeOverview.current;
    beforeOverview.current = null;
    setWorkspaceOverview(false);
    if (previous?.selectedId !== undefined) {
      setSelectedId(previous.selectedId);
      setView(previous.view);
    }
  };
  const commands: Command[] = [
    { id: 'toggle-workspace-overview', label: workspaceOverview ? t('Leave the all-workspaces overview') : t('Open the all-workspaces overview'), disabled: !boot,
      run: () => workspaceOverview ? closeWorkspaceOverview() : openWorkspaceOverview() },
    { id: 'project-quick-open', label: t('Quick open project tabs, sessions and files'), disabled: !current,
      run: () => setQuickOpen(true) },
    { id: 'toggle-project-sessions', label: t('Show / hide project sessions'), disabled: !current,
      run: () => setActiveActivity(activeActivity === 'sessions' ? null : 'sessions') },
    { id: 'toggle-project-files', label: t('Show / hide project files'), disabled: !filesAvailable,
      run: () => setActiveActivity(activeActivity === 'files' ? null : 'files') },
    { id: 'toggle-project-git', label: t('Show / hide project Git'), disabled: !filesAvailable,
      run: () => setActiveActivity(activeActivity === 'git' ? null : 'git') },
    {
      id: 'command-palette',
      label: t('Open command palette'),
      disabled: settingsOpen || quickThemeOpen || themeSaving,
      run: () => {
        paletteOpener.current = document.activeElement as HTMLElement | null;
        setPalette(true);
        setPaletteQuery('');
      },
    },
    {
      id: 'new-terminal',
      label: t('Open terminal'),
      run: () => openLauncher('shell'),
      disabled: !settings,
    },
    {
      id: 'temporary-terminal',
      label: t('Open temporary terminal (home folder)'),
      run: () => openTemporaryTerminal(),
      disabled: !settings,
    },
    {
      id: 'new-agent',
      label: t('Start agent work'),
      run: () => openLauncher(settings?.defaultAgent ?? 'codex'),
      disabled: !settings,
    },
    {
      id: 'search-sessions',
      label: current ? t('Search sessions in this folder') : t('Search all sessions'),
      run: () => {
        if (!current) {
          setSelectedId(undefined);
          setNavigation('directories');
          setAllSessionsSearch(true);
        }
        setView('history');
        showSessions();
        setTimeout(() => document.getElementById('session-search')?.focus(), 0);
      },
    },
    {
      id: 'split-right',
      label: t('Split pane left and right'),
      run: () => {
        if (focusPane) openLauncher('shell', { paneId: focusPane.id, axis: 'horizontal' });
      },
      disabled: !focusPane,
    },
    {
      id: 'split-down',
      label: t('Split pane top and bottom'),
      run: () => {
        if (focusPane) openLauncher('shell', { paneId: focusPane.id, axis: 'vertical' });
      },
      disabled: !focusPane,
    },
    {
      id: 'next-pane',
      label: t('Switch to the next pane'),
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
      label: maximizedId ? t('Restore pane size') : t('Temporarily maximize pane'),
      run: () => {
        if (focusPane) setMaximizedId(maximizedId === focusPane.id ? null : focusPane.id);
      },
      disabled: !focusPane,
    },
    {
      id: 'close-pane',
      label: t('Close current pane'),
      run: () => {
        if (focusPane) removePanes([focusPane.id]);
      },
      disabled: !focusPane,
    },
    { id: 'reload-window', label: t('Reload window'),
      run: () => { void reloadWindow().catch(notify); } },
    ...(['ui', 'terminal'] as const).map(target => ({
      id: `theme-${target}`,
      label: target === 'ui' ? t('Switch interface theme') : t('Switch terminal theme'),
      disabled: !settings || settingsOpen || quickThemeOpen || themeSaving,
      run: () => { if (!palette) paletteOpener.current = document.activeElement as HTMLElement | null; paletteGeneration.current++; setThemeSaveError(''); setPalette(true); setPaletteTheme(target); },
    })),
    { id: 'toggle-focus-mode', label: focusMode ? t('Exit focus mode (Zen Mode)') : t('Enter focus mode (Zen Mode)'),
      disabled: !focusMode && !focusAvailable, run: toggleFocusMode },
    { id: 'toggle-sidebar', label: t('Show / hide sidebar'), run: () => {
      if (focusMode) {
        setFocusControlsOpen(value => !value);
        if (focusControlsOpen) restoreWorkspaceFocus();
      }
      else setSidebarOpen(previous => !previous);
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
        // Preserve the shell's previous-history chord on non-macOS terminals.
        if (command.id === 'project-quick-open' && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey &&
          event.key.toLowerCase() === 'p' && event.target instanceof Element && event.target.matches('.xterm-helper-textarea')) return;
        if (command.id === 'toggle-focus-mode' && event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable="true"]') &&
          !event.target.matches('.xterm-helper-textarea')) return;
        event.preventDefault();
        if (command.id !== 'toggle-focus-mode' || !event.repeat) command.run();
      }
    };
    // A configured focus binding must be consumed before xterm can forward it to PTY.
    const focusKey = (event: KeyboardEvent) => {
      const command = commandRef.current.find((item) => ['toggle-focus-mode', 'toggle-sidebar', 'project-quick-open', 'toggle-project-sessions', 'toggle-project-files', 'toggle-project-git', 'toggle-workspace-overview'].includes(item.id) && item.shortcut && matchesShortcut(event, item.shortcut));
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
    if (welcomeOpen) { markWelcomeSeen(); setWelcomeOpen(false); }
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
      const message = t('The appearance change could not be saved; keeping the last saved settings: {{error}}', { error: errorMessage(error) });
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
          setThemeSaveError(t('The theme was not saved and the saved appearance was restored; please try again.'));
        }
      }
    } catch (error) {
      const message = t('The theme could not be saved and the saved appearance was restored; you can try again: {{error}}', { error: errorMessage(error) });
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
    else notify(t('Cannot find the working directory; refresh the index first.'));
  };
  const projectOrder = reconcileProjectOrder(sidebar.projectOrder, projects);
  const orderIndex = new Map(projectOrder.map((id, index) => [id, index]));
  const sortedProjects = [...projects]
    .filter((p) => navigation === 'projects' ? p.curated : p.sessionCount > 0)
    .filter((p) => `${p.name} ${p.path ?? ''}`.toLowerCase().includes(projectSearch.toLowerCase()))
    .sort((a, b) => navigation === 'projects'
      ? (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity) || legacyProjectOrder(a, b)
      : legacyProjectOrder(a, b));
  const projectOpenCounts = Object.fromEntries(sortedProjects.map((p) =>
    [p.id, projectOpenCount(workspace.tabs.filter((tab) => tab.projectId === p.id), workspace.panes)]));
  const listCollapsed = navigation === 'projects' ? sidebar.projectsCollapsed : sidebar.directoriesCollapsed;
  const selectNavigation = (page: 'projects' | 'directories') => {
    setWorkspaceOverview(false);
    setOverviewReturn(false);
    setNavigation(page);
    setSelectedId(undefined);
    setAllSessionsSearch(false);
    setProjectSearch('');
    setView('history');
    setMaximizedId(null);
  };
  const selectProject = (project: Project) => {
    setOverviewReturn(false);
    setSelectedId(project.id);
    setAllSessionsSearch(false);
    setView(projectViews.current[project.id] ?? (workspace.tabs.some(tab => tab.projectId === project.id) ? 'workspace' : 'history'));
    setMaximizedId(null);
  };
  const navigationName = navigation === 'projects' ? t('Projects') : t('All directories');
  const pageTitle = workspaceOverview ? t('All workspaces') : temporaryWorkspace ? t('Temporary terminal')
    : current?.name ?? (allSessionsSearch ? t('Search all sessions') : navigationName);
  const projectCount = projects.filter((project) => project.curated).length;
  const directoryCount = projects.filter((project) => project.sessionCount > 0).length;
  const activeCount = Object.values(workspace.panes).filter(
    (p) => p.state === 'running' || p.state === 'starting',
  ).length;
  const activities: ActivityContribution[] = [
    { id: 'sessions', label: t('History sessions'), icon: History, shortcut: conflicts.has('toggle-project-sessions') ? '' : effectiveShortcuts['toggle-project-sessions'],
      renderSidebar: () => <div className="activity-sessions-panel" ref={setHistorySidebarHost} /> },
    { id: 'files', label: 'Files', icon: Files, shortcut: conflicts.has('toggle-project-files') ? '' : effectiveShortcuts['toggle-project-files'], buttonRef: filesToggle,
      available: filesAvailable,
      renderSidebar: () => <div className="project-files-sidebar-host" ref={setFileSidebarHost} /> },
    { id: 'git', label: 'Git', icon: GitBranch, shortcut: conflicts.has('toggle-project-git') ? '' : effectiveShortcuts['toggle-project-git'], buttonRef: gitToggle,
      available: filesAvailable,
      renderSidebar: () => <div className="project-git-sidebar-host" ref={setGitSidebarHost} /> },
  ];
  const projectNavigation = <ProjectNavigation hidden={!sidebarOpen || compactWorkspace}
    preferredWidth={sidebar.width} onWidthChange={width => updateSidebar({ width })}>
        <div className="navigation-tabs" role="tablist" aria-label={t('Navigation pages')}>
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
              {page === 'projects' ? t('Projects') : t('All directories (tab)')}
              <span>{page === 'projects' ? projectCount : directoryCount}</span>
            </button>)}
          </div>

            <div className="sidebar-heading">
              <span>{t('Work overview')}</span>
              <button
                className="icon-button"
                aria-label={t('Hide sidebar')}
                onClick={event => {
                  const owner = event.currentTarget;
                  setSidebarOpen(false);
                  requestAnimationFrame(() => {
                    if ((document.activeElement === owner || document.activeElement === document.body) &&
                      !document.querySelector('[role="dialog"], dialog[open]')) projectsToggle.current?.focus({ preventScroll: true });
                  });
                }}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <button
              className={`sidebar-global ${selectedId === undefined && !allSessionsSearch && !workspaceOverview ? 'active' : ''}`}
              onClick={() => selectNavigation(navigation)}
            >
              <Compass size={17} />
              {navigation === 'projects' ? t('Project overview') : t('Directories overview')}<span>{navigation === 'projects' ? projectCount : directoryCount}</span>
            </button>
            <button className={`sidebar-global ${workspaceOverview ? 'active' : ''}`} disabled={!boot}
              aria-pressed={workspaceOverview} onClick={openWorkspaceOverview}
              title={effectiveShortcuts['toggle-workspace-overview'] ? t('All workspaces ({{shortcut}})', { shortcut: effectiveShortcuts['toggle-workspace-overview'] }) : t('All workspaces')}>
              <LayoutGrid size={17} />{t('All workspaces')}<span>{Object.keys(workspace.panes).length}</span>
            </button>
            <div className="sidebar-section">
              <button className="sidebar-section-toggle" aria-expanded={!listCollapsed} aria-controls="sidebar-project-content"
                onClick={() => updateSidebar(navigation === 'projects' ? { projectsCollapsed: !listCollapsed } : { directoriesCollapsed: !listCollapsed })}>
                {listCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{navigationName}</span>
              </button>
              <button
                className="icon-button"
                title={t('Add project')}
                aria-label={t('Add project')}
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
                aria-label={navigation === 'projects' ? t('Search projects') : t('Search all directories')}
                placeholder={navigation === 'projects' ? t('Find a project…') : t('Find a directory…')}
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </div>
            <SidebarProjectList projects={sortedProjects} selectedId={selectedId} label={navigationName}
              workspace={workspace} activeTabId={view === 'workspace' ? activeTabId : undefined} onFocus={focus}
              reorderable={navigation === 'projects'} onSelect={selectProject}
              onReorder={(id, target, after) => updateSidebar({ projectOrder: reorderProject(reconcileProjectOrder(sidebarRef.current.projectOrder, projects), id, target, after) })}
              empty={projectSearch ? (navigation === 'projects' ? t('No matching projects') : t('No matching entries in all directories')) : navigation === 'projects'
                ? t('No projects yet. Pick from all directories, or add / create a project.')
                : t('No directories with sessions found yet. Check your sources and update the index.')} />
            </div>
            <button
              className="add-project"
              disabled={!boot}
              onClick={() => setProjectDialog({})}
            >
              <FolderPlus size={16} />
              {t('Add / create project')}
            </button>
            {workspace.tabs.some(tab => !sortedProjects.some(project => project.id === tab.projectId)) && (
              <section className="open-workspaces" aria-label={t('Open workspaces')}>
                <div className="sidebar-section"><button className="sidebar-section-toggle" aria-expanded={!sidebar.workspacesCollapsed} aria-controls="sidebar-open-workspaces"
                  onClick={() => updateSidebar({ workspacesCollapsed: !sidebar.workspacesCollapsed })}>
                  {sidebar.workspacesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{t('Open workspaces')}</span></button><span>{workspace.tabs.filter(tab => !sortedProjects.some(project => project.id === tab.projectId)).length}</span></div>
                <nav id="sidebar-open-workspaces" hidden={sidebar.workspacesCollapsed}>
                  {workspace.tabs.filter(tab => !sortedProjects.some(project => project.id === tab.projectId)).map((tab) => {
                    const project = visibleProjects.find((p) => p.id === tab.projectId);
                    return <button key={tab.id} className={view === 'workspace' && activeTabId === tab.id ? 'active' : ''}
                      aria-label={t('Open workspace {{project}} {{tab}}', { project: tab.projectId === null ? t('Temporary terminal') : project?.name || t('Working directory'), tab: tab.name })}
                      title={tab.projectId === null ? t('Not part of any project') : project?.launchPath || project?.path || t('Folder to be confirmed')} onClick={() => focus(tab.focusedPaneId)}>
                      <RuntimeActivityIndicator tab={tab} panes={workspace.panes} /><span><strong>{tab.projectId === null ? t('Temporary terminal') : project?.name || t('Working directory')}</strong>
                        <small>{tab.name}{project?.workspaceOnly ? t(' · workspace only') : ''}</small><small>{tabRuntimeSummary(tab, workspace.panes)}</small></span>
                    </button>;
                  })}
                </nav>
              </section>
            )}
          </ProjectNavigation>;
  return (
    <RuntimeActivityProvider><AttentionNotifier enabled={settings?.systemNotifications !== false} workspace={workspace} projects={projects} /><UpdateNotice enabled={!!settings && settings.updateChecks !== false} /><div className={`app-shell${compactWorkspace ? ' workspace-focus' : ''}`} data-focus-mode={focusMode} data-app-shell data-backend-ready={ready && desktop}>
      <a className="skip-link" href="#main-workspace">{t('Skip to main workspace')}</a>
      <header className="app-topbar">
        <div className="brand">
          <div className="brand-mark">
            <Anchor size={22} />
          </div>
          <span>
            Session Bay<span className="brand-tag">WORKSPACE</span>
          </span>
          <DevBadge />
        </div>
        <button className="global-search" aria-label={t('Search projects or run a command')} onClick={() => runCommand('command-palette')}>
          <Search size={15} />
          <span>{t('Search projects or run a command')}</span>
          <kbd>⌘ / Ctrl ⇧ P</kbd>
        </button>
        <div className="topbar-actions">
          {focusMode && !focusAvailable && <FocusModeButton active onClick={toggleFocusMode} />}
          <button className="secondary temporary-terminal-button" disabled={!boot || !desktop}
            title={t('Open a temporary terminal in your home folder without creating a project')} aria-label={t('Open temporary terminal')}
            onClick={() => openTemporaryTerminal()}>
            <TerminalSquare size={16} aria-hidden="true" /><span>{t('Temporary terminal')}</span>
          </button>
          <button className="icon-button theme-quick-trigger" aria-label={t('Quick theme switch')} title={t('Quick theme switch')}
            disabled={!settings || settingsOpen || themeSaving || palette}
            onClick={() => { setThemeSaveError(''); setQuickThemeOpen(true); }}>
            <Palette size={19} />
          </button>
          <button
            className="icon-button"
            aria-label={t('Settings and sources')}
            title={t('Settings and sources')}
            disabled={!boot || themeSaving || palette || quickThemeOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>
      <div className="app-body">
        {projectNavigation}
        <main className="main-content" id="main-workspace" tabIndex={-1}>
          <div className="project-header">
            <ResponsiveControls label={t('Project info and actions')} summary={pageTitle}>
            <div className="project-heading">
              <nav className="breadcrumb" aria-label={t('Current location')}>
                {!sidebarOpen && (
                  <button
                    className="icon-button" ref={projectsToggle}
                    aria-label={t('Show sidebar')}
                    onClick={() => setSidebarOpen(true)}
                  >
                    <Layers3 size={16} />
                  </button>
                )}
                <span>Session Bay</span>
                <ChevronRight size={12} />
                {current || allSessionsSearch || temporaryWorkspace || workspaceOverview ? <button className="breadcrumb-back" onClick={() => selectNavigation(navigation)}>{navigationName}</button> : <span aria-current="page">{navigationName}</span>}
                {workspaceOverview && <><ChevronRight size={12} /><span aria-current="page">{t('All workspaces')}</span></>}
                {temporaryWorkspace && <><ChevronRight size={12} /><span aria-current="page">{t('Temporary terminal')}</span></>}
                {current && <><ChevronRight size={12} /><span aria-current="page" title={current.name}>{current.name}</span></>}
                {allSessionsSearch && !current && <><ChevronRight size={12} /><span aria-current="page">{t('Search all sessions')}</span></>}
              </nav>
              <div className="project-title-row">
                {current && !current.workspaceOnly && <button className="icon-button project-membership" disabled={projectBusy}
                  aria-label={current.curated ? t('Remove from projects') : t('Add project')} aria-pressed={current.curated}
                  title={current.curated ? t('Remove from the project list; conversations, files and processes are untouched') : t('Add this working directory to the project list')}
                  onClick={() => void saveMembership(current, !current.curated)}>
                  <Star size={17} fill={current.curated ? 'currentColor' : 'none'} aria-hidden="true" />
                </button>}
                <h1 title={pageTitle}>
                  {pageTitle}
                </h1>
                {current && !current.workspaceOnly && <button className="icon-button project-rename" disabled={projectBusy}
                  title={t('Rename project')} aria-label={t('Rename project')}
                  onClick={event => { event.currentTarget.focus(); setRenameTarget({ kind: 'project', id: current.id, name: current.name }); }}>
                  <Pencil size={16} />
                </button>}
              </div>
              {current && <div className="project-path">
                <span title={current.path ?? ''}>
                  {current.launchPath || current.path || t('Unclassified · no working directory recorded')}
                </span>
                {current.launchPath && <span title={current.path ?? ''}>{t('· relocated')}</span>}
                <button
                  onClick={() =>
                    setPathDialog({
                      project: current,
                      path: current.launchPath || current.path || '',
                    })
                  }
                >
                  {t('Relocate')}
                </button>
              </div>}
            </div>
            <div className="header-buttons">
              {overviewReturn && !workspaceOverview && <button className="secondary" onClick={openWorkspaceOverview}>
                <LayoutGrid size={15} />{t('Back to all workspaces')}
              </button>}
              <button className="icon-button" title={t('Recycle bin')} aria-label={t('Recycle bin')} disabled={!boot} onClick={() => setTrashOpen(true)}><Trash2 size={17} /></button>
              {navigation === 'directories' && !current && !temporaryWorkspace && <button className="secondary" disabled={!boot}
                onClick={() => { setAllSessionsSearch((value) => !value); setView('history');  }}>
                {allSessionsSearch ? <Folder size={15} /> : <Search size={15} />}
                {allSessionsSearch ? t('Back to directories overview') : t('Search all sessions')}
              </button>}
              {temporaryWorkspace ? <button className="primary" onClick={() => openTemporaryTerminal()}>
                <Plus size={16} />{t('New temporary terminal')}
              </button> : current ? <>
                <button className="secondary" onClick={() => runCommand('new-terminal')}>
                  <TerminalSquare size={16} />Terminal
                </button>
                <button className="primary" onClick={() => runCommand('new-agent')}>
                  <Plus size={16} />{t('New work')}
                </button>
              </> : <button className="primary" disabled={!boot} onClick={() => setProjectDialog({})}>
                <FolderPlus size={16} />{t('Add / create project')}
              </button>}
            </div>
            </ResponsiveControls>
          </div>
          {!desktop ? (
            <div className="runtime-unavailable">
              <div className="empty-icon">
                <Anchor size={35} />
              </div>
              <span className="eyebrow">SESSION BAY DESKTOP</span>
              <h2>{t('Your local workbench, ready to set sail')}</h2>
              <p>{t('This is a web preview. Projects, conversation history and terminals need the macOS or Linux desktop runtime.')}</p>
              <div className="runtime-note">
                <AlertTriangle size={17} />
                <div>
                  <strong>{t('Desktop runtime not connected')}</strong>
                  <span>{t('Start it from the desktop app; this preview has no simulated data or processes.')}</span>
                </div>
              </div>
              <div className="runtime-features">
                <span>
                  <History size={16} />
                  {t('Find history across agents')}
                </span>
                <span>
                  <Layers3 size={16} />
                  {t('Split workspaces')}
                </span>
                <span>
                  <TerminalSquare size={16} />
                  {t('Real local PTYs')}
                </span>
              </div>
            </div>
          ) : bootError ? (
            <div className="empty-state">
              <AlertTriangle size={30} />
              <h2>{t('Cannot open the local workbench')}</h2>
              <p role="alert">{bootError}</p>
              <button className="primary" onClick={() => void initialize()}>
                {t('Try again')}
              </button>
            </div>
          ) : !boot ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={30} />
              <p>{t('Loading the local workbench…')}</p>
            </div>
          ) : (
            <>
              {current && !current.exists && (
                <div className="project-warning">
                  <AlertTriangle size={15} />
                  {t('The working directory does not exist. You can still read the history; relocate it before starting work.')}
                  <button
                    onClick={() =>
                      setPathDialog({
                        project: current,
                        path: current.launchPath || current.path || '',
                      })
                    }
                  >
                    {t('Choose new location')}
                  </button>
                </div>
              )}
              {(current || allSessionsSearch || temporaryWorkspace) && <div className="workspace-tab-bar"><div className="workspace-tabs">
                <WorkspaceTabs panes={workspace.panes} tabs={workspace.tabs.filter((tab) => tab.projectId === selectedId)}
                  mixedBadges={(tab) => tabProjectIds(tab, workspace.panes).map(projectBadge)}
                  activeId={view === 'workspace' ? activeTabId : undefined}
                  onSelect={(tab) => {
                    setWorkspace((w) => selectWorkspaceTab(w, tab));
                    setView('workspace');
                    setMaximizedId(null);
                  }}
                  onRename={(tab) => setRenameTarget({ kind: 'tab', id: tab.id, name: tab.name })}
                  onClose={(tab) => removePanes(paneIds(tab.layout))}
                  onReorder={(id, targetId, after) => setWorkspace((w) => reorderWorkspaceTab(w, id, targetId, after))} />
                <div className="project-file-tabs-host" ref={setFileTabsHost} />
                <div className="project-file-tabs-host" ref={setGitTabsHost} />
                {(current || temporaryWorkspace) && (
                  <button
                    className="icon-button"
                    aria-label={t('New workspace tab')}
                    onClick={() => openLauncher('shell')}
                  >
                    <Plus size={16} />
                  </button>
                )}
                </div>
                {focusedMixedPane && (() => {
                  const badge = projectBadge(focusedMixedPane.projectId);
                  // Re-keyed per project so the chip flashes and is announced whenever tools switch.
                  return <span key={badge.name} className="tool-context" role="status" aria-live="polite"
                    title={t('Sessions / Files / Git currently follow "{{name}}"', { name: badge.name })}>
                    {t('Tools: ')}<span className="project-initials" style={{ ['--pane-project' as string]: badge.color }}>{badge.initials}</span>{badge.name}
                  </span>;
                })()}
                {focusAvailable && <FocusModeButton buttonRef={focusToggle} active={focusMode} onClick={toggleFocusMode} />}
              </div>}
              <div className="main-work-area project-work-area" id="navigation-content" role="tabpanel" aria-labelledby={`navigation-${navigation}`}>
                <div className="project-work-content">
                <div className="project-file-document-host" ref={setFileDocumentHost} hidden={view !== 'files'} />
                <div className="project-file-document-host" ref={setGitDocumentHost} hidden={view !== 'git'} />
                {temporaryWorkspace && !activeTab && <div className="empty-state">
                  <TerminalSquare size={30} aria-hidden="true" /><h2>{t('No temporary terminal right now')}</h2>
                  <p>{t('Open a new command line in your home folder any time, without creating a project.')}</p>
                  <button className="primary" onClick={() => openTemporaryTerminal()}>{t('Open a new temporary terminal')}</button>
                </div>}
                {workspaceOverview && <WorkspaceOverview workspace={workspace} projects={visibleProjects} visible
                  onOpen={(paneId) => { beforeOverview.current = null; setOverviewReturn(true); focus(paneId); }}
                  onSplit={(ids) => {
                    const owner = workspace.panes[ids[0]]?.projectId;
                    if (owner === undefined) return;
                    const name = [...new Set(ids.map((id) => projectBadge(workspace.panes[id].projectId).name))].join(' + ');
                    beforeOverview.current = null;
                    setOverviewReturn(true);
                    setWorkspace((w) => createSplitTab(w, ids, name));
                    setSelectedId(owner);
                    setAllSessionsSearch(false);
                    setView('workspace');
                    setMaximizedId(null);
                  }} />}
                <div
                  className="history-mount"
                  style={{ display: view === 'history' && !workspaceOverview ? undefined : 'none' }}
                >
                  {lastHistoryProject.current !== undefined && <div style={{ height: '100%', display: historyVisible ? undefined : 'none' }}><HistoryView
                    openRequest={historyOpenRequest}
                    sidebarHost={toolProject ? historySidebarHost : undefined}
                    scopeLabel={toolProject?.name ?? t('All sessions')}
                    onSelectSession={() => { if (!current) setAllSessionsSearch(true); setView('history'); }}
                    projectId={lastHistoryProject.current ?? undefined}
                    disabled={!historyEnabled}
                    projects={projects}
                    refreshToken={refreshToken}
                    onHistoryChanged={refresh}
                    onResume={resume}
                    onCurate={curateSession}
                    curating={projectBusy}
                    onNew={() => openLauncher(settings?.defaultAgent ?? 'codex')}
                  /></div>}
                  {!historyVisible && <DirectoryOverview page={navigation} projects={sortedProjects} searching={!!projectSearch}
                    busy={projectBusy} onSelect={selectProject} onMembership={saveMembership}
                    onAdd={() => setProjectDialog({})} onDirectories={() => selectNavigation('directories')}
                    openCounts={projectOpenCounts} />}
                </div>
                {settings && (
                  <WorkspaceCanvas
                    workspace={workspace}
                    projects={visibleProjects}
                    onMoveHome={(id) => setWorkspace((w) => movePaneHome(w, id))}
                    knownProjectIds={projects.map((project) => project.id)}
                    activeTabId={activeTabId}
                    settings={visibleSettings ?? settings}
                    visible={view === 'workspace' && !workspaceOverview}
                    maximizedId={maximizedId}
                    onPatch={patchPane}
                    onOpenFileLink={(paneId, request) => {
                      const pane = stateRef.current.workspace.panes[paneId];
                      if (!pane?.projectId || !pane.runtimeId || stateRef.current.selectedId !== pane.projectId || stateRef.current.view !== 'workspace') return;
                      setTerminalFileIntent({ pane: { ...pane, projectId: pane.projectId, runtimeId: pane.runtimeId }, request,
                        generation: fileContext.current.generation, nonce: ++quickRequestNonce.current });
                    }}
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
                            throw new Error(t('This managed process is no longer in the background process list; refresh and try again.'));
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
                {visitedFileProjects.filter((id) => projects.some((project) => project.id === id)).map((id) => <WorkspaceFiles key={id}
                  onTabsChange={onFileTabsChange} openRequest={fileOpenRequest?.projectId === id ? fileOpenRequest : undefined}
                  sidebarSide="right" projectId={id} visible={toolProject?.id === id} active={view === 'files' && toolProject?.id === id}
                  sidebarVisible={toolProject?.id === id && filesVisible} sidebarHost={fileSidebarHost} tabsHost={fileTabsHost} documentHost={fileDocumentHost}
                  onActivate={() => setView('files')} onEmpty={() => {
                    setView(activeTab ? 'workspace' : 'history');
                    const owner = document.activeElement;
                    if (!filesVisible && owner?.closest('.project-file-tabs-group, [data-file-explorer]')) {
                      let superseded = false;
                      const moved = () => { superseded = true; };
                      document.addEventListener('focusin', moved, { once: true });
                      requestAnimationFrame(() => {
                        document.removeEventListener('focusin', moved);
                        if (!superseded && stateRef.current.selectedId === id && stateRef.current.view === (activeTab ? 'workspace' : 'history') && !document.querySelector('[role="dialog"], dialog[open]') &&
                          (document.activeElement === owner || document.activeElement === document.body)) filesToggle.current?.focus({ preventScroll: true });
                      });
                    }
                  }} onHideSidebar={hideFilesSidebar} />)}
                {visitedGitProjects.filter((id) => projects.some((project) => project.id === id)).length > 0 && <Suspense fallback={null}>
                  {visitedGitProjects.filter((id) => projects.some((project) => project.id === id)).map((id) => <GitWorkbench key={id}
                    projectId={id} visible={toolProject?.id === id} active={view === 'git' && toolProject?.id === id}
                    sidebarVisible={toolProject?.id === id && gitVisible} sidebarHost={gitSidebarHost} tabsHost={gitTabsHost}
                    documentHost={gitDocumentHost} onActivate={() => setView('git')} onDocumentsChange={onGitDocumentsChange}
                    openFiles={filePaths[id]}
                    projectName={projects.find((project) => project.id === id)?.name}
                    onOpenWorktree={(path, startWork) => {
                      void api.addProject(path).then(async (project) => {
                        await refresh();
                        if (startWork) pendingWorktreeLaunch.current = project.id;
                        selectProject(project);
                      }).catch(notify);
                    }}
                    onEmpty={() => setView(activeTab ? 'workspace' : 'history')} onHideSidebar={hideGitSidebar} />)}
                </Suspense>}
              </div>
            </>
          )}
        </main>
        <div className="project-activity-tools" hidden={!current}>
          <ActivityShell scopeKey={current?.id} contributions={activities} activeId={activeActivity} onActiveChange={setActiveActivity} />
        </div>
      </div>
      <footer className={`statusbar${index.running || index.errors.length || index.cancelled || zoomError || themeSaving ? ' statusbar-important' : ''}`}>
        <div>
          {index.running ? (
            <>
              <LoaderCircle className="spin" size={12} />
              <span role="status" aria-live="polite">
                {t('Updating index {{processed}} / {{total}}', { processed: index.processed, total: index.total })}
              </span>
              <button
                title={t('Cancel indexing')}
                aria-label={t('Cancel indexing')}
                onClick={() => void api.cancelScan().catch(notify)}
              >
                <Square size={10} />
              </button>
            </>
          ) : (
            <>
              <span className={`tiny-dot ${index.errors.length ? 'warn' : ''}`} />
              <span role="status" aria-live="polite" title={index.errors.join("\n") || undefined}>
                {!desktop
                  ? t('Web preview · desktop features not connected')
                  : index.cancelled
                    ? t('Indexing cancelled')
                    : index.errors.length
                      ? t('{{count}} source problems', { count: index.errors.length })
                      : t('Local index ready')}
              </span>
              <button
                title={t('Update index')}
                aria-label={t('Update index')}
                disabled={!boot}
                onClick={() => void scan(false).catch(notify)}
              >
                <RefreshCw size={12} />
              </button>
            </>
          )}
        </div>
        <div>
          <span>{t('{{count}} running processes', { count: activeCount })}</span>
          {visibleSettings && <span role="status" aria-live="polite" title={t('Adjusts the size of the interface and terminals. ') + workspaceZoomShortcutHelp}>{t('Zoom {{percent}}%', { percent: appliedZoom ?? 100 })}{zoomError ? t(' · zoom failed') : appliedZoom !== zoomPercent ? t(' · applying') : ''}{themeSaving ? t(' · saving') : ''}</span>}
          <span className="status-separator">│</span>
          <span>
            {focusPane && view === 'workspace'
              ? `${focusPane.title} · ${focusPane.cwd}`
              : current
                ? t('Last activity {{time}}', { time: dateLabel(current.updatedAt) })
                : t('Local agent workbench')}
          </span>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="alert">
          <AlertTriangle size={17} />
          <span>{toast}</span>
          <button aria-label={t('Close notice')} onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {quickThemeOpen && visibleSettings && (
        <Dialog title={t('Quick theme switch')} onClose={() => setQuickThemeOpen(false)}>
          <div className="theme-quick-content">
            <ThemeControls value={appearanceOf(visibleSettings)} disabled={themeSaving}
              onChange={(patch) => void quickSaveTheme(patch)} />
            <TerminalPreview value={appearanceOf(visibleSettings)} />
            {(themeSaving || themeSaveError) && <div className="theme-quick-status" role="status">{themeSaving ? t('Saving theme…') : t('Showing the last saved theme')}</div>}
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
          onboarding={welcomeOpen}
          onSave={saveSettings}
          onImportProduction={isDevBuild ? async () => {
            const imported = await api.importProductionProfile();
            setAppearancePreview(null);
            setBoot(current => current ? { ...current, settings: imported, installations: [] } : current);
            await refresh();
            notify(t('Imported settings and projects from Session Bay.'));
          } : undefined}
          onClose={() => {
            setAppearancePreview(null); setSettingsOpen(false);
            if (welcomeOpen) { markWelcomeSeen(); setWelcomeOpen(false); }
          }}
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
          title={pathDialog.project ? t('Relocate project folder') : t('Add project')}
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
                ? t('Only changes where new processes start. The original records and working directory are not modified.')
                : t('Enter the full path of a local folder. You can open an agent or terminal even without history.')}
            </p>
            {pathDialog.project?.path && (
              <p className="original-path">{t('Original path: {{path}}', { path: pathDialog.project.path })}</p>
            )}
            <DirectoryPathField key={pathDialog.project?.id ?? 'new'} label={t('Folder path')}
              autoFocus required disabled={busy}
              placeholder={t('/Users/you/projects/my-app or /home/you/projects/my-app')}
              value={pathDialog.path}
              onChange={(path) => setPathDialog((current) => current ? { ...current, path } : null)} />
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setPathDialog(null)}
              >
                {t('Cancel')}
              </button>
              <button className="primary" disabled={busy || !pathDialog.path.trim()}>
                {busy ? t('Saving…') : pathDialog.project ? t('Save new location') : t('Add project')}
                <ArrowRight size={14} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {launcher && settings && (
        <Dialog
          title={launcher.split ? t('Split and add a pane') : t('Start a new task')}
          onClose={() => setLauncher(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // Enter in the existing-work search must never start new work.
              if (launcher.existing) return;
              if (current && launchPreview && !previewPending && !previewError && (launcher.kind === 'shell' || (isAgentEnabled(settings, launcher.kind) && boot?.installations.find((item) => item.kind === launcher.kind)?.available !== false))) {
                const accepted = addPane(
                  current,
                  launcher.kind,
                  launcher.cwd.trim(),
                  launcher.profileId,
                  undefined,
                  launcher.split,
                  launcher.resumeId?.trim() || undefined,
                );
                if (accepted) setLauncher(null);
              }
            }}
          >
            <div className="launch-kind-switch" role="group" aria-label={t('Work type')}>
              <button type="button" aria-pressed={!launcher.existing && launcher.kind === 'shell'}
                onClick={() => setLauncher({ ...launcher, kind: 'shell', resumeId: undefined, existing: false })}>
                <TerminalSquare size={19} />Shell<span>{t('Command-line work')}</span>
              </button>
              <button type="button" aria-pressed={!launcher.existing && launcher.kind !== 'shell'}
                disabled={!preferredEnabledAgent(settings)}
                onClick={() => setLauncher({ ...launcher, kind: preferredEnabledAgent(settings) ?? settings.defaultAgent, resumeId: undefined, existing: false })}>
                <CommandIcon size={19} />Agent<span>{t('AI pairing')}</span>
              </button>
              {launcher.split && <button type="button" aria-pressed={!!launcher.existing}
                onClick={() => setLauncher({ ...launcher, existing: true })}>
                <Layers3 size={19} />{t('Existing work')}<span>{t('Any project')}</span>
              </button>}
            </div>
            {launcher.existing && launcher.split && <SplitExistingPicker workspace={workspace} targetPaneId={launcher.split.paneId}
              projects={visibleProjects} badge={projectBadge}
              onPickPane={(paneId) => {
                const split = launcher.split!;
                setWorkspace((w) => movePaneIntoSplit(w, paneId, split.paneId, split.axis));
                setLauncher(null);
                setView('workspace');
                setMaximizedId(null);
              }}
              onPickSession={(session) => {
                const split = launcher.split;
                setLauncher(null);
                resume(session, undefined, split);
              }} />}
            {!launcher.existing && <>
            {launcher.kind !== 'shell' && <label className="field-label">
              Agent
              <Select aria-label="Agent" value={launcher.kind}
                onChange={(kind) => setLauncher({ ...launcher, kind: kind as AgentKind, resumeId: undefined })}
                options={agentKinds.map((kind) => {
                  const installation = boot?.installations.find((item) => item.kind === kind);
                  return { value: kind, label: agentName(kind), icon: <AgentIcon kind={kind} />,
                    disabled: !isAgentEnabled(settings, kind) || installation?.available === false,
                    description: !isAgentEnabled(settings, kind) ? t('Disabled; enable it in Settings') : installationState(installation).text };
                })} />
              {!isAgentEnabled(settings, launcher.kind) && <span className="inline-warning">{t('This agent is disabled; enable it in Settings first.')}</span>}
              {boot?.installations.find((item) => item.kind === launcher.kind)?.available === false &&
                <span className="inline-warning">{t('This agent was not found; set its executable in Settings and detect again.')}</span>}
            </label>}
            <DirectoryPathField key={`${current?.id}:${launcher.kind}`} label={t('Working directory')}
              required value={launcher.cwd}
              onChange={(cwd) => setLauncher((current) => current ? { ...current, cwd } : null)} />
            {launcher.kind !== 'shell' && agentCapabilities[launcher.kind].resume.manualId && (
              <label className="field-label">{t('Conversation ID to resume (optional)')}
                <input value={launcher.resumeId || ''} placeholder={t('Leave empty for a new conversation, or enter the tool\'s conversation ID')}
                  onChange={(event) => setLauncher({ ...launcher, resumeId: event.target.value })} />
                <span className="small-muted">{t(agentCapabilities[launcher.kind].resume.description)}
                  {!agentCapabilities[launcher.kind].history.supported && t(' Automatic indexing and preview of its history are not supported yet.')}</span>
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
            <div className="launch-preview" aria-label={t('Launch arguments preview')} aria-live="polite">
              <strong>{t('Actual launch preview')}</strong>
              {previewPending ? <p>{t('Checking the executable and folder…')}</p> : previewError ? <p role="alert">{previewError}</p> : launchPreview && <>
                <pre>{JSON.stringify([launchPreview.executable, ...launchPreview.args], null, 2)}</pre>
                <p>{t('Working directory: {{path}}', { path: launchPreview.cwd })}</p>
              </>}
            </div>
            {launcher.kind !== 'shell' && settings.agentOptions?.[launcher.kind]?.bypassPermissions &&
              <p className="inline-warning">{t('High-risk permission mode is on. Default {{flag}}; the preview above shows the actual arguments. The agent may read, write or delete files without asking.', { flag: bypassFlags[launcher.kind] })}</p>}
            {freshLaunchPending && <p className="small-muted" role="status">{t('The previous agent is still starting; wait a moment before starting new agent work.')}</p>}
            </>}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setLauncher(null)}>
                {t('Cancel')}
              </button>
              {!launcher.existing && <button className="primary" disabled={!launcher.cwd.trim() || previewPending || !launchPreview || !!previewError || (launcher.kind !== 'shell' && ((!launcher.resumeId?.trim() && freshLaunchPending) || !isAgentEnabled(settings, launcher.kind) || boot?.installations.find((item) => item.kind === launcher.kind)?.available === false))}>
                {t('Start work')}
                <ArrowRight size={14} />
              </button>}
            </div>
          </form>
        </Dialog>
      )}
      {renameTarget && <RenameDialog key={`${renameTarget.kind}:${renameTarget.id}`}
        title={renameTarget.kind === 'tab' ? t('Rename tab') : t('Rename project')} name={renameTarget.name}
        description={renameTarget.kind === 'tab' ? undefined : t('Only changes the display name; the folder, path and conversation history stay the same.')}
        onClose={() => setRenameTarget(null)} onSave={async (name) => {
          if (renameTarget.kind === 'tab') {
            if (!stateRef.current.workspace.tabs.some((tab) => tab.id === renameTarget.id)) throw new Error(t('This tab was closed; choose again.'));
            setWorkspace((w) => renameWorkspaceTab(w, renameTarget.id, name));
            return;
          }
          if (projectMutation.current) throw new Error(t('The project is updating; try again shortly.'));
          projectMutation.current = true;
          setProjectBusy(true);
          try {
            const result = await api.updateProject(renameTarget.id, { name });
            projectReadGeneration.current++;
            setProjects((previous) => previous.map((project) => project.id === result.id ? result : project));
          } finally { projectMutation.current = false; setProjectBusy(false); }
        }} />}
      {hookSkip && (
        <Dialog title={t('Skip activity reporting this time')} onClose={() => finishHookSkip(false)}>
          <p className="dialog-description">{hookSkip.message}</p>
          <p className="dialog-description">{t('Only skips the activity hooks this time; launch arguments and permissions stay the same. Existing work and hook settings are unchanged.')}</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => finishHookSkip(false)}>{t('Cancel')}</button>
            <button className="primary" onClick={() => finishHookSkip(true)}>{t('Skip activity reporting and start')}</button>
          </div>
        </Dialog>
      )}
      {confirmation && (
        <Dialog title={confirmation.title} onClose={() => { if (!busy) { confirmation.onCancel?.(); setConfirmation(null); } }}>
          <p className="dialog-description">{confirmation.text}</p>
          <div className="dialog-actions">
            <button className="secondary" disabled={busy} onClick={() => { confirmation.onCancel?.(); setConfirmation(null); }}>
              {t('Cancel')}
            </button>
            <button
              className="danger"
              data-dialog-confirm
              disabled={busy}
              onClick={() => {
                if (confirmationLock.current) return;
                confirmationLock.current = true;
                setBusy(true);
                void confirmation
                  .action()
                  .then(() => setConfirmation(null))
                  .catch(notify)
                  .finally(() => { confirmationLock.current = false; setBusy(false); });
              }}
            >
              {busy ? t('Working…') : t('End and close')}
            </button>
          </div>
        </Dialog>
      )}
      {terminalFileIntent && fileIntentValid(terminalFileIntent) && <TerminalFileDialog key={terminalFileIntent.nonce}
        pane={terminalFileIntent.pane} request={terminalFileIntent.request} valid={() => fileIntentValid(terminalFileIntent)}
        onClose={() => setTerminalFileIntent(undefined)} onOpen={(file, target) => {
          if (!fileIntentValid(terminalFileIntent)) return;
          setTerminalFileIntent(undefined);
          const nonce = ++quickRequestNonce.current;
          setFileOpenRequest({ projectId: terminalFileIntent.pane.projectId, path: file.path, nonce,
            reference: { line: target.line, column: target.column, version: file.version, nonce } });
          setView('files');
        }} />}
      {quickOpen && current && <Dialog title={t('Quick open · {{name}}', { name: current.name })} onClose={() => setQuickOpen(false)}>
        <ProjectQuickSwitcher projectId={current.id}
          openedSessionIds={workspace.tabs.filter(tab => tab.projectId === current.id).flatMap(tab => paneIds(tab.layout).flatMap(id => [workspace.panes[id]?.sessionId ?? '', workspace.panes[id]?.resumeId ? `${workspace.panes[id].kind}:${workspace.panes[id].resumeId}` : ''].filter(Boolean)))}
          opened={[
            ...workspace.tabs.filter(tab => tab.projectId === current.id).map(tab => ({
              id: `runtime:${tab.id}`, label: <>{workspace.panes[tab.focusedPaneId]?.kind && workspace.panes[tab.focusedPaneId].kind !== 'shell' ? <AgentIcon kind={workspace.panes[tab.focusedPaneId].kind as AgentKind} /> : <TerminalSquare size={15} aria-hidden="true" />}{tab.name}</>,
              search: `${tab.name} ${paneIds(tab.layout).map(id => workspace.panes[id]?.title ?? '').join(' ')}`,
              detail: <small>{t('Open · {{kind}}', { kind: paneIds(tab.layout).some(id => workspace.panes[id]?.kind !== 'shell') ? 'Agent' : 'Terminal' })}</small>,
              run: () => { setQuickOpen(false); focus(tab.focusedPaneId); setQuickRuntimeFocus({ paneId: tab.focusedPaneId, nonce: ++quickRequestNonce.current }); },
            })),
            ...(filePaths[current.id] ?? []).map(path => ({
              id: `file:${path}`, label: <><FileIcon path={path} />{path}</>, search: path, detail: <small>{t('Open · file')}</small>,
              run: () => { setQuickOpen(false); setFileOpenRequest({ projectId: current.id, path, nonce: ++quickRequestNonce.current }); },
            })),
          ]}
          onOpenFile={path => { setQuickOpen(false); setFileOpenRequest({ projectId: current.id, path, nonce: ++quickRequestNonce.current }); }}
          onOpenSession={session => { setQuickOpen(false); setHistoryOpenRequest({ session, nonce: ++quickRequestNonce.current }); setView('history'); showSessions(); }} />
      </Dialog>}
      {palette && (
        <Dialog title={t('Command palette')} onClose={closePalette}>
          {paletteTheme && settings ? <CommandThemePicker key={paletteTheme} target={paletteTheme}
            value={appearanceOf(settings)} saving={themeSaving} error={themeSaveError}
            onPreview={setCommandThemePreview} onCommit={patch => void commitCommandTheme(patch)}
            onBack={closePaletteTheme} /> : <CommandPalette query={paletteQuery} onQueryChange={setPaletteQuery}
            options={[
              ...commands.filter(command => command.id !== 'command-palette').map(command => ({
                id: `command-${command.id}`, label: command.label, search: command.label,
                detail: command.shortcut ? <kbd>{command.shortcut}</kbd> : undefined, disabled: command.disabled,
                run: () => { if (!command.id.startsWith('theme-')) closePalette(); command.run(); },
              })),
              ...projects.filter(project => project.curated)
                .filter(project => `${project.name} ${project.path}`.toLowerCase().includes(paletteQuery.toLowerCase()))
                .slice(0, 20).map(project => ({
                  id: `project-${project.id}`, label: <><Folder size={14} />{project.name}</>,
                  search: `${project.name} ${project.path}`, detail: <small>{project.path || t('Unclassified')}</small>,
                  run: () => { selectProject(project); closePalette(); },
                })),
            ]} />}
        </Dialog>
      )}
    </div></RuntimeActivityProvider>
  );
}
