import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api, isDesktop } from './api';
import type { Bootstrap, Pane, Workspace } from './types';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload?: unknown }) => void>(),
  patch: undefined as ((id: string, patch: Partial<Pane>) => void) | undefined,
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
  },
}));
vi.mock('./components/History', () => ({
  agentName: (kind: string) => (kind === 'codex' ? 'Codex' : 'Claude Code'),
  dateLabel: () => '測試時間',
  HistoryView: () => <div data-testid="history-view">History test surface</div>,
}));
vi.mock('./components/WorkspaceCanvas', () => ({
  WorkspaceCanvas: ({
    workspace,
    onPatch,
    onClose,
    onStart,
  }: {
    workspace: Workspace;
    onPatch: (id: string, patch: Partial<Pane>) => void;
    onClose: (id: string) => void;
    onStart: (id: string) => void;
  }) => {
    native.patch = onPatch;
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
      executables: { codex: 'codex', claude: 'claude' },
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
  vi.mocked(isDesktop).mockReturnValue(false);
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap());
  vi.mocked(api.scan).mockResolvedValue(bootstrap().index);
  vi.mocked(api.index).mockResolvedValue(bootstrap().index);
  vi.mocked(api.projects).mockResolvedValue(bootstrap().projects);
  vi.mocked(api.saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(api.close).mockResolvedValue(undefined);
  vi.mocked(api.stop).mockResolvedValue(undefined);
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
  it('exposes restored workspace-only projects even when the catalog is initially empty', async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    const data = bootstrap();
    data.projects = [];
    vi.mocked(api.bootstrap).mockResolvedValue(data);
    render(<App />);
    await tick();
    expect(screen.getByText('僅工作區 · /synthetic/project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^project 僅工作區/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /所有 Session/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Synthetic project/ }));
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
