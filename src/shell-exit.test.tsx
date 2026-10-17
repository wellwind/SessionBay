import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultAgentOptions } from './agents';
import type { Bootstrap, Settings, TerminalEvent, RuntimeRecord, Workspace } from './types';

const bridge = vi.hoisted(() => ({
  bootstrap: vi.fn(), scan: vi.fn(), index: vi.fn(), projects: vi.fn(), saveWorkspace: vi.fn(), runtimes: vi.fn(),
  preview: vi.fn(), launch: vi.fn(), launchFresh: vi.fn(), attach: vi.fn(), detach: vi.fn(), write: vi.fn(), resize: vi.fn(), ack: vi.fn(),
  stop: vi.fn(), forget: vi.fn(), settleLaunches: vi.fn(), close: vi.fn(), detect: vi.fn(),
  saveSettings: vi.fn(), setWorkspaceZoom: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
}));
vi.mock('./api', () => ({ api: bridge, isDesktop: () => true,
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('./startup', () => ({ startup: { mounted: vi.fn(), ready: vi.fn(), backendError: vi.fn() } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('./directory-picker', () => ({ canPickDirectory: () => false, pickDirectory: vi.fn() }));
vi.mock('./components/History', () => ({ agentName: (kind: string) => kind, dateLabel: () => '', HistoryView: () => null }));
// Keep App, WorkspaceCanvas, TerminalPane and all document listeners real.
// Only the native bridge and the xterm drawing/input boundary are synthetic.
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown>;
  textarea?: HTMLTextAreaElement;
  handler = (event: KeyboardEvent) => { void event; return true; };
  data = (value: string) => { void value; };
  parser = { registerOscHandler: () => ({ dispose() {} }) };
  constructor(options: Record<string, unknown>) { this.options = options; }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.handler = handler; }
  loadAddon() {}
  open(host: HTMLElement) {
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'xterm-helper-textarea';
    this.textarea.setAttribute('aria-label', 'Integration terminal input');
    this.textarea.addEventListener('keydown', event => { this.handler(event); });
    host.append(this.textarea);
  }
  onData(callback: (value: string) => void) { this.data = callback; return { dispose() {} }; }
  input(value: string) { this.data(value); }
  write(_data: unknown, done?: () => void) { done?.(); }
  reset() { bridge.reset(); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  focus() { this.textarea?.focus(); }
  getSelection() { return ''; }
  dispose() { bridge.dispose(); }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));

const record = { id: 'runtime-a', paneId: 'pane-a', kind: 'codex' as const, projectId: 'project-a',
  sessionId: null, resumeId: null, profileId: null, cwd: '/synthetic/project', state: 'running' as const, exitCode: null };
function fixture(): Bootstrap {
  return {
    runtimes: [record],
    settings: { version: 1, theme: 'dark', themePalette: 'bay', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14, appZoom: 100,
      defaultAgent: 'codex', defaultProfileId: 'default', profiles: [{ id: 'default', name: 'Shell', executable: '/bin/sh', args: [], env: {} }],
      sources: [], agentOptions: defaultAgentOptions(), executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
      shortcuts: {}, onboardingComplete: true },
    projects: [{ id: 'project-a', name: 'Synthetic project', path: '/synthetic/project', launchPath: null, exists: true,
      pinned: false, curated: true, sessionCount: 0, updatedAt: null, agents: [] }],
    installations: [], index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] }, warnings: [],
    workspace: { version: 1, panes: { 'pane-a': { id: 'pane-a', kind: 'codex', title: 'Codex', projectId: 'project-a', cwd: '/synthetic/project', state: 'running', runtimeId: 'runtime-a', startToken: 1 } },
      tabs: [{ id: 'tab-a', projectId: 'project-a', name: 'Terminal', focusedPaneId: 'pane-a', layout: { kind: 'pane', paneId: 'pane-a' } }], activeTabByProject: { 'project-a': 'tab-a' } },
  };
}
beforeEach(() => {
  const data = fixture();
  bridge.bootstrap.mockResolvedValue(data); bridge.scan.mockResolvedValue(data.index); bridge.index.mockResolvedValue(data.index); bridge.projects.mockResolvedValue(data.projects);
  bridge.runtimes.mockResolvedValue(data.runtimes); bridge.attach.mockResolvedValue(record);
  bridge.saveSettings.mockImplementation(async (settings: Settings) => settings);
  for (const mock of [bridge.saveWorkspace, bridge.detach, bridge.write, bridge.resize, bridge.ack, bridge.stop, bridge.forget, bridge.settleLaunches, bridge.close, bridge.setWorkspaceZoom]) mock.mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
});

function setup(records: RuntimeRecord[], split = false) {
  const data = fixture();
  data.runtimes = records;
  const workspace: Workspace = { version: 1, panes: {}, tabs: [], activeTabByProject: {} };
  for (const item of records) {
    workspace.panes[item.paneId] = { id: item.paneId, kind: item.kind, title: item.paneId,
      projectId: item.projectId, cwd: item.cwd, state: 'placeholder' };
    if (split && workspace.tabs.length) {
      workspace.tabs[0].layout = { kind: 'split', id: 'split', axis: 'horizontal', ratio: 0.5,
        first: workspace.tabs[0].layout, second: { kind: 'pane', paneId: item.paneId } };
    } else {
      workspace.tabs.push({ id: item.paneId + '-tab', projectId: item.projectId, name: item.paneId,
        focusedPaneId: item.paneId, layout: { kind: 'pane', paneId: item.paneId } });
    }
    if (item.projectId === null) workspace.activeTemporaryTabId ??= item.paneId + '-tab';
    else workspace.activeTabByProject[item.projectId] ??= item.paneId + '-tab';
  }
  data.workspace = workspace;
  bridge.bootstrap.mockResolvedValue(data);
  bridge.runtimes.mockResolvedValue(records);
  bridge.attach.mockImplementation(async (id: string) => records.find(item => item.id === id));
  return data;
}
const shell = (overrides: Partial<RuntimeRecord> = {}): RuntimeRecord => ({ ...record, kind: 'shell', ...overrides });
async function mountProject() {
  render(<App />);
  const navigation = await screen.findByRole('navigation', { name: '專案' });
  fireEvent.click(await within(navigation).findByRole('button', { name: /^Synthetic project/ }));
  await waitFor(() => expect(bridge.attach).toHaveBeenCalled());
}
function exit(id: string, exitCode: number | null = 0) {
  const call = bridge.attach.mock.calls.find(call => call[0] === id)!;
  act(() => (call[1] as (event: TerminalEvent) => void)({ type: 'exit', runtimeId: id, exitCode }));
}
describe('successful Shell exit lifecycle', () => {
  it.each([false, true])('removes only the completed pane (split=%s), persists and never stops siblings', async split => {
    setup([shell(), shell({ id: 'runtime-b', paneId: 'pane-b' })], split);
    await mountProject();
    exit('runtime-a');
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    expect(document.querySelector('strong[title="pane-b"]')).toBeInTheDocument();
    await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({
      panes: expect.not.objectContaining({ 'pane-a': expect.anything() }),
    })));
    expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.settleLaunches).not.toHaveBeenCalled();
  });
  it.each(['project-a', null])('closes the last pane and tab for %s', async projectId => {
    setup([shell({ projectId })]);
    render(<App />);
    await waitFor(() => expect(bridge.attach).toHaveBeenCalled());
    exit('runtime-a');
    await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ panes: {}, tabs: [] })));
    expect(bridge.stop).not.toHaveBeenCalled();
  });
  it('cleans up a successful shell already exited when the UI reattaches', async () => {
    setup([shell({ state: 'exited', exitCode: 0 })]);
    render(<App />);
    await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a'));
    await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: [] })));
  });
  it.each([
    { state: 'exited', exitCode: 7 }, { state: 'exited', exitCode: null },
    { state: 'failed', exitCode: 0 }, { state: 'interrupted', exitCode: null },
    { state: 'disconnected', exitCode: null },
  ] satisfies Partial<RuntimeRecord>[])('retains $kind $state $exitCode for inspection', async overrides => {
    setup([shell(overrides)]);
    render(<App />);
    await screen.findByRole('navigation', { name: '專案' });
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    expect(bridge.forget).not.toHaveBeenCalled();
  });
  it('does not clean up a restored placeholder with no broker runtime', async () => {
    const data = setup([shell()]);
    data.runtimes = [];
    bridge.bootstrap.mockResolvedValue(data);
    render(<App />);
    await screen.findByRole('navigation', { name: '專案' });
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(bridge.attach).not.toHaveBeenCalled();
  });
  it('retains the pane and reports a failed forget without stopping anything', async () => {
    setup([shell()]);
    bridge.forget.mockRejectedValue(new Error('Cannot forget runtime'));
    await mountProject();
    exit('runtime-a');
    await screen.findByText('Cannot forget runtime');
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it('does not resurrect a pane when exit precedes the attach response', async () => {
    setup([shell()]);
    let resolve!: (record: RuntimeRecord) => void;
    bridge.attach.mockImplementation(() => new Promise<RuntimeRecord>(done => { resolve = done; }));
    await mountProject();
    exit('runtime-a');
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    await act(async () => resolve(shell()));
    expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument();
    expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
  });
  it('keeps a restarted pane when the old runtime forget resolves late', async () => {
    setup([shell()]);
    let finishForget!: () => void;
    bridge.forget.mockImplementation(() => new Promise<void>(done => { finishForget = done; }));
    bridge.launch.mockResolvedValue(shell({ id: 'runtime-new' }));
    await mountProject();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
    exit('runtime-a');
    await waitFor(() => expect(bridge.forget).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
    await waitFor(() => expect(bridge.launch).toHaveBeenCalledOnce());
    await act(async () => finishForget());
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    // Runtime-only changes do not alter the persisted layout.
    expect(bridge.saveWorkspace.mock.calls.every(([saved]) => saved.panes['pane-a'])).toBe(true);
    exit('runtime-a');
    expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(bridge.stop).not.toHaveBeenCalled();
  });
  it('ignores duplicate and obsolete exit events after removal', async () => {
    setup([shell()]);
    await mountProject();
    exit('runtime-a');
    await waitFor(() => expect(bridge.forget).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    exit('runtime-a');
    expect(bridge.forget).toHaveBeenCalledOnce();
  });
});

it('waits for successful-shell cleanup before the final close snapshot', async () => {
  const data = setup([shell(), shell({ id: 'runtime-b', paneId: 'pane-b' })], true);
  let persisted = data.workspace as Workspace;
  bridge.saveWorkspace.mockImplementation(async (saved: Workspace) => { persisted = saved; });
  let finishForget!: () => void;
  bridge.forget.mockImplementation(() => new Promise<void>(done => { finishForget = done; }));
  await mountProject();
  exit('runtime-a');
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a'));
  const { listen } = await import('@tauri-apps/api/event');
  const closeListener = vi.mocked(listen).mock.calls.find(([name]) => name === 'app-close-requested')?.[1];
  expect(closeListener).toBeDefined();
  await act(async () => closeListener!({ event: 'app-close-requested', id: 0, payload: undefined }));
  expect(bridge.close).not.toHaveBeenCalled();
  await act(async () => finishForget());
  await waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
  expect(persisted.panes['pane-a']).toBeUndefined();
  expect(persisted.panes['pane-b']).toBeDefined();
  expect(persisted.tabs).toHaveLength(1);
  expect(bridge.stop).not.toHaveBeenCalled();
});

it.each([false, true])('defers new exits after native close starts (close failure=%s)', async fails => {
  setup([shell()]);
  let finishClose!: () => void;
  let failClose!: (error: Error) => void;
  bridge.close.mockImplementation(() => new Promise<void>((resolve, reject) => {
    finishClose = resolve; failClose = reject;
  }));
  await mountProject();
  const { listen } = await import('@tauri-apps/api/event');
  const closeListener = vi.mocked(listen).mock.calls.find(([name]) => name === 'app-close-requested')?.[1];
  await act(async () => closeListener!({ event: 'app-close-requested', id: 0, payload: undefined }));
  await waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
  exit('runtime-a');
  expect(bridge.forget).not.toHaveBeenCalled();
  if (fails) {
    await act(async () => failClose(new Error('Close failed')));
    await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a'));
  } else {
    await act(async () => finishClose());
    expect(bridge.forget).not.toHaveBeenCalled();
  }
});


describe('resumed Agent exit lifecycle', () => {
  it.each(['codex', 'claude', 'antigravity'] as const)('closes only the resumed %s split pane without launching or stopping another process', async kind => {
    setup([{ ...record, kind, sessionId: 'indexed-session' }, shell({ id: 'runtime-b', paneId: 'pane-b' })], true);
    await mountProject();
    exit('runtime-a');
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    expect(document.querySelector('strong[title="pane-b"]')).toBeInTheDocument();
    exit('runtime-a');
    expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(bridge.launch).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.settleLaunches).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude', 'antigravity'] as const)('cleans an already exited manual %s resume on reattach, including its last tab', async kind => {
    setup([{ ...record, kind, resumeId: 'manual-id', state: 'exited', exitCode: 0 }]);
    render(<App />);
    await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a'));
    await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ panes: {}, tabs: [] })));
    expect(bridge.launch).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
  });
  it.each([
    { exitCode: 7 }, { exitCode: null },
    { state: 'failed' }, { state: 'interrupted' },
  ].flatMap(patch => (['codex', 'claude', 'antigravity'] as const).map(kind => ({ ...patch, kind }))))('retains abnormal Agent exits: %j', async patch => {
    setup([{ ...record, state: 'exited', exitCode: 0, ...patch }]);
    render(<App />);
    await screen.findByRole('navigation', { name: '專案' });
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(bridge.launch).not.toHaveBeenCalled();
  });
  it('keeps a Shell running after its nested Agent returns a prompt', async () => {
    setup([shell()]);
    await mountProject();
    const callback = bridge.attach.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() => callback({ type: 'output', runtimeId: 'runtime-a', sequence: 1,
      data: Array.from(new TextEncoder().encode('Agent exited\r\n$ ')) }));
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(bridge.launch).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled();
  });
});


it('does not close a restarted resumed Agent when old cleanup finishes late', async () => {
  setup([{ ...record, sessionId: 'indexed-session' }]);
  let finishForget!: () => void;
  bridge.forget.mockImplementation(() => new Promise<void>(done => { finishForget = done; }));
  bridge.launch.mockResolvedValue({ ...record, id: 'new-runtime' });
  await mountProject();
  fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
  exit('runtime-a');
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
  await waitFor(() => expect(bridge.launch).toHaveBeenCalledOnce());
  await act(async () => finishForget());
  expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
  exit('runtime-a');
  expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a');
  expect(bridge.stop).not.toHaveBeenCalled();
});

it('cleans a background resumed Agent without changing another tab or project', async () => {
  setup([shell(), { ...record, id: 'runtime-b', paneId: 'pane-b', resumeId: 'manual-id' }]);
  await mountProject();
  exit('runtime-b');
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-b'));
  expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
  await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({
    activeTabByProject: { 'project-a': 'pane-a-tab' },
    panes: expect.not.objectContaining({ 'pane-b': expect.anything() }),
  })));
  expect(bridge.launch).not.toHaveBeenCalled();
  expect(bridge.stop).not.toHaveBeenCalled();
});

it('closes a resumed launch that exits before its launch response arrives', async () => {
  setup([{ ...record, sessionId: 'indexed-session', state: 'exited', exitCode: 7 }]);
  let finishLaunch!: (value: RuntimeRecord) => void;
  bridge.launch.mockImplementation(() => new Promise<RuntimeRecord>(done => { finishLaunch = done; }));
  await mountProject();
  fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
  fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
  await waitFor(() => expect(bridge.launch).toHaveBeenCalledOnce());
  const callback = bridge.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
  act(() => callback({ type: 'exit', runtimeId: 'early-exit-runtime', exitCode: 0 }));
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('early-exit-runtime'));
  await act(async () => finishLaunch({ ...record, id: 'early-exit-runtime' }));
  await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ panes: {}, tabs: [] })));
  expect(bridge.launch).toHaveBeenCalledOnce();
  expect(bridge.stop).not.toHaveBeenCalled();
});


it.each((['codex', 'claude', 'antigravity'] as const).flatMap(kind => [true, false].map(split => ({ kind, split }))))('closes a newly launched $kind pane (right split=$split) while retaining the original resumed Agent', async ({ kind, split }) => {
  setup([{ ...record, sessionId: 'original-resume' }]);
  bridge.preview.mockResolvedValue({ executable: kind, args: [], cwd: '/synthetic/project' });
  const fresh = { ...record, id: 'fresh-runtime', paneId: 'backend-fresh-pane', kind };
  bridge.launchFresh.mockResolvedValue(fresh);
  bridge.attach.mockImplementation(async (id: string) => id === fresh.id ? fresh : { ...record, sessionId: 'original-resume' });
  await mountProject();
  fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
  fireEvent.click(screen.getByRole('button', { name: split ? '左右分割' : 'Terminal' }));
  const dialog = screen.getByRole('dialog', { name: split ? '分割並新增面板' : '開始新的工作' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Agent/ }));
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${kind}`) }));
  const start = within(dialog).getByRole('button', { name: '開始工作' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(bridge.launchFresh).toHaveBeenCalledOnce());
  expect(bridge.launchFresh.mock.calls[0][0]).toMatchObject({ kind });
  expect(bridge.launchFresh.mock.calls[0][0]).not.toHaveProperty('sessionId');
  expect(bridge.launchFresh.mock.calls[0][0]).not.toHaveProperty('resumeId');
  expect(bridge.launch).not.toHaveBeenCalled();
  await waitFor(() => expect(bridge.attach).toHaveBeenCalledWith('fresh-runtime', expect.any(Function), expect.any(String)));
  const callback = bridge.attach.mock.calls.find(call => call[0] === 'fresh-runtime')![1] as (event: TerminalEvent) => void;
  act(() => callback({ type: 'exit', runtimeId: 'fresh-runtime', exitCode: 0 }));
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('fresh-runtime'));
  await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({
    tabs: [expect.objectContaining({ layout: { kind: 'pane', paneId: 'pane-a' } })],
    panes: { 'pane-a': expect.anything() },
  })));
  expect(bridge.launchFresh).toHaveBeenCalledOnce();
  expect(bridge.stop).not.toHaveBeenCalled();
});

it.each(['codex', 'claude', 'grok', 'antigravity', 'opencode'] as const)('closes a fresh %s main tab on confirmed success, including reattachment', async kind => {
  setup([{ ...record, kind, sessionId: null, resumeId: null, state: 'exited', exitCode: 0 }]);
  render(<App />);
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledExactlyOnceWith('runtime-a'));
  await waitFor(() => expect(bridge.saveWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ panes: {}, tabs: [] })));
  expect(bridge.launch).not.toHaveBeenCalled();
  expect(bridge.stop).not.toHaveBeenCalled();
});
