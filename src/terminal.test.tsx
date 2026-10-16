import { useState } from 'react';
import { emptyWorkspace, reconcileRuntimes, restoreWorkspace, serializeWorkspace } from './workspace';
import { workspaceZoomEvent } from './workspace-zoom';
import { defaultAgentOptions } from './agents';
import { shouldHandleTerminalKey } from './terminal-ime';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './components/TerminalPane';
import { installNativeConfirmation } from './test/dialog-init';
import type { Pane, RuntimeInfo, Settings, TerminalEvent } from './types';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  termReset: vi.fn(),
  termResize: vi.fn(),
  termPaste: vi.fn(),
  fit: vi.fn(),
  initialCols: 80,
  initialRows: 24,
  write: vi.fn(),
  resize: vi.fn(),
  ack: vi.fn(),
  stop: vi.fn(),
  termWrite: vi.fn(),
  disposed: vi.fn(),
  termFocus: vi.fn(),
  keyHandler: vi.fn(),
  reset: vi.fn(),
  focus: vi.fn(),
  options: [] as Record<string, unknown>[],
  input: undefined as undefined | ((value: string) => void),
}));
vi.mock('./api', () => ({ errorMessage: (e: unknown) => String(e), api: mocks }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = mocks.initialCols;
    rows = mocks.initialRows;
    options: Record<string, unknown> = {};
    constructor() { mocks.options.push(this.options); }
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { mocks.keyHandler(handler); }
    textarea?: HTMLTextAreaElement;
    open(host: HTMLElement) {
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('aria-label', 'Mock xterm input');
      host.append(this.textarea);
    }
    reset() { mocks.termReset(); mocks.reset(); }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; mocks.termResize(cols, rows); }
    focus() { mocks.termFocus(); mocks.focus(); this.textarea?.focus(); }
    getSelection() {
      return '';
    }
    paste(text: string) { mocks.termPaste(text); }
    dispose() {
      mocks.disposed();
    }
    onData(callback: (value: string) => void) {
      mocks.input = callback;
      return { dispose() {} };
    }
    write(data: Uint8Array, callback: () => void) {
      mocks.termWrite(data, callback);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { mocks.fit(); }
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext() {}
    findPrevious() {}
  },
}));
const settings: Settings = {
  version: 1,
  theme: 'dark',
  terminalTheme: 'bay',
  fontFamily: 'monospace',
  fontSize: 13,
  defaultAgent: 'codex',
  defaultProfileId: 'shell',
  profiles: [],
  sources: [],
  agentOptions: defaultAgentOptions(),
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
  shortcuts: {},
  onboardingComplete: true,
};
const makePane = (patch: Partial<Pane> = {}): Pane => ({
  id: 'pane',
  kind: 'shell',
  title: 'Shell',
  projectId: 'project',
  cwd: '/tmp',
  state: 'placeholder',
  ...patch,
});
const info: RuntimeInfo = {
  id: 'runtime',
  paneId: 'pane',
  sessionId: null,
  state: 'running',
  cwd: '/tmp',
  exitCode: null,
};
function props(pane = makePane()) {
  return {
    pane,
    settings,
    visible: true,
    focused: true,
    maximized: false,
    onPatch: vi.fn(),
    onFocus: vi.fn(),
    onStart: vi.fn(),
    onClose: vi.fn(),
    onMaximize: vi.fn(),
    onSplit: vi.fn(),
    onAlreadyOpen: vi.fn(),
  };
}
function completeSnapshot(channel: (event: TerminalEvent) => void, runtimeId = 'runtime') {
  act(() => channel({ type: 'snapshot', runtimeId, sequence: 0, data: [], cols: 80, rows: 24, truncated: false }));
  act(() => mocks.termWrite.mock.calls.at(-1)![1]());
}
beforeEach(() => {
  mocks.initialCols = 80;
  mocks.initialRows = 24;

  mocks.options.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.launch.mockResolvedValue(info);
  mocks.attach.mockResolvedValue(info);
  mocks.detach.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.resize.mockResolvedValue(undefined);
  mocks.ack.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
});
describe('terminal lifetime and flow control', () => {
  it('installs the semantic CapsLock guard through the public xterm hook', () => {
    render(<TerminalPane {...props()} />);
    expect(mocks.keyHandler).toHaveBeenCalledExactlyOnceWith(shouldHandleTerminalKey);
  });

  it('can reopen a workspace-only shell without a deleted catalog project reference', async () => {
    render(<TerminalPane {...props(makePane({ startToken: 1 }))} projectAvailable={false} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ cwd: '/tmp', projectId: undefined });
  });

  it('restored placeholders never start a process automatically', () => {
    const view = render(<TerminalPane {...props()} />);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(view.getByText('重新開啟 Shell')).toBeInTheDocument();
  });
  it('starts once and preserves the xterm instance while hidden or settings change', async () => {
    const p = props(makePane({ startToken: 1 }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    view.rerender(<TerminalPane {...p} visible={false} />);
    view.rerender(<TerminalPane {...p} settings={{ ...settings, fontSize: 16 }} visible />);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.disposed).not.toHaveBeenCalled();
  });
  it('ACKs output only after xterm write completion and keeps bytes intact', async () => {
    render(<TerminalPane {...props(makePane({ startToken: 1 }))} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    const channel = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() =>
      channel({ type: 'output', runtimeId: 'runtime', sequence: 41, data: [0xe4, 0xb8, 0xad] }),
    );
    expect(mocks.termWrite.mock.calls[0][0]).toEqual(new Uint8Array([0xe4, 0xb8, 0xad]));
    expect(mocks.ack).not.toHaveBeenCalled();
    act(() => mocks.termWrite.mock.calls[0][1]());
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 41, mocks.launch.mock.calls[0][2]);
  });
  it('preserves a quick exit that arrives before launch response', async () => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementation(
      () =>
        new Promise<RuntimeInfo>((r) => {
          resolve = r;
        }),
    );
    const p = props(makePane({ startToken: 1 }));
    render(<TerminalPane {...p} />);
    const channel = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() => channel({ type: 'exit', runtimeId: 'runtime', exitCode: 7 }));
    await act(async () => resolve(info));
    expect(p.onPatch).toHaveBeenCalledWith('pane', { state: 'exited', exitCode: 7 });
    expect(p.onPatch.mock.calls.some(([, patch]) => patch.state === 'running')).toBe(false);
  });
  it('preserves a successful exit before launch response and ignores repeated runtime metadata', async () => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementation(() => new Promise<RuntimeInfo>((done) => { resolve = done; }));
    const p = props(makePane({ startToken: 1 }));
    render(<TerminalPane {...p} />);
    const channel = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() => {
      channel({ type: 'exit', runtimeId: 'runtime', exitCode: 0 });
      channel({ type: 'exit', runtimeId: 'runtime', exitCode: 0 });
    });
    await act(async () => resolve(info));
    expect(p.onPatch).toHaveBeenCalledWith('pane', { state: 'exited', exitCode: 0 });
    expect(p.onPatch.mock.calls.some(([, patch]) => patch.state === 'running')).toBe(false);
    await act(async () => { mocks.input?.('do not write after exit'); });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('retains a failure when an exit with code zero follows it before launch response', async () => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementation(() => new Promise<RuntimeInfo>((done) => { resolve = done; }));
    const p = props(makePane({ startToken: 1 }));
    render(<TerminalPane {...p} />);
    const channel = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
    act(() => {
      channel({ type: 'error', runtimeId: 'runtime', message: 'PTY reader failed' });
      channel({ type: 'exit', runtimeId: 'runtime', exitCode: 0 });
      channel({ type: 'exit', runtimeId: 'runtime', exitCode: 0 });
    });
    await act(async () => resolve(info));
    expect(p.onPatch).toHaveBeenCalledWith('pane', { state: 'failed', error: 'PTY reader failed' });
    expect(p.onPatch).toHaveBeenCalledWith('pane', { state: 'failed', exitCode: 0 });
    expect(p.onPatch.mock.calls.some(([, patch]) => ['running', 'exited'].includes(patch.state))).toBe(false);
  });
  it('ignores stale launch token events and ACKs stale output without writing it', async () => {
    const p = props(makePane({ startToken: 1 }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith('pane', expect.objectContaining({ state: 'running' })));
    const oldChannel = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
    mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2 })} />);
    await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith('pane', expect.objectContaining({ runtimeId: 'new-runtime' })));
    const currentChannel = mocks.launch.mock.calls[1][1] as (event: TerminalEvent) => void;
    p.onPatch.mockClear();
    act(() => {
      oldChannel({ type: 'error', runtimeId: 'runtime', message: 'Old failure' });
      oldChannel({ type: 'exit', runtimeId: 'runtime', exitCode: 0 });
      oldChannel({ type: 'output', runtimeId: 'runtime', sequence: 92, data: [65] });
    });
    expect(p.onPatch).not.toHaveBeenCalled();
    expect(mocks.termWrite).not.toHaveBeenCalled();
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 92, mocks.launch.mock.calls[0][2]);
    act(() => currentChannel({ type: 'exit', runtimeId: 'new-runtime', exitCode: 3 }));
    expect(p.onPatch).toHaveBeenCalledExactlyOnceWith('pane', { state: 'exited', exitCode: 3 });
  });
  it('detaches an obsolete launch response without changing the latest runtime', async () => {
    let resolveOld!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementationOnce(() => new Promise<RuntimeInfo>((done) => { resolveOld = done; }));
    const p = props(makePane({ startToken: 1 }));
    const view = render(<TerminalPane {...p} />);
    mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2 })} />);
    await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith('pane', expect.objectContaining({ runtimeId: 'new-runtime' })));
    p.onPatch.mockClear();
    await act(async () => resolveOld(info));
    expect(mocks.detach).toHaveBeenCalledWith('runtime', mocks.launch.mock.calls[0][2]);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(p.onPatch).not.toHaveBeenCalled();
    completeSnapshot(mocks.launch.mock.calls[1][1], 'new-runtime');
    await act(async () => { mocks.input?.('latest'); });
    expect(mocks.write).toHaveBeenCalledWith('new-runtime', 'latest');
  });
  it('detaches a launch completed after its pane was removed', async () => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementation(
      () =>
        new Promise<RuntimeInfo>((r) => {
          resolve = r;
        }),
    );
    const view = render(<TerminalPane {...props(makePane({ startToken: 1 }))} />);
    view.unmount();
    await act(async () => resolve(info));
    expect(mocks.detach).toHaveBeenCalledWith('runtime', mocks.launch.mock.calls[0][2]);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('focuses existing managed sessions rather than taking over their stream', async () => {
    mocks.launch.mockResolvedValue({ ...info, paneId: 'existing' });
    const p = props(makePane({ startToken: 1 }));
    render(<TerminalPane {...p} />);
    await waitFor(() =>
      expect(p.onAlreadyOpen).toHaveBeenCalledWith({ ...info, paneId: 'existing' }),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it.each(['stale', 'unmounted'] as const)('does not focus or stop an existing runtime from an %s duplicate-launch response', async (condition) => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementationOnce(() => new Promise<RuntimeInfo>((done) => { resolve = done; }));
    const p = props(makePane({ startToken: 1 }));
    const view = render(<TerminalPane {...p} />);
    if (condition === 'unmounted') view.unmount();
    else {
      mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
      view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2 })} />);
      await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith('pane', expect.objectContaining({ runtimeId: 'new-runtime' })));
    }
    p.onPatch.mockClear();
    await act(async () => resolve({ ...info, id: 'existing-runtime', paneId: 'other-pane' }));
    expect(p.onAlreadyOpen).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalledWith('existing-runtime');
    expect(p.onPatch).not.toHaveBeenCalled();
  });
  it('serializes typed input through the IPC queue', async () => {
    render(<TerminalPane {...props(makePane({ startToken: 1 }))} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    completeSnapshot(mocks.launch.mock.calls[0][1]);
    await act(async () => {
      mocks.input?.('a');
      mocks.input?.('中');
      mocks.input?.('\r');
    });
    expect(mocks.write.mock.calls).toEqual([
      ['runtime', 'a'],
      ['runtime', '中'],
      ['runtime', '\r'],
    ]);
  });
});


describe('additional agent terminal requests', () => {
  it.each(['grok', 'antigravity', 'opencode'] as const)('never launches a restored %s conversation without an explicit start token', (kind) => {
    render(<TerminalPane {...props(makePane({ kind, resumeId: 'synthetic-conversation' }))} />);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it.each(['grok', 'antigravity', 'opencode'] as const)('passes the %s manual ID as a separate launch field after explicit start', async (kind) => {
    const pane = makePane({ kind, resumeId: 'synthetic-conversation', cwd: '/synthetic/work tree', startToken: 1 });
    const config = props(pane);
    const view = render(<TerminalPane {...config} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    expect(mocks.launch).toHaveBeenCalledWith({
      paneId: 'pane', kind, projectId: 'project', sessionId: undefined, resumeId: 'synthetic-conversation',
      cwd: '/synthetic/work tree', profileId: undefined, cols: 80, rows: 24,
    }, expect.any(Function), expect.any(String));
    view.rerender(<TerminalPane {...config} visible={false} />);
    view.rerender(<TerminalPane {...config} settings={{ ...settings, agentOptions: {
      ...defaultAgentOptions(), [kind]: { extraArgs: ['--model', 'changed'], bypassPermissions: true },
    } }} />);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it('keeps a Grok catalog session ID distinct from a manual external resume ID', async () => {
    render(<TerminalPane {...props(makePane({ kind: 'grok', sessionId: 'catalog-session', startToken: 1 }))} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(1));
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ kind: 'grok', sessionId: 'catalog-session', resumeId: undefined });
  });
});

describe('persistent runtime attachment', () => {
  it('attaches a recovered live runtime without launching and waits for snapshot rendering before input', async () => {
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    expect(mocks.launch).not.toHaveBeenCalled();
    await act(async () => { mocks.input?.('too early'); });
    expect(mocks.write).not.toHaveBeenCalled();
    const channel = mocks.attach.mock.calls[0][1];
    act(() => channel({ type: 'snapshot', runtimeId: 'runtime', sequence: 0, data: [27, 91, 50, 74, 65], cols: 101, rows: 31, truncated: true }));
    expect(mocks.termReset).toHaveBeenCalledOnce();
    expect(mocks.termResize).toHaveBeenCalledWith(101, 31);
    expect(mocks.termWrite.mock.calls[0][0]).toEqual(new Uint8Array([27, 91, 50, 74, 65]));
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '貼上' })).toBeDisabled();
    await act(async () => { mocks.termWrite.mock.calls[0][1](); mocks.input?.('ready'); });
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 0, mocks.attach.mock.calls[0][2]);
    expect(mocks.write).toHaveBeenCalledWith('runtime', 'ready');
    expect(view.getByRole('alert')).toHaveTextContent('較早輸出超過保留上限');
    view.unmount();
    expect(mocks.detach).toHaveBeenCalledWith('runtime', mocks.attach.mock.calls[0][2]);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('serializes snapshot and delta paints and acknowledges each only after rendering', async () => {
    render(<TerminalPane {...props(makePane({ runtimeId: 'runtime', state: 'running' }))} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const channel = mocks.attach.mock.calls[0][1];
    act(() => {
      channel({ type: 'snapshot', runtimeId: 'runtime', sequence: 5, data: [65], cols: 80, rows: 24, truncated: false });
      channel({ type: 'output', runtimeId: 'runtime', sequence: 6, data: [66] });
    });
    expect(mocks.termWrite).toHaveBeenCalledOnce();
    act(() => mocks.termWrite.mock.calls[0][1]());
    expect(mocks.termWrite).toHaveBeenCalledTimes(2);
    expect(mocks.ack.mock.calls.map((call) => call[1])).toEqual([5]);
    act(() => mocks.termWrite.mock.calls[1][1]());
    expect(mocks.ack.mock.calls.map((call) => call[1])).toEqual([5, 6]);
  });
  it('reconnects with a new lease and ignores stale exit, disconnect and paint events', async () => {
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const old = mocks.attach.mock.calls[0];
    completeSnapshot(old[1]);
    act(() => old[1]({ type: 'disconnected', runtimeId: 'runtime', message: 'Stream lost' }));
    expect(p.onPatch).toHaveBeenCalledWith('pane', { state: 'disconnected', runtimeId: 'runtime' });
    view.rerender(<TerminalPane {...p} pane={makePane({ runtimeId: 'runtime', state: 'disconnected' })} />);
    fireEvent.click(view.getByRole('button', { name: '重新連線' }));
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
    const next = mocks.attach.mock.calls[1];
    expect(next[2]).not.toBe(old[2]);
    expect(mocks.detach).toHaveBeenCalledWith('runtime', old[2]);
    completeSnapshot(next[1]);
    p.onPatch.mockClear();
    mocks.termWrite.mockClear();
    act(() => {
      old[1]({ type: 'exit', runtimeId: 'runtime', exitCode: 1 });
      old[1]({ type: 'disconnected', runtimeId: 'runtime', message: 'Old stream' });
      old[1]({ type: 'output', runtimeId: 'runtime', sequence: 99, data: [67] });
    });
    expect(p.onPatch).not.toHaveBeenCalled();
    expect(mocks.termWrite).not.toHaveBeenCalled();
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 99, old[2]);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('does not undo a disconnect arriving before attach metadata or a snapshot callback', async () => {
    let resolve!: (value: RuntimeInfo) => void;
    mocks.attach.mockImplementationOnce(() => new Promise<RuntimeInfo>((done) => { resolve = done; }));
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    render(<TerminalPane {...p} />);
    const channel = mocks.attach.mock.calls[0][1];
    act(() => {
      channel({ type: 'snapshot', runtimeId: 'runtime', sequence: 0, data: [65], cols: 80, rows: 24, truncated: false });
      channel({ type: 'disconnected', runtimeId: 'runtime', message: 'Offline' });
    });
    await act(async () => { resolve(info); mocks.termWrite.mock.calls[0][1](); });
    await act(async () => { mocks.input?.('must not send'); });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(p.onPatch.mock.calls.some(([, patch]) => patch.state === 'running')).toBe(false);
  });
  it.each(['exited', 'failed'] as const)('preserves %s status when replay is unavailable after broker restart', async (state) => {
    mocks.attach.mockResolvedValueOnce({ ...info, state });
    const p = props(makePane({ runtimeId: 'runtime', state }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    act(() => mocks.attach.mock.calls[0][1]({ type: 'disconnected', runtimeId: 'runtime', message: 'Previous output is unavailable' }));
    expect(p.onPatch.mock.calls.some(([, patch]) => patch.state === 'disconnected')).toBe(false);
    expect(view.getByRole('alert')).toHaveTextContent('Previous output is unavailable');
  });
  it('never attaches or relaunches an interrupted runtime until explicit restart', () => {
    const p = props(makePane({ runtimeId: 'old-runtime', state: 'interrupted' }));
    const view = render(<TerminalPane {...p} />);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: '重新啟動' }));
    expect(p.onStart).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});

describe('attachment rendering races', () => {
  it('does not ACK a duplicate frame until its original write completes', async () => {
    render(<TerminalPane {...props(makePane({ runtimeId: 'runtime', state: 'running' }))} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const channel = mocks.attach.mock.calls[0][1];
    const event = { type: 'snapshot', runtimeId: 'runtime', sequence: 0, data: [65], cols: 80, rows: 24, truncated: false };
    act(() => { channel(event); channel(event); });
    expect(mocks.termWrite).toHaveBeenCalledOnce();
    expect(mocks.ack).not.toHaveBeenCalled();
    act(() => mocks.termWrite.mock.calls[0][1]());
    expect(mocks.ack).toHaveBeenCalledOnce();
  });
  it('finishes an old in-flight paint before resetting for a newer attachment snapshot', async () => {
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const old = mocks.attach.mock.calls[0];
    completeSnapshot(old[1]);
    act(() => old[1]({ type: 'output', runtimeId: 'runtime', sequence: 1, data: [65] }));
    act(() => old[1]({ type: 'disconnected', runtimeId: 'runtime', message: 'Offline' }));
    view.rerender(<TerminalPane {...p} pane={makePane({ runtimeId: 'runtime', state: 'disconnected' })} />);
    fireEvent.click(view.getByRole('button', { name: '重新連線' }));
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
    const next = mocks.attach.mock.calls[1];
    act(() => next[1]({ type: 'snapshot', runtimeId: 'runtime', sequence: 1, data: [66], cols: 90, rows: 30, truncated: false }));
    expect(mocks.termReset).toHaveBeenCalledOnce();
    act(() => mocks.termWrite.mock.calls[1][1]());
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 1, old[2]);
    expect(mocks.termReset).toHaveBeenCalledTimes(2);
    expect(mocks.termWrite.mock.calls[2][0]).toEqual(new Uint8Array([66]));
    act(() => mocks.termWrite.mock.calls[2][1]());
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 1, next[2]);
  });
  it('retains the same attachment across tab navigation and appearance changes', async () => {
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    view.rerender(<TerminalPane {...p} visible={false} />);
    view.rerender(<TerminalPane {...p} settings={{ ...settings, fontSize: 16 }} />);
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('does not fit new dimensions until the snapshot write has finished', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    act(() => mocks.attach.mock.calls[0][1]({ type: 'snapshot', runtimeId: 'runtime', sequence: 0, data: [65], cols: 100, rows: 1, truncated: false }));
    const before = mocks.fit.mock.calls.length;
    view.rerender(<TerminalPane {...p} settings={{ ...settings, fontSize: 20 }} />);
    expect(mocks.fit).toHaveBeenCalledTimes(before);
    expect(mocks.termResize).toHaveBeenCalledWith(100, 1);
    act(() => mocks.termWrite.mock.calls[0][1]());
    expect(mocks.fit).toHaveBeenCalledTimes(before + 1);
    expect(mocks.resize).toHaveBeenCalledWith('runtime', 100, 1);
  });
  it('clamps launch dimensions to the broker screen limits', async () => {
    mocks.initialCols = 1000;
    mocks.initialRows = 1000;
    render(<TerminalPane {...props(makePane({ startToken: 1 }))} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ cols: 320, rows: 120 });
  });
  it('does not paste a delayed clipboard read into a detached terminal', async () => {
    let resolve!: (text: string) => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: vi.fn(() => new Promise<string>((done) => { resolve = done; })),
    } });
    const p = props(makePane({ runtimeId: 'runtime', state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    fireEvent.click(view.getByRole('button', { name: '貼上' }));
    act(() => mocks.attach.mock.calls[0][1]({ type: 'disconnected', runtimeId: 'runtime', message: 'Offline' }));
    await act(async () => resolve('late input'));
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
});

it.each(['running', 'exited'] as const)('reattaches a remounted %s pane without replaying its old start token', async (state) => {
  mocks.attach.mockResolvedValueOnce({ ...info, state });
  render(<TerminalPane {...props(makePane({ runtimeId: 'runtime', state, startToken: 7 }))} />);
  await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
});

describe('global temporary terminal launch and reconnect', () => {
  it('leaves home resolution to Rust even when a saved layout claims another cwd', async () => {
    const config = props(makePane({ projectId: null, homeDirectory: true, cwd: '/untrusted/saved/path', profileId: 'chosen-shell', startToken: 1 }));
    render(<TerminalPane {...config} projectAvailable={false} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ kind: 'shell', projectId: undefined,
      cwd: undefined, profileId: 'chosen-shell', sessionId: undefined, resumeId: undefined });
    expect(JSON.stringify(mocks.launch.mock.calls[0][0])).not.toContain('/untrusted/saved/path');
  });
  it('detaches and reattaches a projectless runtime without a second launch', async () => {
    const config = props(makePane({ projectId: null, cwd: '/trusted/home', runtimeId: 'runtime', state: 'running' }));
    const first = render(<TerminalPane {...config} projectAvailable={false} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    const firstLease = mocks.attach.mock.calls[0][2];
    first.unmount();
    expect(mocks.detach).toHaveBeenCalledWith('runtime', firstLease);
    render(<TerminalPane {...config} projectAvailable={false} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
    expect(mocks.attach.mock.calls[1][0]).toBe('runtime');
    expect(mocks.attach.mock.calls[1][2]).not.toBe(firstLease);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});

it('restarts a recovered legacy projectless shell in its broker-confirmed directory', async () => {
  const saved = emptyWorkspace();
  saved.panes.pane = makePane({ id: 'pane', projectId: 'removed-project', cwd: '/saved/old', homeDirectory: true });
  saved.tabs.push({ id: 'old', name: 'Old shell', projectId: 'removed-project', focusedPaneId: 'pane', layout: { kind: 'pane', paneId: 'pane' } });
  const recovered = reconcileRuntimes(saved, [{ ...info, paneId: 'pane', kind: 'shell', projectId: null,
    cwd: '/synthetic/confirmed-project', profileId: null, resumeId: null, state: 'exited' }]);
  expect(recovered.panes.pane.homeDirectory).toBe(false);
  const restored = restoreWorkspace(serializeWorkspace(recovered));
  render(<TerminalPane {...props({ ...restored.panes.pane, startToken: 1 })} projectAvailable={false} />);
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({ projectId: undefined, cwd: '/synthetic/confirmed-project' });
});


describe('live terminal palette updates', () => {
  it('updates every open pane, including hidden panes, without resetting, fitting, focusing or restarting', async () => {
    const first = props(makePane({ startToken: 1 }));
    const second = props(makePane({ id: 'second', startToken: 1 }));
    mocks.launch.mockImplementation(async (request) => ({ ...info, id: request.paneId, paneId: request.paneId }));
    const panes = (terminalTheme: string) => <>
      <TerminalPane {...first} settings={{ ...settings, terminalTheme }} />
      <TerminalPane {...second} settings={{ ...settings, terminalTheme }} visible={false} focused={false} />
    </>;
    const view = render(panes('classic'));
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const snapshots = { reset: mocks.reset.mock.calls.length, fit: mocks.fit.mock.calls.length, focus: mocks.focus.mock.calls.length };
    for (const id of ['rose-light', 'ocean-dark', 'classic']) {
      view.rerender(panes(id));
      const expected = id === 'classic' ? '#090909' : id === 'rose-light' ? '#fcf4f6' : '#0d1929';
      for (const options of mocks.options) expect(options.theme).toMatchObject({ background: expected });
    }
    expect(mocks.options).toHaveLength(2);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.disposed).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledTimes(snapshots.reset);
    expect(mocks.fit).toHaveBeenCalledTimes(snapshots.fit);
    expect(mocks.focus).toHaveBeenCalledTimes(snapshots.focus);
  });
});

it('renames a running pane without remount, stop, relaunch or input interruption', async () => {
  const pane = makePane({ startToken: 1 });
  const original = props(pane);
  const { rerender } = render(<TerminalPane {...original} />);
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
  completeSnapshot(mocks.launch.mock.calls[0][1]);
  const disposed = mocks.disposed.mock.calls.length;
  const stopped = mocks.stop.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '重新命名面板 Shell' }));
  fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'Named console' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存名稱' })));
  expect(original.onPatch).toHaveBeenCalledWith(pane.id, { title: 'Named console' });
  rerender(<TerminalPane {...original} pane={{ ...pane, title: 'Named console', state: 'running', runtimeId: 'runtime' }} />);
  expect(screen.getByRole('region', { name: 'Named console 終端面板' })).toBeInTheDocument();
  expect(mocks.launch).toHaveBeenCalledOnce();
  expect(mocks.disposed).toHaveBeenCalledTimes(disposed);
  expect(mocks.stop).toHaveBeenCalledTimes(stopped);
  await act(async () => mocks.input?.('echo still alive\r'));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('runtime', 'echo still alive\r'));
});


// Keep cancellation faithful: rerenders must not execute superseded focus effects.
function controlAnimationFrames() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => { frames.delete(frameId); });
  return () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(0));
  });
}

it('regression: opening rename on an unfocused running pane does not refocus xterm over the dialog', () => {
  const flushFrames = controlAnimationFrames();
  function Harness() {
    const [focused, setFocused] = useState(false);
    return <TerminalPane {...props(makePane({ state: 'running', runtimeId: 'runtime' }))} focused={focused} onFocus={() => setFocused(true)} />;
  }
  render(<Harness />);
  flushFrames();
  const rename = screen.getByRole('button', { name: '重新命名面板 Shell' });
  fireEvent.pointerDown(rename);
  fireEvent.click(rename);
  expect(screen.getByLabelText('顯示名稱')).toHaveFocus();
  mocks.termFocus.mockClear();
  flushFrames();
  expect(screen.getByLabelText('顯示名稱')).toHaveFocus();
});

it('regression: a starting pane becoming running does not take focus away from its rename dialog', () => {
  const flushFrames = controlAnimationFrames();
  const initial = props(makePane({ state: 'starting' }));
  const view = render(<TerminalPane {...initial} />);
  flushFrames();
  fireEvent.click(screen.getByRole('button', { name: '重新命名面板 Shell' }));
  expect(screen.getByLabelText('顯示名稱')).toHaveFocus();
  view.rerender(<TerminalPane {...initial} pane={{ ...initial.pane, state: 'running', runtimeId: 'runtime' }} />);
  flushFrames();
  expect(screen.getByLabelText('顯示名稱')).toHaveFocus();
});

it('does not steal focus from another control before a pending frame, but still focuses on normal workspace reveal', () => {
  const flushFrames = controlAnimationFrames();
  const pane = props(makePane({ state: 'running', runtimeId: 'runtime' }));
  const view = render(<><input aria-label="Outside search" /><TerminalPane {...pane} /></>);
  const search = screen.getByLabelText('Outside search'); search.focus();
  flushFrames();
  expect(search).toHaveFocus();
  view.rerender(<><input aria-label="Outside search" /><TerminalPane {...pane} visible={false} /></>);
  view.rerender(<><input aria-label="Outside search" /><TerminalPane {...pane} visible /></>);
  flushFrames();
  expect(screen.getByLabelText('Mock xterm input')).toHaveFocus();
});

it('preserves rename opener focus when its pending terminal frame runs after the dialog already closed', () => {
  const flushFrames = controlAnimationFrames();
  const pane = props(makePane({ state: 'starting' }));
  const view = render(<TerminalPane {...pane} />);
  flushFrames();
  const opener = screen.getByRole('button', { name: '重新命名面板 Shell' });
  fireEvent.click(opener);
  view.rerender(<TerminalPane {...pane} pane={{ ...pane.pane, state: 'running' }} />);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(opener).toHaveFocus();
  flushFrames();
  expect(opener).toHaveFocus();
});

describe('real plugin asynchronous confirmation safety', () => {
  function running() { return props(makePane({ state: 'running', runtimeId: 'runtime' })); }
  function clipboard(text = 'unsafe command\n') {
    const readText = vi.fn().mockResolvedValue(text);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    return readText;
  }
  it.each(['Cancel', 'rejection'])('never pastes multiline clipboard text after native %s', async (result) => {
    clipboard();
    installNativeConfirmation(result === 'Cancel' ? vi.fn().mockResolvedValue('Cancel') : vi.fn().mockRejectedValue(new Error('Denied')));
    const view = render(<TerminalPane {...running()} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '貼上' })));
    expect(mocks.termPaste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '貼上' })).toBeEnabled();
  });
  it.each(['Cancel', 'rejection'])('never stops a runtime after native %s', async (result) => {
    installNativeConfirmation(result === 'Cancel' ? vi.fn().mockResolvedValue('Cancel') : vi.fn().mockRejectedValue(new Error('Denied')));
    const view = render(<TerminalPane {...running()} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '停止' })));
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '停止' })).toBeEnabled();
  });
  it('allows native Ok to paste once and to stop only the captured runtime', async () => {
    clipboard();
    installNativeConfirmation(vi.fn().mockResolvedValue('Ok'));
    const view = render(<TerminalPane {...running()} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '貼上' })));
    expect(mocks.termPaste).toHaveBeenCalledExactlyOnceWith('unsafe command\n');
    await act(async () => fireEvent.click(view.getByRole('button', { name: '停止' })));
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith('runtime');
  });
  it('prevents repeated clicks and concurrent paste/stop while native confirmation is pending', async () => {
    const read = clipboard();
    let finish!: (value: string) => void;
    const invoke = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    installNativeConfirmation(invoke);
    const view = render(<TerminalPane {...running()} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: '貼上' }));
      fireEvent.click(view.getByRole('button', { name: '貼上' }));
      fireEvent.click(view.getByRole('button', { name: '停止' }));
    });
    expect(read).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(view.getByRole('button', { name: '貼上' })).toBeDisabled();
    expect(view.getByRole('button', { name: '停止' })).toBeDisabled();
    await act(async () => finish('Ok'));
    expect(mocks.termPaste).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it.each(['restart', 'hide', 'hide-and-show', 'refocus', 'exit', 'unmount'] as const)('discards a confirmed paste after %s', async (change) => {
    clipboard();
    let finish!: (value: string) => void;
    installNativeConfirmation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const p = running();
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '貼上' })));
    if (change === 'restart') {
      mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
      view.rerender(<TerminalPane {...p} pane={makePane({ state: 'running', runtimeId: 'new-runtime', startToken: 1 })} />);
    } else if (change === 'hide' || change === 'hide-and-show') {
      view.rerender(<TerminalPane {...p} visible={false} />);
      if (change === 'hide-and-show') view.rerender(<TerminalPane {...p} visible />);
    } else if (change === 'refocus') {
      view.rerender(<TerminalPane {...p} focused={false} />);
      view.rerender(<TerminalPane {...p} focused />);
    } else if (change === 'exit') view.rerender(<TerminalPane {...p} pane={{ ...p.pane, state: 'exited' }} />);
    else view.unmount();
    await act(async () => finish('Ok'));
    expect(mocks.termPaste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['restart', 'hide-and-show', 'refocus', 'exit', 'unmount'] as const)('does not stop from an obsolete confirmation after %s', async (change) => {
    let finish!: (value: string) => void;
    installNativeConfirmation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const p = running();
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '停止' })));
    if (change === 'restart') {
      mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
      view.rerender(<TerminalPane {...p} pane={makePane({ state: 'running', runtimeId: 'new-runtime', startToken: 1 })} />);
    } else if (change === 'hide-and-show') {
      view.rerender(<TerminalPane {...p} visible={false} />);
      view.rerender(<TerminalPane {...p} visible />);
    } else if (change === 'refocus') {
      view.rerender(<TerminalPane {...p} focused={false} />);
      view.rerender(<TerminalPane {...p} focused />);
    } else if (change === 'exit') view.rerender(<TerminalPane {...p} pane={{ ...p.pane, state: 'exited' }} />);
    else view.unmount();
    // Baseline pane cleanup has its own stop; the pending confirmation must add no call.
    mocks.stop.mockClear();
    await act(async () => finish('Ok'));
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('revalidates the target after clipboard read, before showing any confirmation', async () => {
    let finish!: (value: string) => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => new Promise<string>((resolve) => { finish = resolve; }),
    } });
    const invoke = vi.fn().mockResolvedValue('Ok');
    installNativeConfirmation(invoke);
    const p = running();
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    fireEvent.click(view.getByRole('button', { name: '貼上' }));
    view.rerender(<TerminalPane {...p} visible={false} />);
    await act(async () => finish('unsafe command\n'));
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
});
describe('live terminal font sizing', () => {
  it('fits and resizes visible panes, updates hidden panes, and retains runtime input and output', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    try {
      const first = props(makePane({ startToken: 1 }));
      const second = props(makePane({ id: 'second', startToken: 1 }));
      mocks.launch.mockImplementation(async (request) => ({ ...info, id: request.paneId, paneId: request.paneId }));
      const panes = (fontSize: number, showSecond = false) => <>
        <TerminalPane {...first} settings={{ ...settings, fontSize }} />
        <TerminalPane {...second} settings={{ ...settings, fontSize }} visible={showSecond} focused={false} />
      </>;
      const view = render(panes(14));
      await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      for (const [request, channel] of mocks.launch.mock.calls) completeSnapshot(channel, request.paneId);
      await act(async () => { await Promise.resolve(); });
      const baseline = { fit: mocks.fit.mock.calls.length, reset: mocks.reset.mock.calls.length, focus: mocks.focus.mock.calls.length };
      view.rerender(panes(20));
      expect(mocks.options.map((options) => options.fontSize)).toEqual([20, 20]);
      expect(mocks.fit).toHaveBeenCalledTimes(baseline.fit + 1);
      expect(mocks.resize).toHaveBeenCalledWith('pane', 80, 24);
      expect(mocks.focus).toHaveBeenCalledTimes(baseline.focus);
      view.rerender(panes(20, true));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      expect(mocks.resize).toHaveBeenCalledWith('second', 80, 24);
      const event = mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void;
      act(() => event({ type: 'output', runtimeId: 'pane', sequence: 1, data: [111, 107] }));
      expect(mocks.termWrite).toHaveBeenCalledWith(new Uint8Array([111, 107]), expect.any(Function));
      act(() => mocks.input?.('still typing'));
      await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('second', 'still typing'));
      expect(mocks.launch).toHaveBeenCalledTimes(2); expect(mocks.options).toHaveLength(2);
      expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.disposed).not.toHaveBeenCalled();
      expect(mocks.reset).toHaveBeenCalledTimes(baseline.reset);
    } finally { width.mockRestore(); height.mockRestore(); }
  });
});

it('refits after native page zoom without changing terminal font or runtime, and fits hidden panes on reveal', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  const p = props(makePane({ startToken: 1 }));
  const view = render(<TerminalPane {...p} />);
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
  // The broker must finish its snapshot before the renderer may fit or accept input.
  completeSnapshot(mocks.launch.mock.calls[0][1]);
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
  mocks.fit.mockClear(); mocks.resize.mockClear(); mocks.focus.mockClear();
  const resets = mocks.reset.mock.calls.length;
  act(() => window.dispatchEvent(new Event(workspaceZoomEvent)));
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
  expect(mocks.fit).toHaveBeenCalledOnce(); expect(mocks.resize).toHaveBeenCalledWith('runtime', 80, 24);
  expect(mocks.options.at(-1)?.fontSize).toBe(13); expect(mocks.focus).not.toHaveBeenCalled();
  view.rerender(<TerminalPane {...p} visible={false} />);
  mocks.fit.mockClear(); mocks.resize.mockClear();
  act(() => window.dispatchEvent(new Event(workspaceZoomEvent)));
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
  expect(mocks.fit).not.toHaveBeenCalled(); expect(mocks.resize).not.toHaveBeenCalled();
  view.rerender(<TerminalPane {...p} visible />);
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
  expect(mocks.fit).toHaveBeenCalledOnce();
  act(() => mocks.input?.('still alive'));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('runtime', 'still alive'));
  expect(mocks.launch).toHaveBeenCalledOnce(); expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.disposed).not.toHaveBeenCalled();
  expect(mocks.reset).toHaveBeenCalledTimes(resets);
});
