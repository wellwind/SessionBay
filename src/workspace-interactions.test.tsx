import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultAgentOptions } from './agents';
import { shiftEnterSequence } from './terminal-keyboard';
import type { Bootstrap, Settings, TerminalEvent } from './types';

const bridge = vi.hoisted(() => ({
  bootstrap: vi.fn(), scan: vi.fn(), index: vi.fn(), projects: vi.fn(), saveWorkspace: vi.fn(), runtimes: vi.fn(),
  launch: vi.fn(), attach: vi.fn(), detach: vi.fn(), write: vi.fn(), resize: vi.fn(), ack: vi.fn(),
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
async function ready() {
  render(<App />);
  const navigation = await screen.findByRole('navigation', { name: '專案' });
  fireEvent.click(within(navigation).getByRole('button', { name: /^Synthetic project/ }));
  fireEvent.click(screen.getByRole('button', { name: '開啟工作區 Synthetic project Terminal' }));
  await waitFor(() => expect(bridge.attach).toHaveBeenCalledOnce());
  const channel = bridge.attach.mock.calls[0][1] as (event: TerminalEvent) => void;
  act(() => channel({ type: 'snapshot', runtimeId: 'runtime-a', sequence: 0, data: [], cols: 80, rows: 24, truncated: false }));
  const input = screen.getByRole('textbox', { name: 'Integration terminal input' });
  act(() => input.focus());
  await waitFor(() => expect(screen.getByText(/^工作台 100%/)).not.toHaveTextContent('套用中'));
  return input;
}
function openThemePicker() {
  fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
  const search = screen.getByRole('textbox', { name: '搜尋命令或專案' });
  fireEvent.change(search, { target: { value: '切換介面主題' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  return screen.getByRole('combobox', { name: '搜尋主題' });
}
describe('real workspace input with theme and whole-page zoom', () => {
  it.each(['Linux', 'MacIntel'])('keeps inline input, IME and zoom independent on %s', async platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const input = await ready();
    const resets = bridge.reset.mock.calls.length;
    expect(fireEvent.keyDown(input, { key: '=', ctrlKey: platform === 'Linux', metaKey: platform === 'MacIntel' })).toBe(false);
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ appZoom: 110, fontSize: 14 })));
    expect(bridge.write).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(bridge.write).toHaveBeenCalledExactlyOnceWith('runtime-a', shiftEnterSequence));
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(bridge.write).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(bridge.write).toHaveBeenCalledTimes(2));
    const picker = openThemePicker();
    fireEvent.change(picker, { target: { value: 'Code 2026 · 淺色' } });
    expect(document.documentElement.dataset.themePalette).toBe('code-2026');
    const saved = bridge.saveSettings.mock.calls.length;
    fireEvent.keyDown(picker, { key: '=', ctrlKey: platform === 'Linux', metaKey: platform === 'MacIntel' });
    fireEvent.compositionStart(picker); fireEvent.keyDown(picker, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.compositionEnd(picker); fireEvent.keyDown(picker, { key: 'Escape' });
    expect(document.documentElement.dataset.themePalette).toBe('bay');
    expect(bridge.saveSettings).toHaveBeenCalledTimes(saved);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜尋命令或專案' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.setWorkspaceZoom).toHaveBeenLastCalledWith(110);
    expect(bridge.write).toHaveBeenCalledTimes(2);
    expect(bridge.attach).toHaveBeenCalledOnce(); expect(bridge.launch).not.toHaveBeenCalled(); expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.reset).toHaveBeenCalledTimes(resets); expect(bridge.dispose).not.toHaveBeenCalled();
  });
});
