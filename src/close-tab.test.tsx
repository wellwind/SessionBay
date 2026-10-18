import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultAgentOptions } from './agents';
import type { Bootstrap, Settings, RuntimeRecord, Workspace, TerminalEvent } from './types';

const bridge = vi.hoisted(() => ({
  bootstrap: vi.fn(), scan: vi.fn(), index: vi.fn(), projects: vi.fn(), saveWorkspace: vi.fn(), runtimes: vi.fn(),
  launch: vi.fn(), attach: vi.fn(), detach: vi.fn(), write: vi.fn(), resize: vi.fn(), ack: vi.fn(),
  stop: vi.fn(), forget: vi.fn(), settleLaunches: vi.fn(), close: vi.fn(), detect: vi.fn(),
  saveSettings: vi.fn(), setWorkspaceZoom: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
  listWorkspaceFiles: vi.fn(), readWorkspaceFile: vi.fn(),
}));
vi.mock('./api', () => ({ api: bridge, isDesktop: () => true,
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('./startup', () => ({ startup: { mounted: vi.fn(), ready: vi.fn(), backendError: vi.fn() } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('./directory-picker', () => ({ canPickDirectory: () => false, pickDirectory: vi.fn() }));
vi.mock('./components/History', () => ({ agentName: (kind: string) => kind, dateLabel: () => '',
  HistoryView: ({ sidebarHost, onSelectSession }: { sidebarHost?: HTMLDivElement | null; onSelectSession?: () => void }) =>
    sidebarHost ? createPortal(<button onClick={onSelectSession}>Select synthetic history session</button>, sidebarHost) : null,
}));
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
  onRender() { return { dispose() {} }; }
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
  bridge.listWorkspaceFiles.mockResolvedValue({ entries: [], nextOffset: null });
  bridge.readWorkspaceFile.mockImplementation(async (_id, path) => ({ path, text: `content ${path}`, sizeBytes: 12 }));
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

async function openWorkspace() {
  await mountProject();
  fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
}
function cmdW(options: KeyboardEventInit = {}) {
  return fireEvent.keyDown(screen.getAllByRole('textbox', { name: 'Integration terminal input', hidden: true })[0],
    { key: 'w', code: 'KeyW', metaKey: true, ...options });
}
async function nativeCloseTab() {
  const { listen } = await import('@tauri-apps/api/event');
  const handler = vi.mocked(listen).mock.calls.find(([name]) => name === 'workspace-close-tab-requested')?.[1];
  expect(handler).toBeDefined();
  act(() => handler!({ event: 'workspace-close-tab-requested', id: 0, payload: undefined }));
}
beforeEach(() => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel'));
describe('Cmd+W closes only the current workspace tab', () => {
  it('routes captured Cmd+W and native close from file controls without touching runtimes', async () => {
    setup([shell()]);
    bridge.listWorkspaceFiles.mockResolvedValue({ entries: [{ name: 'safe.ts', path: 'safe.ts', kind: 'file' }], nextOffset: null });
    bridge.readWorkspaceFile.mockResolvedValue({ path: 'safe.ts', text: 'const safe = true;', sizeBytes: 18 });
    await openWorkspace();
    const terminal = screen.getByRole('textbox', { name: 'Integration terminal input' });
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'safe.ts' }));
    const editor = await screen.findByLabelText('唯讀內容：safe.ts'); editor.focus();
    fireEvent.keyDown(editor, { key: 'w', code: 'KeyW', metaKey: true });
    expect(screen.queryByRole('tab', { name: /safe.ts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'safe.ts' }));
    await screen.findByLabelText('唯讀內容：safe.ts');
    screen.getByRole('button', { name: 'Files' }).focus();
    await nativeCloseTab();
    expect(screen.queryByRole('tab', { name: /safe.ts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.stop).not.toHaveBeenCalled(); expect(bridge.forget).not.toHaveBeenCalled();
    expect(bridge.write).not.toHaveBeenCalled(); expect(bridge.close).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Integration terminal input' })).toBe(terminal);
  });
  it('captures before xterm, confirms all split panes once, and preserves the app and other tabs', async () => {
    const records = [shell(), shell({ id: 'runtime-b', paneId: 'pane-b', kind: 'codex' })];
    const data = setup(records, true);
    const workspace = data.workspace as Workspace;
    workspace.panes['pane-c'] = { ...workspace.panes['pane-a'], id: 'pane-c', title: 'pane-c' };
    workspace.tabs.push({ id: 'tab-c', name: 'Other tab', projectId: 'project-a',
      focusedPaneId: 'pane-c', layout: { kind: 'pane', paneId: 'pane-c' } });
    await openWorkspace();
    expect(cmdW()).toBe(false);
    await nativeCloseTab(); // Native/DOM duplicate must not create another close.
    const dialog = screen.getByRole('dialog', { name: '關閉 2 個面板？' });
    expect(bridge.stop).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '結束並關閉' }));
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    expect(document.querySelector('strong[title="pane-b"]')).not.toBeInTheDocument();
    expect(document.querySelector('strong[title="pane-c"]')).toBeInTheDocument();
    expect(bridge.stop.mock.calls).toEqual([['runtime-a'], ['runtime-b']]);
    expect(bridge.forget.mock.calls).toEqual([['runtime-a'], ['runtime-b']]);
    expect(bridge.write).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
  });
  it('cancels live close, allows a later native request, and leaves window open after the final tab', async () => {
    setup([shell()]);
    await openWorkspace();
    cmdW();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(bridge.stop).not.toHaveBeenCalled();
    await nativeCloseTab();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    expect(bridge.close).not.toHaveBeenCalled();
    await nativeCloseTab();
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(bridge.close).not.toHaveBeenCalled();
  });
  it('closes a temporary tab without changing a project tab', async () => {
    const records = [shell({ projectId: null }), shell({ id: 'runtime-b', paneId: 'pane-b' })];
    setup(records);
    render(<App />);
    await waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(2));
    const temporary = screen.getByRole('button', { name: '開啟工作區 臨時 Terminal pane-a' });
    fireEvent.click(temporary);
    await nativeCloseTab();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
    await waitFor(() => expect(document.querySelector('strong[title="pane-a"]')).not.toBeInTheDocument());
    expect(document.querySelector('strong[title="pane-b"]')).toBeInTheDocument();
    expect(bridge.stop).toHaveBeenCalledExactlyOnceWith('runtime-a');
    expect(bridge.close).not.toHaveBeenCalled();
  });
  it('does not close during composition, repeat, modal input, or history view', async () => {
    setup([shell()]);
    await mountProject();
    fireEvent.click(screen.getByRole('button', { name: '歷史 Sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select synthetic history session' }));
    await nativeCloseTab(); // history
    expect(bridge.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project pane-a' }));
    cmdW({ repeat: true });
    cmdW({ isComposing: true });
    const input = screen.getByRole('textbox', { name: 'Integration terminal input' });
    fireEvent.compositionStart(input);
    await nativeCloseTab();
    fireEvent.compositionEnd(input);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
    cmdW();
    await nativeCloseTab();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('關閉 1 個面板');
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('does not stop or remove a replacement runtime while the close request is waiting', async () => {
    setup([shell()]);
    let resolveRecords!: (records: RuntimeRecord[]) => void;
    bridge.runtimes.mockImplementation(() => new Promise<RuntimeRecord[]>(resolve => { resolveRecords = resolve; }));
    bridge.launch.mockResolvedValue(shell({ id: 'runtime-new' }));
    await openWorkspace();
    cmdW();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
    await waitFor(() => expect(bridge.runtimes).toHaveBeenCalledOnce());
    const channel = bridge.attach.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() => channel({ type: 'error', runtimeId: 'runtime-a', message: 'Old runtime failed' }));
    fireEvent.click(screen.getByRole('button', { name: '重新啟動' }));
    await waitFor(() => expect(bridge.launch).toHaveBeenCalledOnce());
    await act(async () => resolveRecords([shell(), shell({ id: 'runtime-new' })]));
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('retains the pane rather than adopting an unknown broker replacement', async () => {
    setup([shell()]);
    bridge.runtimes.mockResolvedValue([shell({ id: 'unknown-replacement' })]);
    await openWorkspace();
    cmdW();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
    await screen.findByText('此面板的程序已變更，請重新連線後再關閉。');
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.forget).not.toHaveBeenCalled();
    expect(document.querySelector('strong[title="pane-a"]')).toBeInTheDocument();
  });
  it('does not capture Cmd+Q, Cmd+Shift+W, or Linux Ctrl+W as close-tab', async () => {
    setup([shell()]);
    await openWorkspace();
    expect(cmdW({ key: 'q' })).toBe(true);
    // Cmd+Shift+W retains the existing close-pane command, not close-tab.
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
    expect(cmdW({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.close).not.toHaveBeenCalled();
  });
});

it.each([false, true])('joins confirmed tab removal with final application save (partial failure=%s)', async partialFailure => {
  const data = setup([shell(), shell({ id: 'runtime-b', paneId: 'pane-b', kind: 'codex' })], true);
  let persisted = data.workspace as Workspace;
  bridge.saveWorkspace.mockImplementation(async (saved: Workspace) => { persisted = saved; });
  let finishForget!: () => void;
  bridge.forget.mockImplementation((id: string) => id === 'runtime-b'
    ? new Promise<void>((resolve, reject) => { finishForget = () => partialFailure ? reject(new Error('Forget failed')) : resolve(); })
    : Promise.resolve());
  await openWorkspace();
  cmdW();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
  await waitFor(() => expect(bridge.forget).toHaveBeenCalledTimes(2));
  const { listen } = await import('@tauri-apps/api/event');
  const closeListener = vi.mocked(listen).mock.calls.find(([name]) => name === 'app-close-requested')?.[1];
  await act(async () => closeListener!({ event: 'app-close-requested', id: 0, payload: undefined }));
  expect(bridge.close).not.toHaveBeenCalled();
  await act(async () => finishForget());
  await waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
  expect(persisted.panes['pane-a']).toBeUndefined();
  if (partialFailure) expect(persisted.panes['pane-b']).toBeDefined();
  else expect(persisted.tabs).toEqual([]);
});

it('does not begin a previously confirmed close after the native-close snapshot is sealed', async () => {
  setup([shell()]);
  let finishClose!: () => void;
  bridge.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = resolve; }));
  await openWorkspace();
  cmdW();
  const { listen } = await import('@tauri-apps/api/event');
  const closeListener = vi.mocked(listen).mock.calls.find(([name]) => name === 'app-close-requested')?.[1];
  await act(async () => closeListener!({ event: 'app-close-requested', id: 0, payload: undefined }));
  await waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '結束並關閉' }));
  await act(async () => finishClose());
  expect(bridge.stop).not.toHaveBeenCalled();
  expect(bridge.forget).not.toHaveBeenCalled();
  expect(bridge.runtimes).not.toHaveBeenCalled();
});


describe('project Files workspace integration', () => {
  const files = () => bridge.listWorkspaceFiles.mockResolvedValue({ entries: ['a.ts', 'b.ts', '.env.example'].map(path => ({ name: path, path, kind: 'file' })), nextOffset: null });
  it('browses hidden files without creating a runtime, and preserves the document across Zen and sidebar toggles', async () => {
    setup([]); files();
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: '專案' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /^Synthetic project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(await screen.findByRole('button', { name: '.env.example' })).toBeVisible();
    expect(bridge.listWorkspaceFiles).toHaveBeenCalledWith('project-a', '', 0, true);
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
    const document = await screen.findByLabelText('唯讀內容：a.ts');
    const tab = screen.getByRole('tab', { name: /a.ts/ });
    expect(tab.closest('.workspace-tabs')).not.toBeNull();
    expect(screen.queryByLabelText('顯示隱藏檔案')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(document).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '進入專注模式' }));
    expect(screen.getByLabelText('唯讀內容：a.ts')).toBe(document);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(screen.getByRole('button', { name: '.env.example' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '退出專注模式' }));
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'false');
    expect(bridge.launch).not.toHaveBeenCalled(); expect(bridge.attach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '關閉檔案 a.ts' }));
    expect(screen.queryByRole('tab', { name: /a.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'false');
    expect(tab).not.toBeInTheDocument();
    expect(bridge.stop).not.toHaveBeenCalled();
  });
  it('shares files across runtime tabs, cycles common shortcuts, and never writes file keys to PTY', async () => {
    setup([shell(), shell({ id: 'runtime-b', paneId: 'pane-b' })]); files();
    await openWorkspace();
    const terminals = screen.getAllByRole('textbox', { name: 'Integration terminal input', hidden: true });
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.doubleClick(await screen.findByRole('button', { name: 'a.ts' }));
    await screen.findByLabelText('唯讀內容：a.ts');
    const file = screen.getByRole('tab', { name: /a.ts/ });
    fireEvent.keyDown(file, { key: '1', code: 'Digit1', metaKey: true });
    expect(screen.getByRole('button', { name: 'pane-a 1' })).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(terminals[0], { key: '3', code: 'Digit3', metaKey: true });
    expect(file).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'pane-b 1' }));
    expect(file).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(file);
    expect(screen.getByLabelText('唯讀內容：a.ts')).toBeVisible();
    expect(screen.getAllByRole('textbox', { name: 'Integration terminal input', hidden: true })).toEqual(terminals);
    expect(bridge.dispose).not.toHaveBeenCalled(); expect(bridge.detach).not.toHaveBeenCalled();
    expect(bridge.stop).not.toHaveBeenCalled(); expect(bridge.write).not.toHaveBeenCalled();
  });
  it('keeps file closes blocked by a modal and composition, including when focus is on chrome', async () => {
    setup([shell()]); files(); await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    await screen.findByLabelText('唯讀內容：a.ts');
    const toggle = screen.getByRole('button', { name: 'Files' }); toggle.focus();
    fireEvent.keyDown(toggle, { key: 'w', metaKey: true, isComposing: true });
    expect(screen.getByRole('tab', { name: /a.ts/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新增工作區分頁' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'w', metaKey: true });
    expect(screen.getByRole('tab', { name: /a.ts/ })).toBeInTheDocument();
    expect(bridge.stop).not.toHaveBeenCalled();
  });
});

it('returns last-file close focus to the Files toggle when the tree is hidden', async () => {
  setup([shell()]);
  bridge.listWorkspaceFiles.mockResolvedValue({ entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file' }], nextOffset: null });
  await openWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
  const editor = await screen.findByLabelText('唯讀內容：a.ts');
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  editor.focus();
  fireEvent.keyDown(editor, { key: 'w', metaKey: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Files' })).toHaveFocus());
  expect(screen.queryByRole('tab', { name: /a.ts/ })).not.toBeInTheDocument();
  expect(bridge.stop).not.toHaveBeenCalled(); expect(bridge.write).not.toHaveBeenCalled();
});
