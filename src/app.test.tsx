import { agentNames, defaultAgentOptions } from './agents';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api, isDesktop } from './api';
import type { AgentKind, Bootstrap, LaunchPreview, Pane, Project, RuntimeInfo, Session, Workspace } from './types';
import { emptyWorkspace } from './workspace';
import { startup } from './startup';
import { runSmokeInteraction } from './smoke';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload?: unknown }) => void>(),
  patch: undefined as ((id: string, patch: Partial<Pane>) => void) | undefined,
  sessionCwd: undefined as string | null | undefined,
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
    runtimes: vi.fn(),
    launch: vi.fn(),
    detect: vi.fn(),
    cancelScan: vi.fn(),
    clearIndex: vi.fn(),
    saveSettings: vi.fn(),
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
    const session: Session | undefined = projects[0] ? {
      id: 'synthetic-session', sourceId: 'synthetic-source', kind: 'codex', externalId: 'external',
      projectId: projects[0].id, title: 'Synthetic session',
      cwd: native.sessionCwd === undefined ? projects[0].path : native.sessionCwd,
      updatedAt: '2026-10-15T01:00:00Z', timeSource: 'event', archived: false,
      parentId: null, partial: false, snippet: null,
    } : undefined;
    return <div data-testid="history-view">
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
    settings: {
      version: 1,
      theme: 'dark',
      terminalTheme: 'bay',
      fontFamily: 'monospace',
      fontSize: 14,
      defaultAgent: 'codex',
      defaultProfileId: 'default',
      profiles: [{ id: 'default', name: 'Shell', executable: '/bin/bash', args: ['-l'], env: {} }],
      sources: [],
      agentOptions: defaultAgentOptions(),
      executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy' },
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
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function nativeClose() {
  await act(async () => {
    native.handlers.get('app-close-requested')?.({});
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  native.handlers.clear();
  native.patch = undefined;
  native.sessionCwd = undefined;
  native.alreadyOpen = undefined;
  vi.mocked(isDesktop).mockReturnValue(false);
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap());
  vi.mocked(api.scan).mockResolvedValue(bootstrap().index);
  vi.mocked(api.index).mockResolvedValue(bootstrap().index);
  vi.mocked(api.projects).mockResolvedValue(bootstrap().projects);
  vi.mocked(api.saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(api.close).mockResolvedValue(undefined);
  vi.mocked(api.stop).mockResolvedValue(undefined);
  vi.mocked(api.preview).mockResolvedValue({ executable: '/bin/bash', args: ['-l'], cwd: '/synthetic/project' });
  vi.mocked(api.runtimes).mockResolvedValue([]);
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
    fireEvent.click(screen.getByRole('button', { name: /所有工作階段/ }));
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /^Synthetic project/ }));
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
  it('does not stop or close active programs when native-close confirmation is cancelled', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    await nativeClose();
    const confirmation = screen.getByRole('dialog', { name: '結束 1 個程序並退出？' });
    expect(within(confirmation).getByText(/Saved shell/)).toBeInTheDocument();
    expect(api.close).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.close).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByText('1 個執行中程序')).toBeInTheDocument();
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
  it('starts in All Sessions with an empty curated list while automatic history stays available', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], curated: false, sessionCount: 12 };
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(screen.getByRole('heading', { name: '所有工作階段' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '所有工作階段 12' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('尚未加入專案。從所有工作階段挑選目錄，或加入／建立專案。')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toEqual(data.projects);
    expect(screen.getByTestId('history-selected-project')).toHaveTextContent('all');
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it('curates only through the history callback and restores saved inclusion and removal after reload', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects[0] = { ...data.projects[0], curated: false, sessionCount: 4 };
    data.workspace = emptyWorkspace();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    const included = { ...data.projects[0], curated: true };
    vi.mocked(api.updateProject).mockResolvedValueOnce(included);
    const first = render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Curate synthetic history project' }));
    await tick();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('project-a', { curated: true });
    expect(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Synthetic project/ })).toBeInTheDocument();
    first.unmount();
    vi.mocked(api.bootstrap).mockResolvedValue({ ...data, projects: [included] });
    const second = render(<App />);
    await tick();
    fireEvent.click(within(screen.getByRole('navigation', { name: '專案' })).getByRole('button', { name: /^Synthetic project/ }));
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    vi.mocked(api.updateProject).mockResolvedValueOnce(data.projects[0]);
    fireEvent.click(screen.getByRole('button', { name: '移出專案' }));
    await tick();
    expect(api.updateProject).toHaveBeenLastCalledWith('project-a', { curated: false });
    expect(screen.getByRole('heading', { name: '所有工作階段' })).toBeInTheDocument();
    second.unmount();
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '所有工作階段 4' })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('history-projects').textContent!)).toEqual(data.projects);
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
    fireEvent.click(screen.getByRole('button', { name: /所有工作階段/ }));
    fireEvent.click(within(screen.getByRole('region', { name: '開啟中的工作區' })).getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    expect(screen.getByRole('heading', { name: 'Synthetic project' })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('workspace-snapshot').textContent!)).toEqual(before);
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('project-a', { curated: false });
  });

  it.each(['existing', 'create'] as const)('adds a %s project and refreshes the sidebar before selecting it', async (mode) => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const added: Project = { ...bootstrap().projects[0], id: 'added', name: 'Chosen folder', path: '/synthetic/chosen' };
    vi.mocked(api.addProject).mockResolvedValue(added);
    vi.mocked(api.createProject).mockResolvedValue(added);
    vi.mocked(api.projects).mockResolvedValue([...bootstrap().projects, added]);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '加入／建立專案' }));
    if (mode === 'create') fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '上層目錄路徑' : '目錄路徑'), { target: { value: mode === 'create' ? '/synthetic' : '/synthetic/chosen' } });
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '專案名稱（新資料夾名稱）' : '專案名稱（選填）'), { target: { value: 'Chosen folder' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: '加入或建立專案' })).getByRole('button', { name: mode === 'create' ? '建立並加入' : '加入專案' }));
    await tick();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chosen folder' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: '加入／建立專案' }));
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
      fireEvent.click(screen.getByRole('button', { name: '加入／建立專案' }));
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
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    let reject!: (reason: unknown) => void;
    vi.mocked(api.updateProject).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<App />);
    await tick();
    const add = screen.getByRole('button', { name: 'Curate synthetic history project' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add).toBeDisabled();
    expect(api.updateProject).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('Unable to save project membership')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save project membership');
    expect(add).toBeEnabled();
    expect(within(screen.getByRole('navigation', { name: '專案' })).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('App successful shell exit navigation', () => {
  it('returns to history after a final shell exits successfully and never restores late duplicate patches', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark synthetic runtime running' }));
    act(() => { native.patch?.('pane-a', { state: 'exited', exitCode: 0 }); });
    act(() => {
      native.patch?.('pane-a', { state: 'exited', exitCode: 0 });
      native.patch?.('pane-a', { runtimeId: 'late-runtime' });
    });
    expect(JSON.parse(screen.getByTestId('workspace-snapshot').textContent!)).toEqual(emptyWorkspace());
    expect(screen.queryByRole('region', { name: '開啟中的工作區' })).not.toBeInTheDocument();
    expect(screen.getByTestId('history-view')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.stop).not.toHaveBeenCalled();
    await tick(500);
    expect(api.saveWorkspace).toHaveBeenCalledExactlyOnceWith(emptyWorkspace());
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
  fireEvent.click(screen.getByRole('button', { name: /^Synthetic project/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  return screen.getByRole('dialog', { name: '開始新的工作' });
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
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
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Shell Profile' }), { target: { value: 'alternate' } });
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeDisabled();
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'shell', profileId: 'alternate' }));
    expect(within(dialog).getByRole('button', { name: '開始工作' })).toBeEnabled();
  });

  it('offers four named agents plus the shell and requires the backend preview before launch', async () => {
    const pending = deferredPreview();
    vi.mocked(api.preview).mockReturnValueOnce(pending.promise);
    const dialog = await openLauncher();
    for (const name of ['Codex', 'Claude Code', 'Grok Build', 'Antigravity CLI', 'Terminal']) {
      expect(within(dialog).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Antigravity CLI/ }));
    await tick(150);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('找不到 agy 執行檔');
    const start = within(dialog).getByRole('button', { name: '開始工作' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form')!);
    expect(Object.keys(workspaceSnapshot().panes)).toEqual(['pane-a']);
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
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
  it.each(['grok', 'antigravity'] as const)('previews and persists the trimmed manual %s resume ID separately from the catalog ID', async (kind) => {
    vi.mocked(api.preview).mockResolvedValue({ executable: kind === 'grok' ? '/synthetic/grok' : '/synthetic/agy',
      args: [kind === 'grok' ? '--resume' : '--conversation', 'synthetic-conversation'], cwd: '/synthetic/project' });
    const dialog = await openLauncher();
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^${agentNames[kind]}`) }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), {
      target: { value: '  synthetic-conversation  ' },
    });
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind, resumeId: 'synthetic-conversation' }));
    expect(vi.mocked(api.preview).mock.calls.at(-1)![0].sessionId).toBeUndefined();
    expect(dialog.querySelector('pre')?.textContent).toContain('synthetic-conversation');
    if (kind === 'antigravity') expect(within(dialog).getByText(/尚不支援自動索引／預覽其歷史/)).toBeInTheDocument();
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), { target: { value: 'grok-only-id' } });
    const label = kind === 'shell' ? 'Terminal' : agentNames[kind];
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`^${label}`) }));
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /接續對話 ID/ }), { target: { value: '   ' } });
    await tick(150);
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'grok', resumeId: undefined }));
  });
  it.each(['grok', 'antigravity'] as const)('restores a %s manual conversation as a placeholder without previewing or starting it', async (kind) => {
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
    fireEvent.click(within(dialog).getByRole('button', { name: /^Grok Build/ }));
    expect(within(dialog).getByText(/已啟用高風險權限模式/)).toHaveTextContent('--always-approve');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Antigravity CLI/ }));
    expect(within(dialog).queryByText(/已啟用高風險權限模式/)).not.toBeInTheDocument();
  });
});


async function resumeWithExistingLiveSession(cwd: string, state: 'running' | 'starting' = 'running') {
  vi.mocked(isDesktop).mockReturnValue(true);
  native.sessionCwd = cwd;
  const data = bootstrap();
  data.settings.sources = [{ id: 'synthetic-source', kind: 'codex', root: '/synthetic/current-source-root', enabled: true }];
  (data.workspace as Workspace).panes['pane-a'] = {
    ...(data.workspace as Workspace).panes['pane-a'], kind: 'codex', sessionId: 'synthetic-session', cwd: '/synthetic/original-worktree',
  };
  vi.mocked(api.bootstrap).mockResolvedValue(data);
  render(<App />);
  await tick();
  act(() => native.patch?.('pane-a', { state, runtimeId: 'original-runtime' }));
  const original = workspaceSnapshot();
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
    const result = workspaceSnapshot();
    expect(result.panes['pane-a']).toEqual(original.panes['pane-a']);
    expect(result.panes[newPane.id]).toMatchObject({ state: 'failed', error: expect.stringContaining('無法重新附接') });
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
