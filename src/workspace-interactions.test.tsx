import { cleanup, act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  await waitFor(() => expect(screen.getByText(/^縮放 100%/)).not.toHaveTextContent('套用中'));
  return input;
}
function openThemePicker() {
  fireEvent.click(screen.getByRole('button', { name: /搜尋專案或執行命令/ }));
  const search = screen.getByRole('combobox', { name: '搜尋命令或專案' });
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
    fireEvent.keyDown(screen.getByRole('combobox', { name: '搜尋命令或專案' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.setWorkspaceZoom).toHaveBeenLastCalledWith(110);
    expect(bridge.write).toHaveBeenCalledTimes(2);
    expect(bridge.attach).toHaveBeenCalledOnce(); expect(bridge.launch).not.toHaveBeenCalled(); expect(bridge.stop).not.toHaveBeenCalled();
    expect(bridge.reset).toHaveBeenCalledTimes(resets); expect(bridge.dispose).not.toHaveBeenCalled();
  });
});

it('a deferred focus-mode restoration must not steal a newer terminal search focus', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  fireEvent.click(screen.getByRole('button', { name: '進入專注模式' }));
  fireEvent.click(screen.getByRole('button', { name: '搜尋終端文字' }));
  const search = screen.getByRole('textbox', { name: '終端搜尋' });
  expect(search).toHaveFocus();
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(search).toHaveFocus();
});


it('restores ordinary focus-mode toggles, but rejects stale generations and navigation', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const focus = vi.spyOn(input, 'focus');
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  const enter = screen.getByRole('button', { name: '進入專注模式' });
  act(() => enter.focus());
  fireEvent.click(enter);
  const first = frames.shift()!;
  act(() => first(0));
  expect(input).toHaveFocus();
  expect(focus).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '退出專注模式' }));
  const stale = frames.shift()!;
  fireEvent.click(screen.getByRole('button', { name: '進入專注模式' }));
  const current = frames.shift()!;
  act(() => stale(0));
  expect(focus).toHaveBeenCalledOnce();
  act(() => current(0));
  expect(focus).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: '退出專注模式' }));
  const beforeNavigation = frames.shift()!;
  fireEvent.click(screen.getByRole('tab', { name: /目錄/ }));
  act(() => beforeNavigation(0));
  expect(focus).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalled();
  expect(bridge.write).not.toHaveBeenCalled();
  expect(bridge.attach).toHaveBeenCalledOnce();
});

it('invalidates deferred focus restoration after unmount', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const focus = vi.spyOn(input, 'focus');
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  fireEvent.click(screen.getByRole('button', { name: '進入專注模式' }));
  const pending = frames.shift()!;
  cleanup();
  act(() => pending(0));
  expect(focus).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});

it('hiding temporarily revealed controls restores keyboard focus and hides fixed navigation', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const enter = screen.getByRole('button', { name: '進入專注模式' });
  act(() => enter.focus()); fireEvent.click(enter);
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });
  const hide = screen.getByRole('button', { name: /搜尋專案或執行命令/ });
  act(() => hide.focus()); fireEvent.keyDown(hide, { key: 'b', ctrlKey: true, shiftKey: true });
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
  expect(document.querySelector('.sidebar')).not.toBeVisible();
  expect(screen.getByRole('navigation', { name: '工作區功能' })).toBeVisible();
  expect(screen.getByRole('button', { name: '歷史 Sessions' })).toHaveAttribute('aria-expanded', 'false');
  expect(document.querySelector('#activity-projects-panel')).toBeNull();
});

it.each([undefined, '', 'Mod+Shift+Z'])('shows the Zen Mode settings label without changing binding %s', async binding => {
  const data = fixture();
  if (binding !== undefined) data.settings.shortcuts = { 'toggle-focus-mode': binding };
  bridge.bootstrap.mockResolvedValue(data);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
  fireEvent.click(screen.getByRole('button', { name: '鍵盤快捷鍵' }));
  expect(screen.getByRole('textbox', { name: /進入／退出專注模式（Zen Mode） toggle-focus-mode/ })).toHaveValue(binding ?? 'Mod+Shift+Enter');
});

it('finds Zen Mode entry and exit in the command palette and restores terminal focus', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const trigger = screen.getByRole('button', { name: /搜尋專案或執行命令/ });
  act(() => trigger.focus()); fireEvent.click(trigger);
  const search = screen.getByRole('combobox', { name: '搜尋命令或專案' });
  fireEvent.change(search, { target: { value: 'Zen Mode' } });
  expect(screen.getByRole('option', { name: /進入專注模式（Zen Mode）/ })).toHaveTextContent(/Enter|↵/);
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });
  fireEvent.click(trigger);
  const exitSearch = screen.getByRole('combobox', { name: '搜尋命令或專案' });
  fireEvent.change(exitSearch, { target: { value: 'zen mode' } });
  expect(screen.getByRole('option', { name: /退出專注模式（Zen Mode）/ })).toHaveTextContent(/Enter|↵/);
  fireEvent.keyDown(exitSearch, { key: 'Enter' });
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
});


it.each([true, false])('does not restore revealed controls over newer search (initial project panel %s)', async sidebarOpen => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  if (!sidebarOpen) fireEvent.click(screen.getByRole('button', { name: '隱藏側欄' }));
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  fireEvent.click(screen.getByRole('button', { name: '進入專注模式' }));
  act(() => frames.splice(0).forEach(callback => callback(0)));
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });
  const hide = screen.getByRole('button', { name: /搜尋專案或執行命令/ });
  act(() => hide.focus()); fireEvent.keyDown(hide, { key: 'b', ctrlKey: true, shiftKey: true });
  fireEvent.click(screen.getByRole('button', { name: '搜尋終端文字' }));
  const search = screen.getByRole('textbox', { name: '終端搜尋' });
  expect(search).toHaveFocus();
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(search).toHaveFocus();
  expect(bridge.write).not.toHaveBeenCalled();
});

it('CSS-hidden connected topbar owner restores neutral focus', async () => {
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const enter = screen.getByRole('button', { name: '進入專注模式' });
  act(() => enter.focus()); fireEvent.click(enter);
  act(() => frames.splice(0).forEach(callback => callback(0)));
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });
  const hide = screen.getByRole('button', { name: /搜尋專案或執行命令/ });
  act(() => hide.focus());
  fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true });
  expect(hide.isConnected).toBe(true);
  expect(document.querySelector('.app-shell')).toHaveClass('workspace-focus');
  // jsdom does not implement focus loss after ancestor display:none; model the browser's CSS blur.
  act(() => hide.blur());
  expect(document.body).toHaveFocus();
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
});


it('restores an opt-in shortcut from chrome that becomes hidden', async () => {
  const data = fixture();
  data.settings.shortcuts = { 'toggle-focus-mode': 'Mod+Shift+Z' };
  bridge.bootstrap.mockResolvedValue(data);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux');
  const input = await ready();
  vi.spyOn(input, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const trigger = screen.getByRole('button', { name: /搜尋專案或執行命令/ });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(document.querySelector('.app-shell')).toHaveClass('workspace-focus');
  act(() => trigger.blur());
  act(() => frames.splice(0).forEach(callback => callback(0)));
  expect(input).toHaveFocus();
  expect(bridge.write).not.toHaveBeenCalled();
});

it.each(['Win32', 'Linux', 'MacIntel'])('toggles Zen with the default before terminal input on %s', async platform => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  const input = await ready();
  const forwarded = vi.fn();
  input.addEventListener('keydown', forwarded);
  const binding = { key: 'Enter', shiftKey: true, ctrlKey: platform !== 'MacIntel', metaKey: platform === 'MacIntel' };
  expect(fireEvent.keyDown(input, binding)).toBe(false);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  expect(fireEvent.keyDown(input, { ...binding, repeat: true })).toBe(false);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  fireEvent.keyUp(input, binding);
  expect(fireEvent.keyDown(input, binding)).toBe(false);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
  expect(input).toHaveFocus();
  expect(forwarded).not.toHaveBeenCalled();
  expect(bridge.write).not.toHaveBeenCalled();
  // No chord prefix is captured or buffered; xterm sees these immediately.
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'z' });
  expect(forwarded.mock.calls.map(([event]) => event.key)).toEqual(['k', 'z']);
});

it.each(['', 'Mod+Shift+Z', 'conflict'])('does not replace explicit Zen binding %s', async binding => {
  const data = fixture();
  data.settings.shortcuts = binding === 'conflict' ? { 'new-terminal': 'Mod+Shift+Enter' } : { 'toggle-focus-mode': binding };
  bridge.bootstrap.mockResolvedValue(data);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  const input = await ready();
  expect(fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(true);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
});

it('leaves editable inputs, IME and dialogs alone with the Zen default', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  const input = await ready();
  const binding = { key: 'Enter', ctrlKey: true, shiftKey: true };
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(input, { ...binding, ...extra })).toBe(true);
  }
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, binding)).toBe(true);
  fireEvent.compositionEnd(input);
  const prevented = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...binding });
  prevented.preventDefault();
  fireEvent(input, prevented);
  const search = screen.getByRole('textbox', { name: '搜尋專案' });
  fireEvent.keyDown(search, binding);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
  fireEvent.click(screen.getByRole('button', { name: '設定與資料來源' }));
  expect(fireEvent.keyDown(input, binding)).toBe(true);
  expect(document.querySelector('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
});