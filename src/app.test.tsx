import { agentNames, defaultAgentOptions } from './agents';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api, isDesktop } from './api';
import type { AgentKind, Bootstrap, Installation, LaunchPreview, Pane, Project, RuntimeInfo, RuntimeRecord, Session, Workspace } from './types';
import { canPickDirectory, pickDirectory } from './directory-picker';
vi.mock('./directory-picker', () => ({ canPickDirectory: vi.fn(() => false), pickDirectory: vi.fn() }));
import { emptyWorkspace } from './workspace';
import { startup } from './startup';
import { runSmokeInteraction } from './smoke';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload?: unknown }) => void>(),
  patch: undefined as ((id: string, patch: Partial<Pane>) => void) | undefined,
  sessionCwd: undefined as string | null | undefined,
  sessionTitle: 'Synthetic session',
  sessionKind: 'codex' as AgentKind,
  resumeDisabledReason: undefined as string | undefined,
  historyRender: vi.fn(),
  canvasMounted: vi.fn(),
  canvasUnmounted: vi.fn(),
  alreadyOpen: undefined as ((id: string, info: RuntimeInfo) => void) | undefined,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload?: unknown }) => void) => {
    native.handlers.set(name, handler);
    return Promise.resolve(vi.fn());
  }),
}));
vi.mock('./api', () => ({
  isDesktop: vi.fn(() => false),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: {
    bootstrap: vi.fn(),
    scan: vi.fn(),
    index: vi.fn(),
    projects: vi.fn(),
    saveWorkspace: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    forget: vi.fn(),
    settleLaunches: vi.fn(),
    runtimes: vi.fn(),
    launch: vi.fn(),
    detect: vi.fn(),
    detectShells: vi.fn(),
    detectHistorySources: vi.fn(),
    cancelScan: vi.fn(),
    clearIndex: vi.fn(),
    saveSettings: vi.fn(),
    setWorkspaceZoom: vi.fn(),
    updateProject: vi.fn(),
    addProject: vi.fn(),
    createProject: vi.fn(),
    preview: vi.fn(),
  },
}));
vi.mock('./components/History', () => ({
  agentName: (kind: AgentKind) => agentNames[kind],
  dateLabel: () => '測試時間',
  HistoryView: ({ projects, projectId, onCurate, curating, onResume }: {
    projects: Project[];
    projectId?: string;
    onCurate?: (session: Session) => void;
    curating?: boolean;
    onResume: (session: Session) => void;
  }) => {
    native.historyRender(projectId);
    const project = projects.find((entry) => entry.id === projectId);
    const session: Session | undefined = project ? {
      id: 'synthetic-session', sourceId: 'synthetic-source', kind: native.sessionKind, externalId: 'external',
      projectId: project.id, title: native.sessionTitle,
      cwd: native.sessionCwd === undefined ? project.path : native.sessionCwd,
      updatedAt: '2026-10-15T01:00:00Z', timeSource: 'event', archived: false,
      parentId: null, partial: false, snippet: null, resumeDisabledReason: native.resumeDisabledReason,
    } : undefined;
    return <div data-testid="history-view">
      <input id="session-search" aria-label="搜尋 Session" />
      <output data-testid="history-projects">{JSON.stringify(projects)}</output>
      <output data-testid="history-selected-project">{projectId ?? 'all'}</output>
      {session && <>
        <button disabled={curating} onClick={() => onCurate?.(session)}>Curate synthetic history project</button>
        <button onClick={() => onResume(session)}>Resume synthetic history session</button>
      </>}
    </div>;
  },
}));
vi.mock('./components/WorkspaceCanvas', () => ({
  WorkspaceCanvas: ({
    workspace,
    onPatch,
    onClose,
    onStart,
    onAlreadyOpen,
  }: {
    workspace: Workspace;
    onPatch: (id: string, patch: Partial<Pane>) => void;
    onClose: (id: string) => void;
    onStart: (id: string) => void;
    onAlreadyOpen: (id: string, info: RuntimeInfo) => void;
  }) => {
    useEffect(() => {
      native.canvasMounted();
      return () => { native.canvasUnmounted(); };
    }, []);
    native.patch = onPatch;
    native.alreadyOpen = onAlreadyOpen;
    return (
      <div data-testid="workspace-canvas">
        <output data-testid="workspace-snapshot">{JSON.stringify(workspace)}</output>
        <button onClick={() => onPatch('pane-a', { title: 'Latest saved title' })}>
          Update synthetic pane
        </button>
        <button onClick={() => onPatch('pane-a', { state: 'running', runtimeId: 'runtime-a' })}>
          Mark synthetic runtime running
        </button>
        <button onClick={() => onPatch('pane-a', { state: 'starting' })}>
          Mark synthetic runtime starting
        </button>
        <button onClick={() => onClose('pane-a')}>Close synthetic pane</button>
        <button onClick={() => onStart('pane-a')}>Restart synthetic pane</button>
      </div>
    );
  },
}));

function bootstrap(): Bootstrap {
  return {
    runtimes: [],
    settings: {
      version: 1,
      theme: 'dark',
      terminalTheme: 'bay',
      fontFamily: 'monospace',
      fontSize: 14,
      appZoom: 100,
      defaultAgent: 'codex',
      defaultProfileId: 'default',
      profiles: [{ id: 'default', name: 'Shell', executable: '/bin/bash', args: ['-l'], env: {} }],
      sources: [],
      agentOptions: defaultAgentOptions(),
      executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
      shortcuts: {},
      onboardingComplete: true,
    },
    projects: [
      {
        id: 'project-a',
        name: 'Synthetic project',
        path: '/synthetic/project',
        launchPath: null,
        exists: true,
        pinned: false,
        curated: true,
        sessionCount: 0,
        updatedAt: null,
        agents: [],
      },
    ],
    installations: [],
    index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
    warnings: [],
    workspace: {
      version: 1,
      panes: {
        'pane-a': {
          id: 'pane-a',
          kind: 'shell',
          title: 'Saved shell',
          projectId: 'project-a',
          cwd: '/synthetic/project',
          profileId: 'default',
          state: 'running',
          runtimeId: 'old-runtime',
          startToken: 7,
        },
      },
      tabs: [
        {
          id: 'tab-a',
          projectId: 'project-a',
          name: 'Terminal',
          focusedPaneId: 'pane-a',
          layout: { kind: 'pane', paneId: 'pane-a' },
        },
      ],
      activeTabByProject: { 'project-a': 'tab-a' },
    },
  };
}
function brokerRecord(patch: Partial<RuntimeRecord> = {}): RuntimeRecord {
  return { id: 'runtime-a', paneId: 'pane-a', kind: 'shell', projectId: 'project-a',
    sessionId: null, resumeId: null, profileId: null, cwd: '/synthetic/project',
    state: 'running', exitCode: null, ...patch };
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function changePage(name: '專案' | '所有目錄') {
  fireEvent.click(within(screen.getByRole('tablist', { name: '導覽頁面' })).getByRole('tab', { name: new RegExp(`^${name}(?:\\s+\\d+)?$`) }));
}
function selectGroup(name = 'Synthetic project', page: '專案' | '所有目錄' = '專案') {
  fireEvent.click(within(screen.getByRole('navigation', { name: page })).getByRole('button', { name: new RegExp(`^${name}`) }));
}
async function nativeClose() {
  await act(async () => {
    native.handlers.get('app-close-requested')?.({});
  });
}

beforeEach(() => {
  vi.mocked(canPickDirectory).mockReturnValue(false);
  vi.mocked(pickDirectory).mockReset();

  vi.mocked(api.setWorkspaceZoom).mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  vi.useFakeTimers();
  native.handlers.clear();
  native.patch = undefined;
  native.sessionCwd = undefined;
  native.sessionTitle = 'Synthetic session';
  native.sessionKind = 'codex';
  native.resumeDisabledReason = undefined;
  native.alreadyOpen = undefined;
  vi.mocked(isDesktop).mockReturnValue(false);
  vi.mocked(api.updateProject).mockReset();
  vi.mocked(api.addProject).mockReset();
  vi.mocked(api.createProject).mockReset();
  vi.mocked(api.bootstrap).mockReset().mockResolvedValue(bootstrap());
  vi.mocked(api.scan).mockResolvedValue(bootstrap().index);
  vi.mocked(api.index).mockResolvedValue(bootstrap().index);
  vi.mocked(api.projects).mockReset().mockResolvedValue(bootstrap().projects);
  vi.mocked(api.saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(api.close).mockResolvedValue(undefined);
  vi.mocked(api.stop).mockResolvedValue(undefined);
  vi.mocked(api.preview).mockResolvedValue({ executable: '/bin/bash', args: ['-l'], cwd: '/synthetic/project' });
  vi.mocked(api.runtimes).mockResolvedValue([]);
  vi.mocked(api.forget).mockResolvedValue(undefined);
  vi.mocked(api.settleLaunches).mockResolvedValue(undefined);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App browser preview', () => {
  it('shows desktop-unavailable state without bootstrapping or starting any runtime', async () => {
    render(<App />);
    await tick(1000);
    expect(screen.getByText('桌面執行環境未連線')).toBeInTheDocument();
    expect(screen.getByText('網頁預覽 · 桌面功能未連線')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '設定與資料來源' })).toBeDisabled();
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
    expect(native.handlers.size).toBe(0);
  });
  it('opens and closes the command palette by keyboard without leaking commands behind the modal', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜尋命令或專案' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('button', { name: '隱藏側欄' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.bootstrap).not.toHaveBeenCalled();
  });
  it('opens the palette from search and closes it when a safe command is selected', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    const palette = screen.getByRole('dialog', { name: '命令面板' });
    expect(within(palette).getByRole('button', { name: /開啟 Terminal/ })).toBeDisabled();
    fireEvent.click(within(palette).getByRole('button', { name: /顯示／隱藏側欄/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '顯示側欄' })).toBeInTheDocument();
    expect(api.launch).not.toHaveBeenCalled();
  });
});

describe('App desktop lifecycle', () => {
  it('keeps bootstrap failure observable and allows a successful retry', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.bootstrap).mockRejectedValueOnce(new Error('Temporary database failure'));
    const failed = vi.spyOn(startup, 'backendError');
    const ready = vi.spyOn(startup, 'ready');
    render(<App />);
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Temporary database failure');
    expect(failed).toHaveBeenCalledWith('Temporary database failure');
    expect(ready).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新嘗試' }));
    await tick();
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('無法開啟本機工作台')).not.toBeInTheDocument();
    expect(ready).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  });

  it('runs the smoke settings open/close/reopen flow against real React controls without writes', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.settings.onboardingComplete = false;
    data.projects = [];
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40 } as DOMRect);
    render(<App />);
    await tick();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const interaction = runSmokeInteraction();
    for (let i = 0; i < 30; i++) await tick(20);
    await interaction;
    expect(screen.getByRole('dialog', { name: '加入或建立專案' })).toBeInTheDocument();
    expect(screen.getByLabelText('上層目錄路徑')).toHaveValue('');
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
  });

  it('exposes restored workspace-only projects even when the catalog is initially empty', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects = [];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 project Terminal' }));
    expect(screen.getByRole('heading', { name: 'project' })).toBeInTheDocument();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('keeps running workspace projects reachable after source removal and removes their fallback after close', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    vi.mocked(api.projects).mockResolvedValue([]);
    vi.mocked(api.index).mockResolvedValue({ ...bootstrap().index, revision: 2 });
    await tick(1100);
    expect(screen.getByText(/僅工作區/)).toBeInTheDocument();
    changePage('所有目錄');
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    vi.mocked(api.runtimes).mockResolvedValue([brokerRecord()]);
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pane' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '關閉 1 個面板？' })).getByRole('button', {
        name: '結束並關閉',
      }),
    );
    await tick();
    expect(screen.queryByText(/僅工作區/)).not.toBeInTheDocument();
    expect(api.stop).toHaveBeenCalledWith('runtime-a');
  });

  it('preserves an unreadable saved workspace until the user changes the layout', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.workspace = { version: 99, futureData: 'keep original file' };
    data.warnings = ['Saved workspace has a newer version; original file retained'];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick(500);
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    await nativeClose();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledTimes(1);
  });
  it('saves a replacement for an unreadable layout only after explicit new work', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.workspace = { version: 99, futureData: 'keep original file' };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick(500);
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    await tick(200);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '開始新的工作' })).getByRole('button', {
        name: '開始工作',
      }),
    );
    await tick(500);
    expect(api.saveWorkspace).toHaveBeenCalledTimes(1);
    expect(api.saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, tabs: expect.any(Array) }),
    );
  });
  it('does not persist runtime-only state changes to a restored layout', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    await tick(500);
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });
  it('never overwrites saved layout when bootstrap failed before native close', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.bootstrap).mockRejectedValue(new Error('Unsupported newer database schema'));
    render(<App />);
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported newer database schema');
    await nativeClose();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledTimes(1);
  });
  it('restores saved layout as placeholders without automatically launching previous commands', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    const workspace = JSON.parse(
      screen.getByTestId('workspace-snapshot').textContent!,
    ) as Workspace;
    expect(workspace.panes['pane-a']).toMatchObject({ state: 'placeholder', title: 'Saved shell' });
    expect(workspace.panes['pane-a'].runtimeId).toBeUndefined();
    expect(workspace.panes['pane-a'].startToken).toBeUndefined();
    expect(api.launch).not.toHaveBeenCalled();
    expect(screen.getByText('0 個執行中程序')).toBeInTheDocument();
  });
  it.each([
    { kind: 'codex' as const, sessionId: 'saved-session', expectedCwd: '/synthetic/new' },
    { kind: 'shell' as const, sessionId: undefined, expectedCwd: '/synthetic/alternate' },
  ])(
    'explicit restart uses the correct cwd for $kind restored panes',
    async ({ kind, sessionId, expectedCwd }) => {
      vi.mocked(isDesktop).mockReturnValue(true);
      const data = bootstrap();
      data.projects[0].launchPath = '/synthetic/new';
      const savedWorkspace = data.workspace as Workspace;
      savedWorkspace.panes['pane-a'] = {
        ...savedWorkspace.panes['pane-a'],
        kind,
        sessionId,
        cwd: '/synthetic/alternate',
      };
      vi.mocked(api.bootstrap).mockResolvedValue(data);
      render(<App />);
      await tick();
      let current = JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
      expect(current.panes['pane-a'].startToken).toBeUndefined();
      fireEvent.click(screen.getByRole('button', { name: 'Restart synthetic pane' }));
      current = JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
      expect(current.panes['pane-a']).toMatchObject({ cwd: expectedCwd, startToken: 1 });
    },
  );
  it('saves the latest layout before handling a native close with no live programs', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Update synthetic pane' }));
    await nativeClose();
    expect(api.saveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        panes: expect.objectContaining({
          'pane-a': expect.objectContaining({ title: 'Latest saved title', state: 'placeholder' }),
        }),
      }),
    );
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.saveWorkspace).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.close).mock.invocationCallOrder[0],
    );
    expect(api.stop).not.toHaveBeenCalled();
  });
  it('closes the UI without stopping or forgetting active programs', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    await nativeClose();
    expect(api.close).toHaveBeenCalledOnce();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.forget).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('closes the latest runtime when a starting pane becomes running while confirmation is open', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime starting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pane' }));
    const confirmation = screen.getByRole('dialog', { name: '關閉 1 個面板？' });
    act(() => {
      native.patch?.('pane-a', { state: 'running', runtimeId: 'runtime-a' });
    });
    vi.mocked(api.runtimes).mockResolvedValue([
      {
        kind: 'shell', projectId: 'project-a', profileId: null, resumeId: null,
        id: 'runtime-a',
        paneId: 'pane-a',
        sessionId: null,
        state: 'running',
        cwd: '/synthetic/project',
        exitCode: null,
      },
    ]);
    fireEvent.click(within(confirmation).getByRole('button', { name: '結束並關閉' }));
    await tick();
    expect(api.runtimes).toHaveBeenCalledTimes(1);
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const workspace = JSON.parse(
      screen.getByTestId('workspace-snapshot').textContent!,
    ) as Workspace;
    expect(workspace.panes['pane-a']).toBeUndefined();
  });
  it('reports a close-time save failure and keeps the application open', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveWorkspace).mockRejectedValueOnce(new Error('無法保存布局'));
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Update synthetic pane' }));
    await nativeClose();
    expect(screen.getByRole('alert')).toHaveTextContent('無法保存布局');
    expect(api.close).not.toHaveBeenCalled();
  });
});


describe('App curated project navigation', () => {
  it('starts on Projects without mounting mixed history and opens an automatic group only from All Directories', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], curated: false, sessionCount: 12 };
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(screen.getByRole('heading', { name: '專案', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^專案(?:\s+\d+)?$/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(native.historyRender).not.toHaveBeenCalled();
    changePage('所有目錄');
    expect(screen.getByRole('heading', { name: '所有目錄', level: 1 })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '所有目錄' })).getByRole('button', { name: /^Synthetic project/ })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(native.historyRender).not.toHaveBeenCalled();
    selectGroup('Synthetic project', '所有目錄');
    expect(screen.getByRole('heading', { name: 'Synthetic project', level: 1 })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toEqual(data.projects);
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    expect(native.historyRender.mock.calls.every(([id]) => id === 'project-a')).toBe(true);
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('curates a scoped history group and restores saved inclusion and removal after reload', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], curated: false, sessionCount: 4 };
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const included = { ...data.projects[0], curated: true };
    vi.mocked(api.updateProject).mockResolvedValueOnce(included);
    const first = render(<App />);
    await tick();
    changePage('所有目錄');
    selectGroup('Synthetic project', '所有目錄');
    fireEvent.click(screen.getByRole('button', { name: 'Curate synthetic history project' }));
    await tick();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('project-a', { curated: true });
    changePage('專案');
    expect(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Synthetic project/ })).toBeInTheDocument();
    first.unmount();
    vi.mocked(api.bootstrap).mockResolvedValue({ ...data, projects: [included] });
    const second = render(<App />);
    await tick();
    selectGroup();
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    vi.mocked(api.updateProject).mockResolvedValueOnce(data.projects[0]);
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    await tick();
    expect(api.updateProject).toHaveBeenLastCalledWith('project-a', { curated: false });
    expect(screen.getByRole('heading', { name: '專案', level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    second.unmount();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    changePage('所有目錄');
    selectGroup('Synthetic project', '所有目錄');
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toEqual(data.projects);
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    expect(native.historyRender.mock.calls.every(([id]) => id === 'project-a')).toBe(true);
    expect(api.updateProject).toHaveBeenCalledTimes(2);
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it('removes a running workspace from curated projects without losing its runtime, layout, or reachability', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.updateProject).mockResolvedValue({ ...bootstrap().projects[0], curated: false });
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    const before = JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    await tick();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('workspace-snapshot').textContent!)).toEqual(before);
    expect(screen.getByText('1 個執行中程序')).toBeInTheDocument();
    changePage('所有目錄');
    fireEvent.click(within(screen.getByRole('region', { name: '開啟中的工作區' })).getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('workspace-snapshot').textContent!)).toEqual(before);
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('project-a', { curated: false });
  });

  it.each(['existing', 'create'] as const)('adds a %s project from All Directories and selects it on Projects after refresh', async (mode) => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const added: Project = { ...bootstrap().projects[0], id: 'added', name: 'Chosen folder', path: '/synthetic/chosen' };
    vi.mocked(api.addProject).mockResolvedValue(added);
    vi.mocked(api.createProject).mockResolvedValue(added);
    vi.mocked(api.projects).mockResolvedValue([...bootstrap().projects, added]);
    render(<App />);
    await tick();
    changePage('所有目錄');
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: '加入／建立專案' }));
    if (mode === 'create') fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '上層目錄路徑' : '目錄路徑'), { target: { value: mode === 'create' ? '/synthetic' : '/synthetic/chosen' } });
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '專案名稱（新資料夾名稱）' : '專案名稱（選填）'), { target: { value: 'Chosen folder' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: '加入或建立專案' })).getByRole('button', { name: mode === 'create' ? '建立並加入' : '加入專案' }));
    await tick();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chosen folder' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^專案(?:\s+\d+)?$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('added');
    expect(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Chosen folder/ })).toBeInTheDocument();
    expect(mode === 'create' ? api.createProject : api.addProject).toHaveBeenCalledExactlyOnceWith(mode === 'create' ? '/synthetic' : '/synthetic/chosen', 'Chosen folder');
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('allows a failed refresh to retry without creating the directory twice', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const added: Project = { ...bootstrap().projects[0], id: 'added', name: 'New project', path: '/synthetic/new' };
    vi.mocked(api.createProject).mockResolvedValue(added);
    vi.mocked(api.projects).mockRejectedValueOnce(new Error('Index refresh failed')).mockResolvedValue([...bootstrap().projects, added]);
    render(<App />);
    await tick();
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: '加入／建立專案' }));
    fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    fireEvent.change(screen.getByLabelText('上層目錄路徑'), { target: { value: '/synthetic' } });
    fireEvent.change(screen.getByLabelText('專案名稱（新資料夾名稱）'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '建立並加入' }));
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Index refresh failed');
    fireEvent.click(screen.getByRole('button', { name: '重新整理專案' }));
    await tick();
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith('/synthetic', 'new');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New project' })).toBeInTheDocument();
  });

  it('cancels or escapes project creation without changing navigation and resets the next form', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Synthetic project/ }));
    for (const dismissal of ['cancel', 'escape']) {
      fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: '加入／建立專案' }));
      expect(screen.getByLabelText('目錄路徑')).toHaveValue('');
      fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
      fireEvent.change(screen.getByLabelText('上層目錄路徑'), { target: { value: '/synthetic' } });
      fireEvent.change(screen.getByLabelText('專案名稱（新資料夾名稱）'), { target: { value: 'discarded' } });
      if (dismissal === 'cancel') fireEvent.click(screen.getByRole('button', { name: '取消' }));
      else fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    }
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('reports membership failures and deduplicates repeated history selection while pending', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0].curated = false;
    data.projects[0].sessionCount = 1;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    let reject!: (reason: unknown) => void;
    vi.mocked(api.updateProject).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<App />);
    await tick();
    changePage('所有目錄');
    selectGroup('Synthetic project', '所有目錄');
    const add = screen.getByRole('button', { name: 'Curate synthetic history project' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add).toBeDisabled();
    expect(api.updateProject).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('Unable to save project membership')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save project membership');
    expect(add).toBeEnabled();
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    changePage('專案');
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('App successful shell exit navigation', () => {
  it('closes a successful final shell and returns to history', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    act(() => { native.patch?.('pane-a', { state: 'exited', exitCode: 0 }); });
    await tick();
    expect(workspaceSnapshot().panes['pane-a']).toBeUndefined();
    expect(workspaceSnapshot().tabs).toEqual([]);
    expect(screen.queryByRole('region', { name: '開啟中的工作區' })).not.toBeInTheDocument();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
  });
});

describe('App session-specific working directories', () => {
  it.each([
    { name: 'original session alias', exists: true, launchPath: null, existing: false, expected: '/synthetic/session-alias' },
    { name: 'alias when grouped path is missing', exists: false, launchPath: null, existing: false, expected: '/synthetic/session-alias' },
    { name: 'saved session with another previous cwd', exists: false, launchPath: null, existing: true, expected: '/synthetic/session-alias' },
    { name: 'explicit relocated directory', exists: true, launchPath: '/synthetic/relocated', existing: false, expected: '/synthetic/relocated' },
    { name: 'relocated restored session', exists: true, launchPath: '/synthetic/relocated', existing: true, expected: '/synthetic/relocated' },
  ])('resumes using $name rather than a grouped historical directory', async ({ exists, launchPath, existing, expected }) => {
    vi.mocked(isDesktop).mockReturnValue(true);
    native.sessionCwd = '/synthetic/session-alias';
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], path: '/synthetic/grouped-path', exists, launchPath };
    const saved = data.workspace as Workspace;
    if (existing) saved.panes['pane-a'] = { ...saved.panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/previous-alias' };
    else data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
    const current = JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
    const resumed = Object.values(current.panes).find((pane) => pane.sessionId === 'synthetic-session');
    expect(resumed).toMatchObject({ cwd: expected, startToken: 1, kind: 'codex' });
    expect(current.tabs).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.updateProject).not.toHaveBeenCalled();
  });
  it.each([true, false])('restarts a restored Agent in its saved cwd when grouped path exists=%s', async (exists) => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], path: '/synthetic/grouped-path', exists };
    const saved = data.workspace as Workspace;
    saved.panes['pane-a'] = { ...saved.panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/saved-alias' };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Restart synthetic pane' }));
    const current = JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
    expect(current.panes['pane-a']).toMatchObject({ cwd: '/synthetic/saved-alias', startToken: 1 });
  });
});


function deferredPreview() {
  let resolve!: (value: LaunchPreview) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<LaunchPreview>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function openLauncher() {
  vi.mocked(isDesktop).mockReturnValue(true);
  render(<App />);
  await tick();
  selectGroup();
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  return screen.getByRole('dialog', { name: '開始新的工作' });
}
function chooseLaunchKind(dialog: HTMLElement, kind: 'shell' | AgentKind) {
  if (kind === 'shell') {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Shell/ }));
    return;
  }
  if (!within(dialog).queryByRole('combobox', { name: 'Agent' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^Agent/ }));
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${agentNames[kind]}`) }));
}
function workspaceSnapshot(): Workspace {
  return JSON.parse(screen.getByTestId('workspace-snapshot').textContent!) as Workspace;
}

describe('exact agent launch preview and manual resume', () => {
  it('invalidates the exact preview whenever a manual conversation ID changes', async () => {
    const next = deferredPreview();
    vi.mocked(api.preview).mockResolvedValueOnce({ executable: '/synthetic/grok', args: ['--resume', 'first-id'], cwd: '/synthetic/project' })
      .mockReturnValueOnce(next.promise);
    const dialog = await openLauncher();
    chooseLaunchKind(dialog, 'grok');
    const id = within(dialog).getByRole('textbox', { name: /接續對話 ID/ });
    fireEvent.change(id, { target: { value: 'first-id' } });
    await tick(150);
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    expect(start).toBeEnabled();
    fireEvent.change(id, { target: { value: 'next-id' } });
    expect(start).toBeDisabled();
    expect(dialog.querySelector('pre')).toBeNull();
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ resumeId: 'next-id' }));
    expect(start).toBeDisabled();
    await act(async () => next.resolve({ executable: '/synthetic/grok', args: ['--resume', 'next-id'], cwd: '/synthetic/project' }));
    expect(dialog.querySelector('pre')?.textContent).toContain('next-id');
    expect(dialog.querySelector('pre')?.textContent).not.toContain('first-id');
    expect(start).toBeEnabled();
  });
  it('re-previews a changed shell profile before allowing it to start', async () => {
    const data = bootstrap();
    data.settings.profiles.push({ id: 'alternate', name: 'Alternate Shell', executable: '/synthetic/zsh', args: [], env: {} });
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const dialog = await openLauncher();
    await tick(150);
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Shell Profile' }));
    fireEvent.click(screen.getByRole('option', { name: /^Alternate Shell/ }));
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeDisabled();
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'shell', profileId: 'alternate' }));
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeEnabled();
  });

  it('separates Shell and Agent work and requires the backend preview before launch', async () => {
    const pending = deferredPreview();
    vi.mocked(api.preview).mockReturnValueOnce(pending.promise);
    const dialog = await openLauncher();
    expect(within(dialog).getByRole('button', { name: /^Shell/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: /^Agent/ })).toHaveAttribute('aria-pressed', 'false');
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    expect(start).toBeDisabled();
    expect(api.preview).not.toHaveBeenCalled();
    await tick(149);
    expect(api.preview).not.toHaveBeenCalled();
    await tick(1);
    expect(api.preview).toHaveBeenCalledExactlyOnceWith({
      paneId: 'launch-preview', kind: 'shell', projectId: 'project-a', cwd: '/synthetic/project',
      profileId: 'default', resumeId: undefined, cols: 80, rows: 24,
    });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form')!);
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
    const preview = { executable: '/synthetic/bin/bash', args: ['-l', 'two words', '$(never); literal'], cwd: '/canonical/project' };
    await act(async () => pending.resolve(preview));
    const shown = within(dialog).getByLabelText('啟動參數預覽');
    expect(shown.querySelector('pre')?.textContent).toBe(JSON.stringify([preview.executable, ...preview.args], null, 2));
    expect(shown).toHaveTextContent('工作目錄：/canonical/project');
    expect(start).toBeEnabled();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('invalidates a completed preview immediately when the directory changes and ignores stale results', async () => {
    const old = deferredPreview();
    const latest = deferredPreview();
    vi.mocked(api.preview).mockResolvedValueOnce({ executable: '/synthetic/first', args: [], cwd: '/synthetic/project' })
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const dialog = await openLauncher();
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    await tick(150);
    expect(start).toBeEnabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '工作目錄' }), { target: { value: '/synthetic/old' } });
    expect(start).toBeDisabled();
    expect(dialog.querySelector('pre')).toBeNull();
    await tick(150);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '工作目錄' }), { target: { value: '/synthetic/new' } });
    await tick(150);
    await act(async () => latest.resolve({ executable: '/synthetic/latest', args: ['latest'], cwd: '/synthetic/new' }));
    expect(start).toBeEnabled();
    await act(async () => old.resolve({ executable: '/synthetic/stale', args: ['stale'], cwd: '/synthetic/old' }));
    expect(dialog.querySelector('pre')?.textContent).toContain('/synthetic/latest');
    expect(dialog.querySelector('pre')?.textContent).not.toContain('/synthetic/stale');
    expect(within(dialog).getByLabelText('啟動參數預覽')).toHaveTextContent('工作目錄：/synthetic/new');
    fireEvent.click(start);
    expect(Object.values(workspaceSnapshot().panes).find((pane) => pane.id !== 'pane-a')).toMatchObject({ cwd: '/synthetic/new' });
  });
  it('keeps the latest preview pending when a stale request fails', async () => {
    const old = deferredPreview();
    const latest = deferredPreview();
    vi.mocked(api.preview).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const dialog = await openLauncher();
    await tick(150);
    chooseLaunchKind(dialog, 'grok');
    await tick(150);
    await act(async () => old.reject(new Error('stale tool failure')));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeDisabled();
    await act(async () => latest.resolve({ executable: '/synthetic/grok', args: [], cwd: '/synthetic/project' }));
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeEnabled();
  });
  it('blocks start on preview failure and permits a new preview after the user corrects input', async () => {
    vi.mocked(api.preview).mockRejectedValueOnce(new Error('找不到 agy 執行檔'));
    const dialog = await openLauncher();
    chooseLaunchKind(dialog, 'antigravity');
    await tick(150);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('找不到 agy 執行檔');
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form')!);
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
    chooseLaunchKind(dialog, 'grok');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await tick(150);
    expect(start).toBeEnabled();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('cancels a preview debounce without sending a request or creating a pane', async () => {
    const dialog = await openLauncher();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await tick(500);
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
  });
  it('ignores a cancelled in-flight preview even after a new launcher opens', async () => {
    const cancelled = deferredPreview();
    const current = deferredPreview();
    vi.mocked(api.preview).mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(current.promise);
    const dialog = await openLauncher();
    await tick(150);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    const reopened = screen.getByRole('dialog', { name: '開始新的工作' });
    await tick(150);
    await act(async () => cancelled.resolve({ executable: '/cancelled', args: [], cwd: '/cancelled' }));
    expect(reopened.querySelector('pre')).toBeNull();
    expect(within(reopened).getByRole('button', { name: '開始工作' })).toBeDisabled();
    await act(async () => current.resolve({ executable: '/current', args: [], cwd: '/synthetic/project' }));
    expect(reopened.querySelector('pre')?.textContent).toContain('/current');
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
  });
  it.each(['grok', 'antigravity', 'opencode'] as const)('previews and persists the trimmed manual %s resume ID separately from the catalog ID', async (kind) => {
    vi.mocked(api.preview).mockResolvedValue({ executable: kind === 'grok' ? '/synthetic/grok' : '/synthetic/agy',
      args: [kind === 'grok' ? '--resume' : '--conversation', 'synthetic-conversation'], cwd: '/synthetic/project' });
    const dialog = await openLauncher();
    chooseLaunchKind(dialog, kind);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), {
      target: { value: '  synthetic-conversation  ' },
    });
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind, resumeId: 'synthetic-conversation' }));
    expect(vi.mocked(api.preview).mock.calls.at(-1)![0].sessionId).toBeUndefined();
    expect(dialog.querySelector('pre')?.textContent).toContain('synthetic-conversation');
    expect(within(dialog).queryByText(/尚不支援自動索引／預覽其歷史/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '開始工作' }));
    const pane = Object.values(workspaceSnapshot().panes).find((item) => item.id !== 'pane-a')!;
    expect(pane).toMatchObject({ kind, resumeId: 'synthetic-conversation', startToken: 1 });
    expect(pane.sessionId).toBeUndefined();
    await tick(500);
    const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as Workspace;
    expect(saved.panes[pane.id]).toMatchObject({ kind, resumeId: 'synthetic-conversation', state: 'placeholder' });
    expect(saved.panes[pane.id].startToken).toBeUndefined();
    expect(saved.panes[pane.id].runtimeId).toBeUndefined();
  });
  it.each(['codex', 'claude', 'shell', 'antigravity'] as const)('clears a Grok manual ID when switching to %s', async (kind) => {
    const dialog = await openLauncher();
    chooseLaunchKind(dialog, 'grok');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), { target: { value: 'grok-only-id' } });
    chooseLaunchKind(dialog, kind);
    if (kind === 'antigravity') expect(within(dialog).getByRole('textbox', { name: /接續對話 ID/ })).toHaveValue('');
    else expect(within(dialog).queryByRole('textbox', { name: /接續對話 ID/ })).not.toBeInTheDocument();
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind, resumeId: undefined }));
    fireEvent.click(within(dialog).getByRole('button', { name: '開始工作' }));
    const pane = Object.values(workspaceSnapshot().panes).find((item) => item.id !== 'pane-a')!;
    expect(pane.kind).toBe(kind);
    expect(pane.resumeId).toBeUndefined();
  });
  it('treats whitespace-only manual IDs as a new session', async () => {
    const dialog = await openLauncher();
    chooseLaunchKind(dialog, 'grok');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), { target: { value: '   ' } });
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'grok', resumeId: undefined }));
  });
  it.each(['grok', 'antigravity', 'opencode'] as const)('restores a %s manual conversation as a placeholder without previewing or starting it', async (kind) => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    (data.workspace as Workspace).panes['pane-a'] = {
      ...(data.workspace as Workspace).panes['pane-a'], kind, resumeId: 'saved-conversation',
    };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick(1000);
    const pane = workspaceSnapshot().panes['pane-a'];
    expect(pane).toMatchObject({ kind, resumeId: 'saved-conversation', state: 'placeholder' });
    expect(pane.startToken).toBeUndefined();
    expect(pane.runtimeId).toBeUndefined();
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });
  it('shows a permission-risk warning only for the selected opted-in agent', async () => {
    const data = bootstrap();
    data.settings.agentOptions.grok.bypassPermissions = true;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const dialog = await openLauncher();
    expect(within(dialog).queryByText(/已啟用高風險權限模式/)).not.toBeInTheDocument();
    chooseLaunchKind(dialog, 'grok');
    expect(within(dialog).getByText(/已啟用高風險權限模式/)).toHaveTextContent('--always-approve');
    chooseLaunchKind(dialog, 'antigravity');
    expect(within(dialog).queryByText(/已啟用高風險權限模式/)).not.toBeInTheDocument();
  });
});


async function resumeWithExistingLiveSession(cwd: string, state: 'running' | 'starting' = 'running', tabName?: string) {
  vi.mocked(isDesktop).mockReturnValue(true);
  native.sessionCwd = cwd;
  const data = bootstrap();
  if (tabName) (data.workspace as Workspace).tabs[0].name = tabName;
  data.settings.sources = [{ id: 'synthetic-source', kind: 'codex', root: '/synthetic/current-source-root', enabled: true }];
  (data.workspace as Workspace).panes['pane-a'] = {
    ...(data.workspace as Workspace).panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/original-worktree',
  };
  vi.mocked(api.bootstrap).mockResolvedValue(data);
  render(<App />);
  await tick();
  act(() => native.patch?.('pane-a', { state, runtimeId: 'original-runtime' }));
  const original = workspaceSnapshot();
  selectGroup();
  fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
  const requested = workspaceSnapshot();
  const newPane = Object.values(requested.panes).find((pane) => pane.id !== 'pane-a')!;
  return { original, requested, newPane };
}

describe('backend-owned resume identity', () => {
  it.each([
    { state: 'running', cwd: '/synthetic/new-source-worktree', description: 'running pane after its catalog source root changed' },
    { state: 'starting', cwd: '/synthetic/new-source-worktree', description: 'starting pane after its catalog source root changed' },
    { state: 'running', cwd: '/synthetic/original-worktree', description: 'running pane with the same cwd and catalog ID' },
    { state: 'starting', cwd: '/synthetic/original-worktree', description: 'starting pane with the same cwd and catalog ID' },
  ] satisfies { state: 'running' | 'starting'; cwd: string; description: string }[])(
    'requests a new launch instead of client-side deduplication for a $description', async ({ state, cwd }) => {
      const { original, requested, newPane } = await resumeWithExistingLiveSession(cwd, state);
      expect(newPane).toMatchObject({ kind: 'codex', sessionId: 'synthetic-session', cwd, startToken: 1, state: 'placeholder' });
      expect(newPane.id).not.toBe('pane-a');
      expect(newPane.runtimeId).toBeUndefined();
      expect(requested.panes['pane-a']).toEqual(original.panes['pane-a']);
      expect(requested.tabs).toHaveLength(2);
      const active = requested.tabs.find((tab) => tab.id === requested.activeTabByProject['project-a']);
      expect(active?.focusedPaneId).toBe(newPane.id);
      expect(api.stop).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );
  it('removes the requested pane and focuses the original only after the backend identifies a genuine duplicate', async () => {
    const { original, newPane } = await resumeWithExistingLiveSession('/synthetic/original-worktree');
    expect(newPane).toBeDefined();
    act(() => native.alreadyOpen?.(newPane.id, {
      id: 'original-runtime', paneId: 'pane-a', sessionId: 'synthetic-session',
      state: 'running', cwd: '/synthetic/original-worktree', exitCode: null,
    }));
    const result = workspaceSnapshot();
    expect(result.panes[newPane.id]).toBeUndefined();
    expect(result.panes['pane-a']).toEqual(original.panes['pane-a']);
    expect(result.tabs).toEqual(original.tabs);
    expect(result.activeTabByProject['project-a']).toBe('tab-a');
    expect(result.tabs[0].focusedPaneId).toBe('pane-a');
    expect(api.stop).not.toHaveBeenCalled();
    await tick(500);
    const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)?.[0] as Workspace | undefined;
    if (saved) expect(Object.keys(saved.panes)).toEqual(['pane-a']);
  });
  it('retains an inspectable failure when backend duplicate identity has no attachable pane', async () => {
    const { original, newPane } = await resumeWithExistingLiveSession('/synthetic/new-source-worktree');
    expect(newPane).toBeDefined();
    act(() => native.alreadyOpen?.(newPane.id, {
      id: 'other-runtime', paneId: 'not-in-workspace', sessionId: 'synthetic-session',
      state: 'running', cwd: '/synthetic/new-source-worktree', exitCode: null,
    }));
    await tick();
    const result = workspaceSnapshot();
    expect(result.panes['pane-a']).toEqual(original.panes['pane-a']);
    expect(result.panes[newPane.id]).toMatchObject({ state: 'failed', error: expect.stringContaining('已不在背景程序清單') });
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('catalog sessions reassigned to another project', () => {
  it.each(['placeholder', 'failed', 'exited'] as const)(
    'preserves the old %s pane and resumes the same catalog ID in its latest project', async (state) => {
      vi.mocked(isDesktop).mockReturnValue(true);
      native.sessionCwd = '/synthetic/new-source-worktree';
      const data = bootstrap();
      const oldProject = data.projects[0];
      data.projects = [
        { ...oldProject, id: 'project-b', name: 'Latest session project', path: '/synthetic/new-project' },
        oldProject,
      ];
      data.settings.sources = [{ id: 'synthetic-source', kind: 'codex', root: '/synthetic/replaced-source-root', enabled: true }];
      (data.workspace as Workspace).panes['pane-a'] = {
        ...(data.workspace as Workspace).panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/original-worktree',
      };
      vi.mocked(api.bootstrap).mockResolvedValue(data);
      render(<App />);
      await tick();
      if (state === 'failed') act(() => native.patch?.('pane-a', { state, error: 'Original runtime failure' }));
      if (state === 'exited') act(() => native.patch?.('pane-a', { state, exitCode: 7 }));
      const original = workspaceSnapshot();
      expect(original.panes['pane-a']).toMatchObject({ state, projectId: 'project-a' });
      selectGroup('Latest session project');
      fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
      const requested = workspaceSnapshot();
      const newPane = Object.values(requested.panes).find((pane) => pane.id !== 'pane-a');
      expect(newPane).toMatchObject({
        kind: 'codex', sessionId: 'synthetic-session', projectId: 'project-b',
        cwd: '/synthetic/new-source-worktree', state: 'placeholder', startToken: 1,
      });
      expect(requested.panes['pane-a']).toEqual(original.panes['pane-a']);
      expect(requested.panes['pane-a'].startToken).toBeUndefined();
      expect(requested.tabs).toHaveLength(2);
      expect(requested.tabs.find((tab) => tab.id === 'tab-a')).toEqual(original.tabs[0]);
      expect(requested.activeTabByProject['project-a']).toBe('tab-a');
      const newTab = requested.tabs.find((tab) => tab.id === requested.activeTabByProject['project-b']);
      expect(newTab).toMatchObject({ projectId: 'project-b', focusedPaneId: newPane!.id });
      expect(screen.getByRole('heading', { name: 'Latest session project' })).toBeInTheDocument();
      expect(api.stop).not.toHaveBeenCalled();
      expect(api.updateProject).not.toHaveBeenCalled();
      await tick(500);
      const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as Workspace;
      expect(saved.panes['pane-a']).toMatchObject({ projectId: 'project-a', cwd: '/synthetic/original-worktree', state: 'placeholder' });
      expect(saved.panes[newPane!.id]).toMatchObject({ projectId: 'project-b', cwd: '/synthetic/new-source-worktree', state: 'placeholder' });
      expect(saved.panes[newPane!.id].startToken).toBeUndefined();
    },
  );
});


function directoryOverviewBootstrap(): Bootstrap {
  const data = bootstrap();
  const base = data.projects[0];
  data.workspace = emptyWorkspace();
  data.projects = [
    { ...base, name: 'Curated manual', path: '/synthetic/manual', sessionCount: 0 },
    { ...base, id: 'observed', name: 'Observed history', path: '/synthetic/observed', curated: false, sessionCount: 5 },
    { ...base, id: 'missing', name: 'Missing directory', path: '/synthetic/missing', exists: false, curated: false, sessionCount: 2 },
    { ...base, id: 'unknown', name: 'Unknown directory', path: null, exists: false, curated: false, sessionCount: 3 },
    { ...base, id: 'curated-history', name: 'Curated history', path: '/synthetic/curated-history', sessionCount: 1 },
    { ...base, id: 'empty-auto', name: 'Empty automatic', path: '/synthetic/empty-auto', curated: false, sessionCount: 0 },
  ];
  return data;
}

describe('Projects and All Directories pages', () => {
  it('renders curated management cards first and only groups with sessions in All Directories, including unknown and missing paths', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    const main = screen.getByRole('main');
    let navigation = screen.getByRole('navigation', { name: '專案' });
    for (const name of ['Curated manual', 'Curated history']) {
      expect(within(navigation).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
      expect(within(main).getByText(name)).toBeInTheDocument();
    }
    for (const name of ['Observed history', 'Missing directory', 'Unknown directory', 'Empty automatic']) {
      expect(within(navigation).queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
      expect(within(main).queryByText(name)).not.toBeInTheDocument();
    }
    expect(native.historyRender).not.toHaveBeenCalled();
    changePage('所有目錄');
    navigation = screen.getByRole('navigation', { name: '所有目錄' });
    for (const name of ['Observed history', 'Missing directory', 'Unknown directory', 'Curated history']) {
      expect(within(navigation).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
      expect(within(main).getByText(name)).toBeInTheDocument();
    }
    for (const name of ['Curated manual', 'Empty automatic']) {
      expect(within(navigation).queryByRole('button', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
      expect(within(main).queryByText(name)).not.toBeInTheDocument();
    }
    expect(native.historyRender).not.toHaveBeenCalled();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('opens each chosen directory as scoped history without ever requesting a flat mixed overview', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    changePage('所有目錄');
    for (const project of data.projects.filter((entry) => entry.sessionCount > 0)) {
      selectGroup(project.name, '所有目錄');
      expect(screen.getByRole('heading', { name: project.name, level: 1 })).toBeInTheDocument();
      expect(screen.getByTestId('history-selected-project')).toHaveTextContent(project.id);
      expect(native.historyRender).toHaveBeenLastCalledWith(project.id);
    }
    expect(native.historyRender.mock.calls.every(([id]) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('scopes group search to its page and clears the search and selected group when switching pages', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue(directoryOverviewBootstrap());
    render(<App />);
    await tick();
    const search = () => screen.getByRole('textbox', { name: /搜尋專案|搜尋所有目錄/ });
    fireEvent.change(search(), { target: { value: 'missing' } });
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByText('Missing directory')).not.toBeInTheDocument();
    changePage('所有目錄');
    expect(search()).toHaveValue('');
    fireEvent.change(search(), { target: { value: '/synthetic/missing' } });
    const dirs = screen.getByRole('navigation', { name: '所有目錄' });
    expect(within(dirs).getByRole('button', { name: /^Missing directory/ })).toBeInTheDocument();
    expect(within(dirs).queryByRole('button', { name: /^Observed history/ })).not.toBeInTheDocument();
    selectGroup('Missing directory', '所有目錄');
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('missing');
    changePage('專案');
    expect(search()).toHaveValue('');
    expect(screen.getByRole('heading', { name: '專案', level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Curated manual/ })).toBeInTheDocument();
    selectGroup('Curated manual');
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    changePage('所有目錄');
    expect(search()).toHaveValue('');
    expect(screen.getByRole('heading', { name: '所有目錄', level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(native.historyRender.mock.calls.every(([id]) => id !== undefined)).toBe(true);
  });

  it('keeps a selected directory and its sessions visible after removing it from Projects on All Directories', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    const original = data.projects.find((entry) => entry.id === 'curated-history')!;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.updateProject).mockResolvedValue({ ...original, curated: false });
    render(<App />);
    await tick();
    changePage('所有目錄');
    selectGroup('Curated history', '所有目錄');
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    await tick();
    expect(screen.getByRole('tab', { name: /^所有目錄(?:\s+\d+)?$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Curated history', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('curated-history');
    expect(within(screen.getByRole('navigation', { name: '所有目錄' })).getByRole('button', { name: /^Curated history/ })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toContainEqual({ ...original, curated: false });
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(original.id, { curated: false });
    changePage('專案');
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button', { name: /^Curated history/ })).not.toBeInTheDocument();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });

  it('asks for a location before curating an unknown directory and keeps its source group identity', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    const unknown = data.projects.find((entry) => entry.id === 'unknown')!;
    const saved = { ...unknown, curated: true, launchPath: '/synthetic/chosen-location', exists: true };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.updateProject).mockResolvedValue(saved);
    vi.mocked(api.projects).mockResolvedValue(data.projects.map((entry) => entry.id === saved.id ? saved : entry));
    render(<App />);
    await tick();
    changePage('所有目錄');
    selectGroup('Unknown directory', '所有目錄');
    fireEvent.click(screen.getByRole('button', { name: 'Curate synthetic history project' }));
    const dialog = screen.getByRole('dialog', { name: '重新定位專案目錄' });
    expect(within(dialog).getByLabelText('目錄路徑')).toHaveValue('');
    expect(api.updateProject).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('目錄路徑'), { target: { value: '/synthetic/chosen-location' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存新位置' }));
    await tick();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('unknown', { launchPath: '/synthetic/chosen-location', curated: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('unknown');
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toContainEqual(saved);
    changePage('專案');
    expect(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Unknown directory/ })).toBeInTheDocument();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
  });

  it('keeps live workspaces mounted and reachable while both pages change selection', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    const original = workspaceSnapshot();
    expect(native.canvasMounted).toHaveBeenCalledOnce();
    for (const page of ['所有目錄', '專案', '所有目錄', '專案'] as const) {
      changePage(page);
      expect(screen.getByRole('heading', { name: page, level: 1 })).toBeInTheDocument();
      expect(workspaceSnapshot()).toEqual(original);
      expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('region', { name: '開啟中的工作區' })).getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
      expect(screen.getByRole('heading', { name: 'Synthetic project', level: 1 })).toBeInTheDocument();
      expect(workspaceSnapshot()).toEqual(original);
      expect(screen.getByText('1 個執行中程序')).toBeInTheDocument();
    }
    expect(native.canvasMounted).toHaveBeenCalledOnce();
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });
});


describe('directory navigation interruptions and direct management', () => {
  it('adds and removes a directory from overview cards without opening history or starting work', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    const observed = data.projects.find((entry) => entry.id === 'observed')!;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.updateProject).mockResolvedValueOnce({ ...observed, curated: true }).mockResolvedValueOnce(observed);
    render(<App />);
    await tick();
    changePage('所有目錄');
    fireEvent.click(screen.getByRole('button', { name: '加入專案 Observed history' }));
    await tick();
    expect(screen.getByRole('heading', { name: '所有目錄', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移出專案 Observed history' })).toBeInTheDocument();
    expect(native.historyRender).not.toHaveBeenCalled();
    changePage('專案');
    expect(screen.getByRole('button', { name: '瀏覽專案 Observed history' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '移出專案 Observed history' }));
    await tick();
    expect(screen.queryByRole('button', { name: '瀏覽專案 Observed history' })).not.toBeInTheDocument();
    changePage('所有目錄');
    expect(screen.getByRole('button', { name: '瀏覽目錄 Observed history' })).toBeInTheDocument();
    expect(vi.mocked(api.updateProject).mock.calls).toEqual([['observed', { curated: true }], ['observed', { curated: false }]]);
    expect(native.historyRender).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it('opens a group directly from its overview card and returns to management without a mixed query', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue(directoryOverviewBootstrap());
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '瀏覽專案 Curated manual' }));
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    fireEvent.click(screen.getByRole('button', { name: /^專案總覽/ }));
    expect(screen.getByRole('region', { name: '專案管理總覽' })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    changePage('所有目錄');
    fireEvent.click(screen.getByRole('button', { name: '瀏覽目錄 Missing directory' }));
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('missing');
    fireEvent.click(screen.getByRole('button', { name: /^目錄總覽/ }));
    expect(screen.getByRole('region', { name: '所有目錄總覽' })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(native.historyRender.mock.calls.every(([id]) => id !== undefined)).toBe(true);
  });

  it('supports arrow and boundary keys on the page tabs without activating history', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    const tabs = within(screen.getByRole('tablist', { name: '導覽頁面' }));
    const projects = tabs.getByRole('tab', { name: /^專案/ });
    const directories = tabs.getByRole('tab', { name: /^所有目錄/ });
    projects.focus();
    fireEvent.keyDown(projects, { key: 'ArrowRight' });
    expect(directories).toHaveFocus();
    expect(directories).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: '所有目錄', level: 1 })).toBeInTheDocument();
    fireEvent.keyDown(directories, { key: 'Home' });
    expect(projects).toHaveFocus();
    expect(projects).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(projects, { key: 'End' });
    expect(directories).toHaveFocus();
    expect(directories).toHaveAttribute('aria-selected', 'true');
    expect(native.historyRender).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('opens cross-directory search only when explicitly requested and returns to grouped directories', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.bootstrap).mockResolvedValue(directoryOverviewBootstrap());
    render(<App />);
    await tick();
    expect(native.historyRender).not.toHaveBeenCalled();
    changePage('所有目錄');
    expect(native.historyRender).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '搜尋所有工作階段' }));
    expect(screen.getByRole('heading', { name: '搜尋所有工作階段', level: 1 })).toBeInTheDocument();
    expect(native.historyRender).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('all');
    fireEvent.click(screen.getByRole('button', { name: '返回目錄總覽' }));
    expect(screen.getByRole('region', { name: '所有目錄總覽' })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '搜尋所有工作階段' }));
    changePage('專案');
    expect(screen.getByRole('region', { name: '專案管理總覽' })).toBeInTheDocument();
    expect(screen.queryByTestId('history-view')).not.toBeInTheDocument();
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('does not undo newer navigation when a pending project removal resolves', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = directoryOverviewBootstrap();
    const removed = { ...data.projects.find((entry) => entry.id === 'curated-history')!, curated: false };
    let resolve!: (value: Project) => void;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.updateProject).mockImplementationOnce(() => new Promise<Project>((done) => { resolve = done; }));
    render(<App />);
    await tick();
    selectGroup('Curated history');
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    changePage('所有目錄');
    selectGroup('Observed history', '所有目錄');
    await act(async () => { resolve(removed); });
    expect(screen.getByRole('heading', { name: 'Observed history', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('observed');
    expect(screen.getByRole('tab', { name: /^所有目錄/ })).toHaveAttribute('aria-selected', 'true');
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('curated-history', { curated: false });
    expect(api.stop).not.toHaveBeenCalled();
  });

  it('does not restore removed project membership from an older index refresh response', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.workspace = emptyWorkspace();
    data.projects[0].sessionCount = 1;
    let resolve!: (value: Project[]) => void;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.index).mockResolvedValue({ ...data.index, revision: 2 });
    vi.mocked(api.projects).mockImplementationOnce(() => new Promise<Project[]>((done) => { resolve = done; }));
    vi.mocked(api.updateProject).mockResolvedValue({ ...data.projects[0], curated: false });
    render(<App />);
    await tick();
    await tick(1000);
    expect(api.projects).toHaveBeenCalledOnce();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    await tick();
    expect(screen.getByRole('heading', { name: '專案', level: 1 })).toBeInTheDocument();
    await act(async () => { resolve(data.projects); });
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '瀏覽專案 Synthetic project' })).not.toBeInTheDocument();
    changePage('所有目錄');
    selectGroup('Synthetic project', '所有目錄');
    const projects = JSON.parse(screen.getByTestId('history-projects').textContent!) as Project[];
    expect(projects[0]).toMatchObject({ curated: false, sessionCount: 1 });
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('project-a', { curated: false });
  });
});


describe('shared launcher and scoped search controls', () => {
  it('keeps the project search shortcut scoped and focuses its complete search field', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.keyDown(document, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });
    await tick();
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('project-a');
    expect(screen.getByRole('textbox', { name: '搜尋 Session' })).toHaveFocus();
    expect(within(screen.getByRole('tablist', { name: '導覽頁面' })).getByRole('tab', { name: /^專案/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('heading', { name: '所有工作階段' })).not.toBeInTheDocument();
  });
  it('shows every registry provider in one scalable dropdown and blocks missing executables', async () => {
    const data = bootstrap();
    data.installations = [
      { kind: 'codex', executable: '/synthetic/codex', available: true, version: null, error: null },
      { kind: 'grok', executable: 'grok', available: false, version: null, error: 'missing' },
    ];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const dialog = await openLauncher();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Agent/ }));
    const selector = within(dialog).getByRole('combobox', { name: 'Agent' });
    fireEvent.click(selector);
    for (const kind of ['codex', 'claude', 'grok', 'antigravity', 'opencode'] as const)
      expect(screen.getByRole('option', { name: new RegExp(`^${agentNames[kind]}`) })).toBeInTheDocument();
    const missing = screen.getByRole('option', { name: /^Grok Build/ });
    expect(missing).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(missing);
    expect(selector).toHaveTextContent('Codex');
    fireEvent.keyDown(selector, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'codex' }));
  });
  it('does not launch a missing default Agent even if a stale preview would succeed', async () => {
    const data = bootstrap();
    data.installations = [{ kind: 'codex', executable: 'codex', available: false, version: null, error: 'missing' }];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const dialog = await openLauncher();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Agent/ }));
    await tick(150);
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form')!);
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
  });
});


it('ignores an older agent detection result after newer executable settings are saved', async () => {
  let resolveOld!: (value: Installation[]) => void;
  const old = new Promise<Installation[]>((resolve) => { resolveOld = resolve; });
  vi.mocked(api.detect).mockReset().mockReturnValueOnce(old).mockResolvedValueOnce([
    { kind: 'codex', executable: '/synthetic/new-codex', available: true, version: 'new-version', error: null },
  ]);
  vi.mocked(api.saveSettings).mockImplementation(async (settings) => settings);
  vi.mocked(isDesktop).mockReturnValue(true);
  render(<App />);
  await tick();
  for (const path of ['/synthetic/old-codex', '/synthetic/new-codex']) {
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    const settings = screen.getByRole('dialog');
    fireEvent.change(within(settings).getByRole('textbox', { name: 'Codex 執行檔路徑' }), { target: { value: path } });
    fireEvent.click(within(settings).getByRole('button', { name: '儲存設定' }));
    await tick();
  }
  await act(async () => resolveOld([
    { kind: 'codex', executable: '/synthetic/old-codex', available: false, version: null, error: 'outdated missing result' },
  ]));
  fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
  expect(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveValue('/synthetic/new-codex');
  expect(screen.getByText('new-version')).toBeInTheDocument();
  expect(screen.queryByText('outdated missing result')).not.toBeInTheDocument();
});

describe('Chrome-style work tab shortcuts', () => {
  async function tabs(count = 10) {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    const workspace = data.workspace as Workspace;
    const pane = workspace.panes['pane-a'];
    workspace.tabs = Array.from({ length: count }, (_, i) => ({ id: `tab-${i}`, projectId: 'project-a', name: `Work ${i + 1}`, focusedPaneId: `pane-${i}`, layout: { kind: 'pane' as const, paneId: `pane-${i}` } }));
    workspace.panes = Object.fromEntries(workspace.tabs.map((tab, i) => [tab.focusedPaneId, { ...pane, id: tab.focusedPaneId, runtimeId: `runtime-${i}` }]));
    workspace.activeTabByProject['project-a'] = 'tab-0';
    workspace.tabs.push({ id: 'other-project', projectId: 'project-b', name: 'Other project', focusedPaneId: 'other-pane', layout: { kind: 'pane', paneId: 'other-pane' } });
    workspace.panes['other-pane'] = { ...pane, id: 'other-pane', projectId: 'project-b' };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Work 1' }));
  }
  it('switches only current-project tabs, wraps, selects last, and consumes before a terminal target', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
    await tabs();
    const target = document.createElement('textarea');
    screen.getByTestId('workspace-canvas').append(target);
    const pty = vi.fn();
    target.addEventListener('keydown', pty, true);
    fireEvent.keyDown(target, { key: '2', code: 'Digit2', ctrlKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-1');
    fireEvent.keyDown(target, { key: '9', code: 'Digit9', ctrlKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-9');
    fireEvent.keyDown(target, { key: 'Tab', ctrlKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    fireEvent.keyDown(target, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-9');
    expect(pty).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
  });
  it('supports macOS shifted brackets and arrow aliases while preserving IME and modal input', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await tabs();
    const target = document.createElement('textarea');
    screen.getByTestId('workspace-canvas').append(target);
    fireEvent.keyDown(target, { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-1');
    fireEvent.keyDown(target, { key: 'ArrowLeft', metaKey: true, altKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    fireEvent.compositionStart(target);
    fireEvent.keyDown(target, { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true, isComposing: false });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    fireEvent.compositionEnd(target);
    fireEvent.keyDown(target, { key: '2', metaKey: true, isComposing: true });
    fireEvent.keyDown(target, { key: '2', metaKey: true, keyCode: 229 });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.keyDown(document.activeElement!, { key: '2', metaKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('consumes a reserved out-of-range tab number without changing selection or sending terminal input', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
    await tabs(3);
    const target = document.createElement('textarea');
    screen.getByTestId('workspace-canvas').append(target);
    const pty = vi.fn();
    target.addEventListener('keydown', pty, true);
    fireEvent.keyDown(target, { key: '8', code: 'Digit8', ctrlKey: true });
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
    expect(pty).not.toHaveBeenCalled();
  });
  it('does not intercept ordinary editing or tab navigation when no work tab is visible', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
    await tabs();
    const target = document.createElement('textarea');
    document.body.append(target);
    const listener = vi.fn();
    target.addEventListener('keydown', listener);
    fireEvent.keyDown(target, { key: 'a' });
    fireEvent.keyDown(target, { key: 'Tab' });
    changePage('所有目錄');
    fireEvent.keyDown(target, { key: 'Tab', ctrlKey: true });
    expect(listener).toHaveBeenCalledTimes(3);
    target.remove();
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-0');
  });
});

describe('semantic location breadcrumbs', () => {
  it('renders each overview once and uses the actual project name inside its history', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0].sessionCount = 1;
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    let crumb = screen.getByRole('navigation', { name: '目前位置' });
    expect(crumb).toHaveTextContent('Session Bay專案');
    expect(crumb.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(within(crumb).queryByRole('button', { name: '專案' })).not.toBeInTheDocument();
    selectGroup();
    crumb = screen.getByRole('navigation', { name: '目前位置' });
    expect(crumb.querySelector('[aria-current="page"]')).toHaveTextContent('Synthetic project');
    expect(within(crumb).getByRole('button', { name: '專案' })).toBeInTheDocument();
    fireEvent.click(within(crumb).getByRole('button', { name: '專案' }));
    expect(screen.getByRole('heading', { name: '專案', level: 1 })).toBeInTheDocument();
    changePage('所有目錄');
    expect(screen.getByRole('navigation', { name: '目前位置' })).toHaveTextContent('Session Bay所有目錄');
    selectGroup('Synthetic project', '所有目錄');
    expect(screen.getByRole('navigation', { name: '目前位置' })).toHaveTextContent('Session Bay所有目錄Synthetic project');
  });
  it('retains a real project named 專案 instead of deleting repeated words', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0].name = '專案';
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    selectGroup('專案');
    const crumb = screen.getByRole('navigation', { name: '目前位置' });
    expect(within(crumb).getByRole('button', { name: '專案' })).toBeInTheDocument();
    expect(crumb.querySelector('[aria-current="page"]')).toHaveTextContent('專案');
    expect(crumb).toHaveTextContent('Session Bay專案專案');
  });
  it('names explicit global search as its leaf rather than adding a generic directory category', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    changePage('所有目錄');
    fireEvent.click(screen.getByRole('button', { name: '搜尋所有工作階段' }));
    const crumb = screen.getByRole('navigation', { name: '目前位置' });
    expect(crumb.querySelector('[aria-current="page"]')).toHaveTextContent('搜尋所有工作階段');
    expect(within(crumb).getByRole('button', { name: '所有目錄' })).toBeInTheDocument();
  });
});

it('refuses a preview-only session even when a stale history callback attempts resume', async () => {
  vi.mocked(isDesktop).mockReturnValue(true);
  native.resumeDisabledReason = '備份來源僅供預覽，不能接續。';
  render(<App />);
  await tick();
  selectGroup();
  const original = workspaceSnapshot();
  fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
  expect(screen.getByText('備份來源僅供預覽，不能接續。')).toBeInTheDocument();
  expect(workspaceSnapshot()).toEqual(original);
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

describe('persistent broker application lifecycle', () => {
  it('reconciles broker identity and never relaunches restored live work', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.runtimes = [brokerRecord({ id: 'authoritative-id' })];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(workspaceSnapshot().panes['pane-a']).toMatchObject({ runtimeId: 'authoritative-id', state: 'running' });
    expect(workspaceSnapshot().panes['pane-a'].startToken).toBeUndefined();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('recovers and saves an orphan runtime even when no layout or catalog project survived', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.workspace = emptyWorkspace();
    data.projects = [];
    data.runtimes = [brokerRecord({ paneId: 'orphan', projectId: null })];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(workspaceSnapshot().panes.orphan).toMatchObject({ runtimeId: 'runtime-a', state: 'running' });
    expect(workspaceSnapshot().tabs).toHaveLength(1);
    await tick(500);
    const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as Workspace;
    expect(saved.panes.orphan).toMatchObject({ state: 'placeholder' });
    expect(saved.panes.orphan.runtimeId).toBeUndefined();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('waits for a pending launch before authoritative stop and forget on explicit pane close', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    let settle!: () => void;
    vi.mocked(api.settleLaunches).mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    vi.mocked(api.runtimes).mockResolvedValue([brokerRecord()]);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime starting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pane' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '關閉 1 個面板？' })).getByRole('button', { name: '結束並關閉' }));
    await tick();
    expect(api.runtimes).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    await act(async () => settle());
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(api.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(vi.mocked(api.stop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.forget).mock.invocationCallOrder[0]);
    expect(workspaceSnapshot().panes['pane-a']).toBeUndefined();
  });
  it('does not stop an old runtime when broker reports interrupted after a restart', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.runtimes).mockResolvedValue([brokerRecord({ state: 'interrupted' })]);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pane' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '關閉 1 個面板？' })).getByRole('button', { name: '結束並關閉' }));
    await tick();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.forget).toHaveBeenCalledWith('runtime-a');
  });
  it('automatically removes a completed shell record without stopping it', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.runtimes = [brokerRecord({ state: 'exited', exitCode: 0 })];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.runtimes).mockResolvedValue(data.runtimes);
    render(<App />);
    await tick();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(workspaceSnapshot().panes['pane-a']).toBeUndefined();
  });
  it('recovers a broker-owned duplicate pane absent from saved layout instead of launching or stopping it', async () => {
    const { newPane } = await resumeWithExistingLiveSession('/synthetic/new-source-worktree');
    vi.mocked(api.runtimes).mockResolvedValue([brokerRecord({ id: 'other-runtime', paneId: 'recovered-pane',
      kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/new-source-worktree' })]);
    act(() => native.alreadyOpen?.(newPane.id, { id: 'other-runtime', paneId: 'recovered-pane',
      sessionId: 'synthetic-session', state: 'running', cwd: '/synthetic/new-source-worktree', exitCode: null }));
    await tick();
    expect(workspaceSnapshot().panes[newPane.id]).toBeUndefined();
    expect(workspaceSnapshot().panes['recovered-pane']).toMatchObject({ state: 'running', runtimeId: 'other-runtime' });
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('global temporary terminals', () => {
  it('opens from an empty project catalog using the configured profile without creating a project', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects = [];
    data.workspace = emptyWorkspace();
    data.settings.defaultProfileId = 'home-shell';
    data.settings.profiles.push({ id: 'home-shell', name: 'Home shell', executable: '/synthetic/shell', args: [], env: {} });
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟臨時 Terminal' }));
    const state = workspaceSnapshot();
    const pane = Object.values(state.panes)[0];
    expect(pane).toMatchObject({ kind: 'shell', projectId: null, homeDirectory: true, cwd: '', profileId: 'home-shell', startToken: 1 });
    expect(state.tabs[0]).toMatchObject({ projectId: null, name: 'Terminal 1' });
    expect(state.activeTemporaryTabId).toBe(state.tabs[0].id);
    expect(state.activeTabByProject).toEqual({});
    expect(screen.getByRole('heading', { level: 1, name: '臨時 Terminal' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
    await tick(500);
    const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as Workspace;
    expect(saved.panes[pane.id].projectId).toBeNull();
    expect(saved.panes[pane.id].startToken).toBeUndefined();
  });
  it('keeps global tabs reachable across project navigation, numeric shortcuts and repeated opens', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: '開啟臨時 Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: '新增臨時 Terminal' }));
    const state = workspaceSnapshot();
    const globalTabs = state.tabs.filter((tab) => tab.projectId === null);
    expect(globalTabs.map((tab) => tab.name)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(state.activeTemporaryTabId).toBe(globalTabs[1].id);
    expect(state.activeTabByProject['project-a']).toBe('tab-a');
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true });
    expect(workspaceSnapshot().activeTemporaryTabId).toBe(globalTabs[0].id);
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(workspaceSnapshot().activeTemporaryTabId).toBe(globalTabs[1].id);
    selectGroup();
    expect(screen.getByRole('heading', { level: 1, name: 'Synthetic project' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 臨時 Terminal Terminal 1' }));
    expect(screen.getByRole('heading', { level: 1, name: '臨時 Terminal' })).toBeInTheDocument();
    expect(workspaceSnapshot().activeTemporaryTabId).toBe(globalTabs[0].id);
    expect(workspaceSnapshot().panes['pane-a'].projectId).toBe('project-a');
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
  });
  it('recovers a global broker record without a fake project and explicitly closes only that runtime', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.runtimes = [brokerRecord({ projectId: null, cwd: '/trusted/home' }),
      brokerRecord({ id: 'other-runtime', paneId: 'other-pane', projectId: 'project-a' })];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.runtimes).mockResolvedValue(data.runtimes);
    render(<App />);
    await tick();
    const state = workspaceSnapshot();
    const globalTab = state.tabs.find((tab) => tab.projectId === null)!;
    expect(state.panes['pane-a']).toMatchObject({ projectId: null, cwd: '/trusted/home', runtimeId: 'runtime-a', state: 'running' });
    expect(state.panes['pane-a'].startToken).toBeUndefined();
    expect(screen.queryByText('已還原工作區')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `開啟工作區 臨時 Terminal ${globalTab.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic pane' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '關閉 1 個面板？' })).getByRole('button', { name: '結束並關閉' }));
    await tick();
    expect(api.stop).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(api.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(workspaceSnapshot().panes['other-pane'].runtimeId).toBe('other-runtime');
    expect(screen.getByRole('heading', { name: '目前沒有臨時 Terminal' })).toBeInTheDocument();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
  });
  it('uses the normal Terminal shortcut without a project and preserves project launch dialogs', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.keyDown(window, { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(workspaceSnapshot().tabs.some((tab) => tab.projectId === null)).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    selectGroup();
    fireEvent.keyDown(window, { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('dialog', { name: '開始新的工作' })).toBeInTheDocument();
    expect(api.createProject).not.toHaveBeenCalled();
  });
});


describe('directory pickers in workspace flows', () => {
  beforeEach(() => { vi.mocked(canPickDirectory).mockReturnValue(true); });
  it('previews a selected launch cwd but never starts a process until submitted', async () => {
    vi.mocked(pickDirectory).mockResolvedValue('/synthetic/chosen');
    const dialog = await openLauncher();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選擇工作目錄' })); });
    expect(within(dialog).getByLabelText('工作目錄')).toHaveValue('/synthetic/chosen');
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/synthetic/chosen' }));
    expect(api.launch).not.toHaveBeenCalled();
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
  });
  it('ignores a selected launch cwd after cancelling and reopening the launcher', async () => {
    let resolve!: (value: string) => void;
    vi.mocked(pickDirectory).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const dialog = await openLauncher();
    fireEvent.click(within(dialog).getByRole('button', { name: '選擇工作目錄' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await act(async () => resolve('/late'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByRole('textbox', { name: '工作目錄' })).toHaveValue('/synthetic/project');
    expect(api.launch).not.toHaveBeenCalled();
  });
  it('only saves a selected relocation through the existing validated project update', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(pickDirectory).mockResolvedValue('/synthetic/relocated');
    const data = directoryOverviewBootstrap();
    const unknown = data.projects.find((entry) => entry.id === 'unknown')!;
    const saved = { ...unknown, curated: true, launchPath: '/synthetic/relocated', exists: true };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    vi.mocked(api.updateProject).mockResolvedValue(saved);
    vi.mocked(api.projects).mockResolvedValue(data.projects.map((entry) => entry.id === saved.id ? saved : entry));
    render(<App />);
    await tick();
    changePage('所有目錄');
    selectGroup('Unknown directory', '所有目錄');
    fireEvent.click(screen.getByRole('button', { name: 'Curate synthetic history project' }));
    const dialog = screen.getByRole('dialog', { name: '重新定位專案目錄' });
    vi.mocked(api.scan).mockClear(); // The initial bootstrap scan predates opening this picker.
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選擇目錄路徑' })); });
    expect(within(dialog).getByLabelText('目錄路徑')).toHaveValue('/synthetic/relocated');
    expect(api.updateProject).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存新位置' }));
    await tick();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('unknown', { launchPath: '/synthetic/relocated', curated: true });
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
  });
});

describe('App live theme integration', () => {
  const start = async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async (next) => next);
    render(<App />);
    await tick();
  };
  it('quick switching previews before persistence resolves and keeps the committed theme after closing', async () => {
    await start();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '快速切換主題' }));
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '深色' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '設定與資料來源' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0]));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    // Theme-only quick saves preserve all other committed settings verbatim.
    expect(api.saveSettings).toHaveBeenCalledWith({ ...bootstrap().settings, theme: 'light' });
  });
  it('restores the committed theme after a failed quick save, even if the menu already closed', async () => {
    await start();
    let fail!: (error: Error) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole('button', { name: '快速切換主題' }));
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    await act(async () => fail(new Error('Disk full')));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('alert')).toHaveTextContent('外觀變更未能保存；保留上次儲存設定');
    expect(screen.getByRole('button', { name: '快速切換主題' })).not.toBeDisabled();
  });
  it('Settings previews without a save call, then cancel restores and a later save persists', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '快速切換主題' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
  });
});

describe('Whole-workspace zoom integration', () => {
  const zoom = (key: string, patch: KeyboardEventInit = {}, target: Window | Document | Element = window) => fireEvent(target, new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...patch }));
  const start = async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async (next) => next);
    render(<App />); await tick(); selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal 1' }));
  };
  const zoomStatus = () => screen.getByText(/^工作台 \d+%/);
  it('previews every repeat immediately, coalesces serialized saves, and resets without changing base terminal font or workspace', async () => {
    await start();
    const before = workspaceSnapshot();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    expect(zoom('=')).toBe(false);
    zoom('+', { shiftKey: true }); zoom('=');
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 130%');
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.saveSettings).mock.calls[0][0].appZoom).toBe(110);
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0]));
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...bootstrap().settings, appZoom: 130 });
    expect(zoomStatus()).toHaveTextContent('工作台 130%');
    expect(zoomStatus()).not.toHaveTextContent('儲存中');
    await act(async () => zoom('-'));
    expect(zoomStatus()).toHaveTextContent('工作台 120%');
    await act(async () => zoom('0'));
    expect(zoomStatus()).toHaveTextContent('工作台 100%');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(vi.mocked(api.saveSettings).mock.calls.at(-1)?.[0].fontSize).toBe(14);
    expect(workspaceSnapshot()).toEqual(before);
    expect(native.canvasUnmounted).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled(); expect(api.launch).not.toHaveBeenCalled();
  });
  it('rolls failed persistence back to the last confirmed size, drops queued changes and allows retry', async () => {
    await start(); await act(async () => zoom('='));
    let fail!: (error: Error) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    zoom('='); zoom('=');
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 130%');
    await act(async () => fail(new Error('Disk full')));
    expect(zoomStatus()).toHaveTextContent('工作台 110%');
    expect(screen.getByRole('alert')).toHaveTextContent('保留上次儲存設定');
    await act(async () => zoom('='));
    expect(zoomStatus()).toHaveTextContent('工作台 120%');
  });
  it('does not capture ordinary fields, modal dialogs, IME or unrelated PTY keys', async () => {
    await start();
    const field = document.getElementById('session-search')!;
    expect(zoom('=', {}, field)).toBe(true);
    expect(zoom('=', { isComposing: true })).toBe(true);
    fireEvent.compositionStart(window.document);
    expect(zoom('=')).toBe(true);
    fireEvent.compositionEnd(window.document);
    expect(zoom('c')).toBe(true);
    expect(zoom('Enter', { shiftKey: true })).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    expect(zoom('=')).toBe(true);
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(zoomStatus()).toHaveTextContent('工作台 100%');
  });
  it('settings preview cancels to the zoomed size and save persists the new size', async () => {
    await start(); await act(async () => zoom('='));
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '150' } });
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 150%');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 110%');
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '150' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(zoomStatus()).toHaveTextContent('工作台 150%');
    expect(vi.mocked(api.saveSettings).mock.calls.at(-1)?.[0].appZoom).toBe(150);
  });
  it('captures zoom before the xterm input target, consumes bounds, and leaves normal input untouched', async () => {
    await start();
    const pane = document.createElement('div'); pane.className = 'terminal-pane';
    const input = document.createElement('textarea'); input.className = 'xterm-helper-textarea';
    pane.append(input); screen.getByTestId('workspace-canvas').append(pane);
    const terminalKey = vi.fn(); input.addEventListener('keydown', terminalKey);
    for (let i = 0; i < 40; i++) expect(zoom('=', {}, input)).toBe(false);
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 200%');
    expect(terminalKey).not.toHaveBeenCalled();
    await tick();
    for (let i = 0; i < 40; i++) expect(zoom('-', {}, input)).toBe(false);
    await tick();
    expect(zoomStatus()).toHaveTextContent('工作台 50%');
    await tick();
    expect(zoom('c', {}, input)).toBe(true);
    expect(terminalKey).toHaveBeenCalledOnce();
    expect(vi.mocked(api.saveSettings).mock.calls.at(-1)?.[0].appZoom).toBe(50);
  });
  it('keeps a pending quick theme when a subsequent zoom is queued after its menu closes', async () => {
    await start();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '快速切換主題' }));
    fireEvent.click(screen.getByRole('button', { name: '淺色' }));
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    zoom('=');
    await tick();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(zoomStatus()).toHaveTextContent('工作台 110%');
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0]));
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...bootstrap().settings, theme: 'light', appZoom: 110 });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(zoomStatus()).toHaveTextContent('工作台 110%');
  });

});

describe('native whole-workspace zoom recovery', () => {
  const zoom = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });
  const start = async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async (next) => next);
    const view = render(<App />); await tick(); return view;
  };
  it('restores the saved native zoom and works in history with no open terminal', async () => {
    const saved = bootstrap(); saved.settings.appZoom = 150; saved.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(saved);
    const view = await start();
    expect(api.setWorkspaceZoom).toHaveBeenCalledWith(150);
    await act(async () => zoom('='));
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(160);
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...saved.settings, appZoom: 160 });
    expect(api.launch).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled();
    view.unmount();
    vi.mocked(api.bootstrap).mockResolvedValue({ ...saved, settings: { ...saved.settings, appZoom: 160 } });
    render(<App />); await tick();
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(160);
    await act(async () => zoom('0'));
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(100);
  });
  it('does not save a native apply failure and allows retry without changing fontSize', async () => {
    await start();
    vi.mocked(api.setWorkspaceZoom).mockRejectedValueOnce(new Error('Native zoom denied'));
    await act(async () => zoom('=')); await tick();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('縮放未能套用');
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 100%');
    await act(async () => zoom('='));
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...bootstrap().settings, appZoom: 110 });
  });
  it('reports the actual applied percentage when disk-save rollback also fails natively', async () => {
    await start();
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error('Disk full'));
    vi.mocked(api.setWorkspaceZoom).mockImplementation(async (percent) => { if (percent === 100) throw new Error('Rollback failed'); });
    await act(async () => zoom('=')); await tick();
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 110% · 縮放套用失敗');
    expect(screen.getByRole('alert')).toHaveTextContent('Rollback failed');
    vi.mocked(api.setWorkspaceZoom).mockResolvedValue(undefined);
    await act(async () => zoom('0')); await tick();
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 100%');
  });
  it('keeps invalid Settings zoom out of native preview and lets reset cancel back to the saved zoom', async () => {
    const saved = bootstrap(); saved.settings.appZoom = 150;
    vi.mocked(api.bootstrap).mockResolvedValue(saved);
    await start();
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '999' } });
    await tick(); expect(api.setWorkspaceZoom).not.toHaveBeenCalledWith(999);
    fireEvent.click(screen.getByRole('button', { name: '還原工作台縮放 100%' }));
    await tick(); expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(100);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    await tick(); expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(150);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});

describe('workspace zoom delayed-operation regressions', () => {
  const zoomKey = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });
  const startReview = async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async (next) => next);
    render(<App />); await tick();
  };
  const openAppearance = () => {
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
  };
  it('cancel wins after an older Settings native preview resolves late', async () => {
    await startReview();
    let finish!: () => void;
    vi.mocked(api.setWorkspaceZoom).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    openAppearance();
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '150' } });
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    await tick();
    await act(async () => finish()); await tick();
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(100);
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 100%');
    expect(screen.getByText(/^工作台 \d+%/)).not.toHaveTextContent('套用中');
  });
  it('does not persist superseded queued requests when their coalesced native target fails', async () => {
    let finish!: () => void;
    vi.mocked(api.setWorkspaceZoom).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await startReview();
    zoomKey('='); zoomKey('='); zoomKey('='); await tick();
    vi.mocked(api.setWorkspaceZoom).mockRejectedValueOnce(new Error('130 fails'));
    await act(async () => finish()); await tick();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 100%');
  });
  it('disk failure rolls back after a newer in-flight native preview completes', async () => {
    await startReview();
    let diskFail!: (error: Error) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => { diskFail = reject; }));
    await act(async () => zoomKey('=')); await tick();
    let finish!: () => void;
    vi.mocked(api.setWorkspaceZoom).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    zoomKey('='); await tick();
    await act(async () => diskFail(new Error('disk failed'))); await tick();
    await act(async () => finish()); await tick();
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(100);
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 100%');
  });
  it('Settings save retry retains its draft after a disk failure and cancel restores native zoom', async () => {
    await startReview(); openAppearance();
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '170' } });
    await tick();
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error('disk failed'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存設定' })));
    expect(screen.getByRole('spinbutton', { name: '工作台縮放 %' })).toHaveValue(170);
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 170%');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '捨棄變更' })); await tick();
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(100);
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe('command palette theme transactions', () => {
  async function start() {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async next => next);
    render(<App />);
    await tick();
  }
  function open(target = '切換介面主題') {
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    const search = screen.getByRole('textbox', { name: '搜尋命令或專案' });
    fireEvent.change(search, { target: { value: target } });
    fireEvent.keyDown(search, { key: 'Enter' });
    return screen.getByRole('combobox', { name: '搜尋主題' });
  }
  it('searches commands and previews with arrows without writing, Escape returns and restores', async () => {
    await start();
    for (let i = 0; i < 2; i++) {
      const input = open();
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(document.documentElement.dataset.themePalette).toBe('graphite');
      expect(api.saveSettings).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.getByRole('textbox', { name: '搜尋命令或專案' })).toHaveFocus();
      expect(document.documentElement.dataset.themePalette).toBe('bay');
      fireEvent.keyDown(screen.getByRole('textbox', { name: '搜尋命令或專案' }), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  });
  it('commits only the selected UI fields with Enter and does not restart runtime', async () => {
    await start();
    const input = open();
    fireEvent.change(input, { target: { value: 'Ocean · 海洋 · 淺色' } });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(api.saveSettings).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.saveSettings).toHaveBeenCalledWith({ ...bootstrap().settings, theme: 'light', themePalette: 'ocean' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.dataset.themePalette).toBe('ocean');
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(native.canvasUnmounted).not.toHaveBeenCalled();
  });
  it('Terminal selection preserves UI mode, font and unrelated settings', async () => {
    await start();
    const input = open('切換 Terminal 主題');
    fireEvent.change(input, { target: { value: '淺色 · Rose' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.saveSettings).toHaveBeenCalledWith({ ...bootstrap().settings, terminalTheme: 'rose-light' });
  });
  it('save failure rolls back, retains selected retry, and Escape never writes', async () => {
    await start();
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error('Disk full'));
    const input = open();
    fireEvent.change(input, { target: { value: 'Ocean · 海洋 · 淺色' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('alert')).toHaveTextContent('Disk full');
    expect(screen.getByRole('option', { name: /Ocean/ })).toHaveAttribute('aria-selected', 'true');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.theme).toBe('light');
    const again = open();
    fireEvent.change(again, { target: { value: 'Forest · 森林 · 深色' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(document.documentElement.dataset.themePalette).toBe('ocean');
    expect(api.saveSettings).toHaveBeenCalledTimes(2);
  });
  it('single write gate prevents repeats and stale save completion does not close a returned command screen', async () => {
    await start();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = open();
    fireEvent.change(input, { target: { value: 'Ocean · 海洋 · 淺色' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '返回命令' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: '切換介面主題' })).toBeDisabled();
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0]));
    expect(screen.getByRole('textbox', { name: '搜尋命令或專案' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: '切換介面主題' })).not.toBeDisabled();
  });
  it('IME confirmation and Escape do not save or dismiss, empty search has no actionable choice', async () => {
    await start();
    const input = open();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: 'not-a-theme-zzz' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '儲存選取主題' })).toBeDisabled();
  });
  it('settings and quick switcher cannot acquire preview while command picker owns it', async () => {
    await start();
    open();
    expect(screen.getByRole('button', { name: '快速切換主題' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '設定與資料來源' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();
  });
  it('ordinary commands still run from filtered search', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    const input = screen.getByRole('textbox', { name: '搜尋命令或專案' });
    fireEvent.change(input, { target: { value: '顯示／隱藏側欄' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});

describe('command themes and whole-workspace zoom integration', () => {
  const zoom = (key = '=') => fireEvent.keyDown(window, { key, ctrlKey: true });
  const status = () => screen.getByText(/^工作台 \d+%/);
  async function start() {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async next => next);
    render(<App />); await tick();
  }
  function picker(target = '切換介面主題') {
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    const search = screen.getByRole('textbox', { name: '搜尋命令或專案' });
    fireEvent.change(search, { target: { value: target } }); fireEvent.keyDown(search, { key: 'Enter' });
    return screen.getByRole('combobox', { name: '搜尋主題' });
  }
  it('preserves command commit then newer zoom while its save completes after closing', async () => {
    await start();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = picker();
    fireEvent.change(input, { target: { value: 'Code Modern · 淺色' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.saveSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    zoom(); zoom(); await tick();
    expect(status()).toHaveTextContent('工作台 120%');
    expect(screen.getByRole('button', { name: '設定與資料來源' })).toBeDisabled();
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0])); await tick();
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'light', themePalette: 'code-modern', appZoom: 120, fontSize: 14 }));
    expect(document.documentElement.dataset.themePalette).toBe('code-modern');
    const zoomCalls = vi.mocked(api.setWorkspaceZoom).mock.calls.length;
    const again = picker('切換 Terminal 主題');
    fireEvent.change(again, { target: { value: '淺色 · Code 2026' } });
    await act(async () => fireEvent.keyDown(again, { key: 'Enter' }));
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTheme: 'code-2026-light', appZoom: 120, themePalette: 'code-modern' }));
    expect(api.setWorkspaceZoom).toHaveBeenCalledTimes(zoomCalls);
    expect(api.launch).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled(); expect(native.canvasUnmounted).not.toHaveBeenCalled();
  });
  it('theme preview, cancel and failed retry never own an already saved zoom or font', async () => {
    const data = bootstrap(); data.settings.appZoom = 150; data.settings.fontSize = 20;
    vi.mocked(api.bootstrap).mockResolvedValue(data); await start();
    const calls = vi.mocked(api.setWorkspaceZoom).mock.calls.length;
    let input = picker(); fireEvent.change(input, { target: { value: 'Code 2026 · 淺色' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜尋命令或專案' }), { key: 'Escape' });
    expect(status()).toHaveTextContent('工作台 150%'); expect(api.saveSettings).not.toHaveBeenCalled();
    input = picker(); fireEvent.change(input, { target: { value: 'Code Modern · 淺色' } });
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error('Theme save failed'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(document.documentElement.dataset.theme).toBe('dark'); expect(status()).toHaveTextContent('工作台 150%');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ appZoom: 150, fontSize: 20, themePalette: 'code-modern' }));
    expect(api.setWorkspaceZoom).toHaveBeenCalledTimes(calls);
  });
  it('keeps a committed theme when queued native zoom fails, then settings cancel restores both', async () => {
    await start();
    let finish!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = picker(); fireEvent.change(input, { target: { value: 'Code 2026 · 淺色' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    vi.mocked(api.setWorkspaceZoom).mockImplementation(async percent => { if (percent === 110) throw new Error('Native zoom failed'); });
    zoom(); await tick();
    await act(async () => finish(vi.mocked(api.saveSettings).mock.calls[0][0])); await tick();
    expect(api.saveSettings).toHaveBeenCalledOnce(); expect(status()).toHaveTextContent('工作台 100%');
    expect(document.documentElement.dataset.themePalette).toBe('code-2026');
    vi.mocked(api.setWorkspaceZoom).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
    fireEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '工作台縮放 %' }), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: '深色' })); await tick();
    expect(status()).toHaveTextContent('工作台 170%');
    fireEvent.click(screen.getByRole('button', { name: '取消' })); fireEvent.click(screen.getByRole('button', { name: '捨棄變更' })); await tick();
    expect(status()).toHaveTextContent('工作台 100%'); expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePalette).toBe('code-2026'); expect(api.saveSettings).toHaveBeenCalledOnce();
  });
});

describe('appearance transactions across delayed native and disk saves', () => {
  async function startMerged() {
    const saved = bootstrap(); saved.settings.appZoom = 150; saved.settings.fontSize = 21;
    vi.mocked(api.bootstrap).mockResolvedValue(saved);
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.saveSettings).mockReset().mockImplementation(async next => next);
    render(<App />); await tick();
    return saved;
  }
  function chooseUITheme() {
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    const search = screen.getByRole('textbox', { name: '搜尋命令或專案' });
    fireEvent.change(search, { target: { value: '切換介面主題' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const input = screen.getByRole('combobox', { name: '搜尋主題' });
    fireEvent.change(input, { target: { value: 'Ocean · 海洋 · 淺色' } });
    return input;
  }
  it('theme commit cannot revert a newer delayed zoom preview and both persisted fields survive', async () => {
    const saved = await startMerged();
    let finishDisk!: (value: Bootstrap['settings']) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise(resolve => { finishDisk = resolve; }));
    fireEvent.keyDown(chooseUITheme(), { key: 'Enter' });
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    let finishNative!: () => void;
    vi.mocked(api.setWorkspaceZoom).mockClear().mockImplementationOnce(() => new Promise<void>(resolve => { finishNative = resolve; }));
    fireEvent.keyDown(window, { key: '=', ctrlKey: true }); await tick();
    fireEvent.keyDown(window, { key: '=', ctrlKey: true }); await tick();
    await act(async () => finishDisk(vi.mocked(api.saveSettings).mock.calls[0][0])); await tick();
    await act(async () => finishNative()); await tick();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...saved.settings, appZoom: 170, theme: 'light', themePalette: 'ocean' });
    expect(api.setWorkspaceZoom).not.toHaveBeenCalledWith(150);
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(170);
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 170%');
    expect(document.documentElement.dataset.themePalette).toBe('ocean');
  });
  it('failed command commit rejects pending zoom and rolls native preview back after its delayed completion', async () => {
    await startMerged();
    let failDisk!: (error: Error) => void;
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => { failDisk = reject; }));
    fireEvent.keyDown(chooseUITheme(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    let finishNative!: () => void;
    vi.mocked(api.setWorkspaceZoom).mockImplementationOnce(() => new Promise<void>(resolve => { finishNative = resolve; }));
    fireEvent.keyDown(window, { key: '=', ctrlKey: true }); await tick();
    await act(async () => failDisk(new Error('Disk fails theme'))); await tick();
    await act(async () => finishNative()); await tick();
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(api.setWorkspaceZoom).toHaveBeenLastCalledWith(150);
    expect(screen.getByText(/^工作台 \d+%/)).toHaveTextContent('工作台 150%');
    expect(document.documentElement.dataset.themePalette).toBe('bay');
    expect(screen.getByRole('alert')).toHaveTextContent('Disk fails theme');
  });
  it('color preview and cancellation after a saved zoom never own the zoom or font fields', async () => {
    const saved = await startMerged();
    await act(async () => fireEvent.keyDown(window, { key: '=', ctrlKey: true })); await tick();
    vi.mocked(api.setWorkspaceZoom).mockClear(); vi.mocked(api.saveSettings).mockClear();
    const input = chooseUITheme();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' })); await tick();
    expect(api.setWorkspaceZoom).not.toHaveBeenCalled(); expect(api.saveSettings).not.toHaveBeenCalled();
    const retry = chooseUITheme();
    await act(async () => fireEvent.keyDown(retry, { key: 'Enter' })); await tick();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ ...saved.settings, appZoom: 160, theme: 'light', themePalette: 'ocean' });
    expect(api.setWorkspaceZoom).not.toHaveBeenCalled();
  });
});

describe('workspace display organization', () => {
  it('renames and persists a tab without remounting the canvas or stopping its runtime', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />); await tick(); selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    const original = workspaceSnapshot();
    const mounts = native.canvasMounted.mock.calls.length;
    const unmounts = native.canvasUnmounted.mock.calls.length;
    const stops = vi.mocked(api.stop).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '重新命名分頁 Terminal' }));
    fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Build console' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存名稱' }));
    await tick(); await tick(450);
    expect(workspaceSnapshot().tabs[0].name).toBe('Build console');
    expect(workspaceSnapshot().panes).toEqual(original.panes);
    expect(native.canvasMounted).toHaveBeenCalledTimes(mounts);
    expect(native.canvasUnmounted).toHaveBeenCalledTimes(unmounts);
    expect(api.stop).toHaveBeenCalledTimes(stops);
    expect(vi.mocked(api.saveWorkspace).mock.calls.at(-1)?.[0]).toMatchObject({ tabs: [{ name: 'Build console' }] });
  });
  it('cancels project rename without writes and saves display-only metadata without path/membership changes', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const project = bootstrap().projects[0];
    vi.mocked(api.updateProject).mockResolvedValue({ ...project, name: 'Friendly project' });
    render(<App />); await tick(); selectGroup();
    fireEvent.click(screen.getByRole('button', { name: '重新命名專案' }));
    fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(api.updateProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新命名專案' }));
    expect(screen.getByLabelText('顯示名稱')).toHaveValue(project.name);
    fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: '  Friendly project  ' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存名稱' })); await tick();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(project.id, { name: 'Friendly project' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Friendly project');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(workspaceSnapshot().panes['pane-a'].cwd).toBe(project.path);
    expect(api.createProject).not.toHaveBeenCalled(); expect(api.addProject).not.toHaveBeenCalled();
  });
  it('reorders the rendered tabs and numeric navigation follows the persisted order', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap(); const workspace = data.workspace as Workspace;
    workspace.tabs.push({ ...workspace.tabs[0], id: 'tab-b', name: 'Second', focusedPaneId: 'pane-b', layout: { kind: 'pane', paneId: 'pane-b' } });
    workspace.panes['pane-b'] = { ...workspace.panes['pane-a'], id: 'pane-b' };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />); await tick(); selectGroup();
    const tab = screen.getByRole('button', { name: 'Second 1' });
    fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true });
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: mac, ctrlKey: !mac });
    expect(workspaceSnapshot().tabs.map((item) => item.id)).toEqual(['tab-b', 'tab-a']);
    expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-b');
    await tick(450);
    expect((vi.mocked(api.saveWorkspace).mock.calls.at(-1)?.[0] as Workspace).tabs.map((item) => item.id)).toEqual(['tab-b', 'tab-a']);
  });
});

it('integrates temporary tab naming, selection and reordering without inventing a project identity', async () => {
  vi.mocked(isDesktop).mockReturnValue(true);
  render(<App />);
  await tick();
  fireEvent.click(screen.getByRole('button', { name: '開啟臨時 Terminal' }));
  fireEvent.click(screen.getByRole('button', { name: '新增臨時 Terminal' }));
  const before = workspaceSnapshot();
  const globalTabs = before.tabs.filter((tab) => tab.projectId === null);
  fireEvent.click(screen.getByRole('button', { name: '重新命名分頁 Terminal 1' }));
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Named global' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存名稱' })));
  const select = screen.getByRole('button', { name: /^Named global 1$/ });
  fireEvent.click(select);
  expect(workspaceSnapshot().activeTemporaryTabId).toBe(globalTabs[0].id);
  fireEvent.keyDown(select, { key: 'ArrowRight', altKey: true });
  const after = workspaceSnapshot();
  expect(after.tabs.filter((tab) => tab.projectId === null).map((tab) => tab.id)).toEqual([globalTabs[1].id, globalTabs[0].id]);
  expect(after.activeTemporaryTabId).toBe(globalTabs[0].id);
  expect(after.activeTabByProject).toEqual(before.activeTabByProject);
  expect(after.activeTabByProject).not.toHaveProperty('null');
  expect(after.panes).toEqual(before.panes);
  expect(api.addProject).not.toHaveBeenCalled();
  expect(api.stop).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
  await tick(500);
  const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as Workspace;
  expect(saved.tabs.filter((tab) => tab.projectId === null).map((tab) => tab.name)).toEqual(['Terminal 2', 'Named global']);
  expect(saved.activeTemporaryTabId).toBe(globalTabs[0].id);
});


describe('resumed conversation tab titles', () => {
  beforeEach(() => { vi.mocked(isDesktop).mockReturnValue(true); });
  it.each(['codex', 'claude', 'grok', 'antigravity', 'opencode'] as const)('uses the preview title for a new %s tab and persists it', async kind => {
    vi.mocked(isDesktop).mockReturnValue(true);
    native.sessionKind = kind;
    native.sessionTitle = '  修復搜尋 <title> $(echo literal)  ';
    const data = bootstrap();
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
    const current = workspaceSnapshot();
    expect(current.tabs[0].name).toBe('修復搜尋 <title> $(echo literal)');
    expect(Object.values(current.panes)[0]).toMatchObject({ kind, sessionId: 'synthetic-session', cwd: '/synthetic/project' });
    await tick(500);
    expect((vi.mocked(api.saveWorkspace).mock.calls.at(-1)?.[0] as Workspace).tabs[0].name).toBe(current.tabs[0].name);
  });
  it.each(['', '  \t\n  '])('retains provider fallback for an empty title %j', async title => {
    native.sessionTitle = title;
    const data = bootstrap();
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
    expect(workspaceSnapshot().tabs[0].name).toBe(agentNames.codex);
  });
  it('normalizes and bounds a long preview title without changing session identity', async () => {
    native.sessionTitle = '  第一行\n' + '😀'.repeat(210);
    const data = bootstrap();
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
    expect(workspaceSnapshot().tabs[0].name).toBe('第一行 ' + '😀'.repeat(196));
  });
  it.each(['placeholder', 'disconnected'] as const)('preserves a manually named existing tab when resuming its %s pane', async state => {
    const data = bootstrap();
    const saved = data.workspace as Workspace;
    saved.tabs[0].name = 'My manual name';
    saved.panes['pane-a'] = { ...saved.panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session' };
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    if (state === 'disconnected') act(() => native.patch?.('pane-a', { state, runtimeId: 'kept-runtime' }));
    selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
    expect(workspaceSnapshot().tabs).toHaveLength(1);
    expect(workspaceSnapshot().tabs[0].name).toBe('My manual name');
  });
});


it('keeps a manually renamed live tab when backend resume focuses its existing runtime', async () => {
  const { original, newPane } = await resumeWithExistingLiveSession('/synthetic/original-worktree', 'running', 'Keep my manual name');
  act(() => native.alreadyOpen?.(newPane.id, {
    id: 'original-runtime', paneId: 'pane-a', sessionId: 'synthetic-session',
    state: 'running', cwd: '/synthetic/original-worktree', exitCode: null,
  }));
  expect(workspaceSnapshot().tabs).toEqual(original.tabs);
  expect(workspaceSnapshot().tabs[0].name).toBe('Keep my manual name');
});

it.each(['running', 'exited'] as const)('closes only the newly titled resumed tab after its Agent is %s', async state => {
  vi.mocked(isDesktop).mockReturnValue(true);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  native.sessionTitle = 'Resume preview title';
  const data = bootstrap();
  (data.workspace as Workspace).tabs[0].name = 'Keep original Shell';
  vi.mocked(api.bootstrap).mockResolvedValue(data);
  render(<App />);
  await tick();
  selectGroup();
  fireEvent.click(screen.getByRole('button', { name: 'Resume synthetic history session' }));
  const resumed = Object.values(workspaceSnapshot().panes).find((pane) => pane.sessionId === 'synthetic-session')!;
  act(() => native.patch?.(resumed.id, { runtimeId: 'resumed-runtime', state, exitCode: state === 'exited' ? 0 : null }));
  await tick();
  expect(workspaceSnapshot().tabs.map((tab) => tab.name)).toEqual(['Keep original Shell', 'Resume preview title']);
  // Agent success remains inspectable even though successful Shells auto-close.
  expect(api.forget).not.toHaveBeenCalled();
  vi.mocked(api.runtimes).mockResolvedValue([
    brokerRecord(),
    brokerRecord({ id: 'resumed-runtime', paneId: resumed.id, kind: 'codex', state, exitCode: state === 'exited' ? 0 : null }),
  ]);
  expect(fireEvent.keyDown(window, { key: 'w', code: 'KeyW', metaKey: true })).toBe(false);
  if (state === 'running')
    fireEvent.click(within(screen.getByRole('dialog', { name: '關閉 1 個面板？' })).getByRole('button', { name: '結束並關閉' }));
  await tick();
  await tick(500);
  expect(workspaceSnapshot().tabs.map((tab) => tab.name)).toEqual(['Keep original Shell']);
  expect(workspaceSnapshot().panes['pane-a']).toBeDefined();
  expect(workspaceSnapshot().activeTabByProject['project-a']).toBe('tab-a');
  expect(api.forget).toHaveBeenCalledExactlyOnceWith('resumed-runtime');
  expect(vi.mocked(api.stop).mock.calls).toEqual(state === 'running' ? [['resumed-runtime']] : []);
  expect(api.close).not.toHaveBeenCalled();
  const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)?.[0] as Workspace;
  expect(saved.tabs.map((tab) => tab.name)).toEqual(['Keep original Shell']);
});


describe('sidebar organization persistence', () => {
  it('reports persistence failure while keeping the requested collapse usable', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />); await tick();
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      fireEvent.click(screen.getByRole('button', { name: '專案' }));
      expect(screen.getByRole('button', { name: '專案' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText(/側欄偏好無法儲存/)).toBeInTheDocument();
      expect(api.stop).not.toHaveBeenCalled();
    } finally { save.mockRestore(); }
  });
  it('independently collapses sections and restores them without stopping a workspace', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const first = render(<App />); await tick();
    fireEvent.click(screen.getByRole('button', { name: '專案' }));
    expect(screen.getByRole('button', { name: '專案' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: '搜尋專案' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /開啟工作區 Synthetic/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '開啟中的工作區' }));
    expect(screen.queryByRole('button', { name: /開啟工作區 Synthetic/ })).not.toBeInTheDocument();
    expect(api.stop).not.toHaveBeenCalled(); expect(api.updateProject).not.toHaveBeenCalled();
    first.unmount(); render(<App />); await tick();
    expect(screen.getByRole('button', { name: '專案' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: '開啟中的工作區' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('restores manual order after reload without changing project records or runtime state', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects.push({ ...data.projects[0], id: 'project-b', name: 'Second project', pinned: true });
    vi.mocked(api.bootstrap).mockResolvedValue(data); vi.mocked(api.projects).mockResolvedValue(data.projects);
    const first = render(<App />); await tick();
    const names = () => within(screen.getByRole('navigation', { name: '專案' })).getAllByRole('button', { name: /^排序 / }).map(item => item.getAttribute('aria-label'));
    expect(names()).toEqual(['排序 Second project', '排序 Synthetic project']);
    fireEvent.click(screen.getByRole('button', { name: '上移 Synthetic project' }));
    expect(names()).toEqual(['排序 Synthetic project', '排序 Second project']);
    expect(screen.queryByLabelText(/置頂/)).not.toBeInTheDocument();
    expect(api.updateProject).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled();
    first.unmount(); render(<App />); await tick();
    expect(names()).toEqual(['排序 Synthetic project', '排序 Second project']);
  });
});
