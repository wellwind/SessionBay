import userEvent from '@testing-library/user-event';
import { installNativeConfirmation } from './test/dialog-init';
import { defaultAgentOptions } from './agents';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './components/TerminalPane';
import type { Pane, RuntimeInfo, Settings, TerminalEvent } from './types';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  termReset: vi.fn(),
  termResize: vi.fn(),
  termPaste: vi.fn(),
  termFocus: vi.fn(),
  fit: vi.fn(),
  initialCols: 80,
  initialRows: 24,
  write: vi.fn(),
  resize: vi.fn(),
  ack: vi.fn(),
  stop: vi.fn(),
  termWrite: vi.fn(),
  disposed: vi.fn(),
  keyHandler: vi.fn(),
  input: undefined as undefined | ((value: string) => void),
}));
vi.mock('./api', () => ({ errorMessage: (e: unknown) => String(e), api: mocks }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = mocks.initialCols;
    rows = mocks.initialRows;
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { mocks.keyHandler(handler); }
    textarea?: HTMLTextAreaElement;
    open(host: HTMLElement) {
      this.textarea = document.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      host.append(this.textarea);
    }
    reset() { mocks.termReset(); }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; mocks.termResize(cols, rows); }
    focus() { mocks.termFocus(); this.textarea?.focus(); }
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
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy' },
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
    expect(mocks.keyHandler).toHaveBeenCalledTimes(1);
    expect(mocks.keyHandler.mock.calls[0][0](new KeyboardEvent('keydown', { key: 'CapsLock' }))).toBe(false);
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
  it.each(['grok', 'antigravity'] as const)('never launches a restored %s conversation without an explicit start token', (kind) => {
    render(<TerminalPane {...props(makePane({ kind, resumeId: 'synthetic-conversation' }))} />);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it.each(['grok', 'antigravity'] as const)('passes the %s manual ID as a separate launch field after explicit start', async (kind) => {
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
    fireEvent.click(view.getByRole('button', { name: /重新/ }));
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


describe('local multiline draft editor', () => {
  async function ready() {
    const p = props(makePane({ startToken: 1, state: 'running' }));
    const view = render(<TerminalPane {...p} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    completeSnapshot(mocks.launch.mock.calls[0][1]);
    return { p, view, channel: mocks.launch.mock.calls[0][1] as (event: TerminalEvent) => void };
  }
  function shiftEnter(init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey: true, cancelable: true, ...init });
    let handled = true;
    act(() => { handled = mocks.keyHandler.mock.calls[0][0](event); });
    return { event, handled };
  }
  it('opens locally, preserves a cancelled draft, and never sends Enter/Ctrl+Enter/Shift+Enter from the editor', async () => {
    const { view } = await ready();
    expect(shiftEnter().handled).toBe(false);
    const editor = view.getByLabelText('草稿內容');
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: 'one\n中文\n' } });
    for (const init of [{}, { shiftKey: true }, { ctrlKey: true }]) fireEvent.keyDown(editor, { key: 'Enter', ...init });
    expect(mocks.termPaste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('取消並保留草稿'));
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    shiftEnter();
    expect(view.getByLabelText('草稿內容')).toHaveValue('one\n中文\n');
  });
  it('leaves IME confirmation, repeat, other modifiers, and another dialog alone', async () => {
    const { view } = await ready();
    const host = view.container.querySelector('.xterm-host')!;
    fireEvent.compositionStart(host);
    expect(shiftEnter().handled).toBe(true);
    fireEvent.compositionEnd(host);
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])
      expect(shiftEnter(init).handled).toBe(true);
    expect(shiftEnter({ repeat: true }).handled).toBe(false);
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    const other = document.createElement('div'); other.setAttribute('role', 'dialog'); other.setAttribute('aria-modal', 'true'); document.body.append(other);
    expect(shiftEnter().handled).toBe(false);
    other.remove();
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
  it('requires explicit target-labelled confirmation and sends exactly the original draft through paste', async () => {
    const { view } = await ready();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: '  first\nsecond\n\n' } });
    fireEvent.click(view.getByText('確認貼上…'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Runtime：runtime'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('末尾有 2 個換行'));
    expect(mocks.termPaste).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByText('確認貼上…')).toBeEnabled());
    confirm.mockReturnValue(true);
    mocks.termPaste.mockImplementationOnce((text: string) => mocks.input?.(text));
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('已交給終端'));
    expect(mocks.termPaste).toHaveBeenCalledExactlyOnceWith('  first\nsecond\n\n');
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('runtime', '  first\nsecond\n\n');
    expect(view.getByLabelText('草稿內容')).toHaveValue('  first\nsecond\n\n');
  });
  it.each(['exit', 'disconnected'] as const)('keeps text and prevents paste when the target reports %s', async (type) => {
    const { view, channel } = await ready();
    shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'keep me' } });
    act(() => channel(type === 'exit' ? { type, runtimeId: 'runtime', exitCode: 0 } : { type, runtimeId: 'runtime', message: 'disconnected' }));
    expect(view.getByText('確認貼上…')).toBeDisabled();
    fireEvent.click(view.getByText('取消並保留草稿'));
    fireEvent.click(view.getByRole('button', { name: '多行草稿' }));
    expect(view.getByLabelText('草稿內容')).toHaveValue('keep me');
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
  it('rechecks the attachment after confirmation, even if the same pane was restarted', async () => {
    const { p, view } = await ready();
    shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'old draft' } });
    vi.spyOn(window, 'confirm').mockImplementation(() => {
      view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2, state: 'running' })} />);
      return true;
    });
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByLabelText('草稿內容')).not.toHaveAttribute('readonly'));
    expect(mocks.termPaste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(view.getByLabelText('草稿內容')).toHaveValue('old draft');
  });
  it.each(['hidden', 'unfocused'] as const)('closes the editor on %s navigation without sending or losing text', async (change) => {
    const { p, view } = await ready();
    shiftEnter(); fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'private to this pane' } });
    view.rerender(<TerminalPane {...p} visible={change !== 'hidden'} focused={change !== 'unfocused'} />);
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<TerminalPane {...p} />); shiftEnter();
    expect(view.getByLabelText('草稿內容')).toHaveValue('private to this pane');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('retains text on IPC failure, reports uncertain delivery, and never retries automatically', async () => {
    const { view } = await ready();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.write.mockRejectedValueOnce(new Error('fixture write failure'));
    mocks.termPaste.mockImplementationOnce((text: string) => mocks.input?.(text));
    shiftEnter(); fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'keep on failure' } });
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('無法確認貼上是否完整送達'));
    expect(view.getByLabelText('草稿內容')).toHaveValue('keep on failure');
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it('does not close for IME Escape but ordinary Escape cancels', async () => {
    const { view } = await ready(); shiftEnter();
    const editor = view.getByLabelText('草稿內容');
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(view.getByRole('dialog')).toBeInTheDocument();
    fireEvent.compositionEnd(editor); fireEvent.keyDown(editor, { key: 'Escape' });
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('never lets a delayed animation frame or snapshot steal focus from the draft', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const { p, view, channel } = await ready();
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 1, state: 'starting' })} />);
    shiftEnter();
    const editor = view.getByLabelText('草稿內容');
    expect(editor).toHaveFocus();
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 1, state: 'running' })} />);
    act(() => { for (const frame of frames.splice(0)) frame(0); });
    completeSnapshot(channel);
    expect(editor).toHaveFocus();
    expect(mocks.termFocus).not.toHaveBeenCalled();
    const handler = mocks.keyHandler.mock.calls[0][0];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new KeyboardEvent(type, { key: 'Enter', cancelable: true });
      expect(handler(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('does not steal focus from a newer ordinary control when a frame runs', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    await ready();
    const input = document.createElement('input'); document.body.append(input); input.focus();
    act(() => { for (const frame of frames) frame(0); });
    expect(input).toHaveFocus(); expect(mocks.termFocus).not.toHaveBeenCalled(); input.remove();
  });
  it('does not paste a pending clipboard read over a newly opened draft', async () => {
    const { view } = await ready();
    let resolve!: (text: string) => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => new Promise<string>((done) => { resolve = done; }),
    } });
    fireEvent.click(view.getByRole('button', { name: '貼上' })); shiftEnter();
    await act(async () => resolve('late clipboard'));
    expect(view.getByLabelText('草稿內容')).toHaveFocus();
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
  it('requires explicitly replacing an old draft after reconnecting the same runtime ID', async () => {
    const { p, view, channel } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'old lease draft' } });
    act(() => channel({ type: 'disconnected', runtimeId: 'runtime', message: 'fixture disconnect' }));
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 1, state: 'disconnected', runtimeId: 'runtime' })} />);
    fireEvent.click(view.getByText('取消並保留草稿'));
    fireEvent.click(view.getByText('重新連線'));
    await waitFor(() => expect(mocks.attach).toHaveBeenCalled());
    completeSnapshot(mocks.attach.mock.calls[0][1]);
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 1, state: 'running', runtimeId: 'runtime' })} />);
    fireEvent.click(view.getByRole('button', { name: '多行草稿' }));
    expect(view.getByLabelText('草稿內容')).toHaveValue('old lease draft');
    expect(view.getByText('確認貼上…')).toBeDisabled();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(view.getByText('另開目前終端草稿'));
    expect(view.getByLabelText('草稿內容')).toHaveValue('old lease draft');
    await waitFor(() => expect(view.getByText('另開目前終端草稿')).toBeEnabled());
    confirm.mockReturnValue(true); fireEvent.click(view.getByText('另開目前終端草稿'));
    await waitFor(() => expect(view.getByLabelText('草稿內容')).toHaveValue(''));
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'new lease' } });
    expect(view.getByText('確認貼上…')).toBeEnabled();
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
  it('prevents repeated paste while delivery is pending and keeps a synchronous failure recoverable', async () => {
    const { view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'once' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    mocks.termPaste.mockImplementationOnce((text: string) => mocks.input?.(text));
    fireEvent.click(view.getByText('確認貼上…')); fireEvent.click(view.getByText('正在貼上…'));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    mocks.termPaste.mockImplementationOnce(() => { throw new Error('fixture paste failure'); });
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('fixture paste failure'));
    expect(view.getByLabelText('草稿內容')).toHaveValue('once');
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it('inserts real textarea newlines with Enter and Shift+Enter without terminal input', async () => {
    const { view } = await ready(); shiftEnter();
    const editor = view.getByLabelText('草稿內容');
    await userEvent.type(editor, 'one{Enter}two{Shift>}{Enter}{/Shift}three');
    expect(editor).toHaveValue('one\ntwo\nthree');
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.termPaste).not.toHaveBeenCalled();
  });
  it('keeps keyboard focus inside the dialog and restores the actual terminal textarea on cancel', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
    const { view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'text' } });
    const paste = view.getByText('確認貼上…'); paste.focus();
    fireEvent.keyDown(paste, { key: 'Tab' });
    expect(view.getByLabelText('關閉對話框')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(paste).toHaveFocus();
    fireEvent.click(view.getByText('取消並保留草稿'));
    expect(view.container.querySelector('.xterm-helper-textarea')).toHaveFocus();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('never retargets a draft when a component receives a different pane identity', async () => {
    const { p, view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'original pane' } });
    view.rerender(<TerminalPane {...p} pane={makePane({ id: 'other-pane', startToken: 1, state: 'running', runtimeId: 'runtime' })} />);
    expect(view.getByText('確認貼上…')).toBeDisabled();
    expect(view.getByLabelText('草稿內容')).toHaveValue('original pane');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'reject', 'invalid'] as const)('fails closed for native async confirmation %s', async (outcome) => {
    const { view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'unsafe command\n' } });
    // tauri-plugin-dialog overrides the browser boolean signature with a Promise.
    vi.spyOn(window, 'confirm').mockImplementation(() => (outcome === 'reject'
      ? Promise.reject(new Error('fixture permission denied'))
      : Promise.resolve(outcome === 'cancel' ? false : 'true')) as unknown as boolean);
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByText('確認貼上…')).toBeEnabled());
    expect(view.getByLabelText('草稿內容')).toHaveValue('unsafe command\n');
    expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('waits for native async true and prevents repeated pending confirmations', async () => {
    const { view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'exact\n' } });
    let resolve!: (value: boolean) => void;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(new Promise<boolean>((done) => { resolve = done; }) as unknown as boolean);
    fireEvent.click(view.getByText('確認貼上…')); fireEvent.click(view.getByText('正在貼上…'));
    expect(view.getByLabelText('草稿內容')).toHaveAttribute('readonly');
    expect(confirm).toHaveBeenCalledTimes(1); expect(mocks.termPaste).not.toHaveBeenCalled();
    await act(async () => resolve(true));
    expect(mocks.termPaste).toHaveBeenCalledExactlyOnceWith('exact\n');
  });
  it.each(['cancel', 'reopen', 'hidden', 'unfocused', 'edit', 'restart', 'exit', 'disconnected', 'unmount'] as const)(
    'invalidates pending native paste confirmation after %s', async (change) => {
      const { p, view, channel } = await ready(); shiftEnter();
      fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'old text\n' } });
      let resolve!: (value: boolean) => void;
      vi.spyOn(window, 'confirm').mockReturnValue(new Promise<boolean>((done) => { resolve = done; }) as unknown as boolean);
      fireEvent.click(view.getByText('確認貼上…'));
      if (change === 'cancel' || change === 'reopen') {
        fireEvent.click(view.getByText('取消並保留草稿'));
        if (change === 'reopen') shiftEnter();
      } else if (change === 'hidden' || change === 'unfocused') {
        view.rerender(<TerminalPane {...p} visible={change !== 'hidden'} focused={change !== 'unfocused'} />);
        view.rerender(<TerminalPane {...p} />); shiftEnter();
      } else if (change === 'edit') {
        // Even a programmatic change while readonly must invalidate the captured text.
        fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'new text' } });
      } else if (change === 'restart') {
        view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2, state: 'running' })} />);
      } else if (change === 'unmount') view.unmount();
      else act(() => channel(change === 'exit' ? { type: 'exit', runtimeId: 'runtime', exitCode: 0 }
        : { type: 'disconnected', runtimeId: 'runtime', message: 'fixture disconnected' }));
      await act(async () => resolve(true));
      expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
      if (change === 'edit') expect(view.getByLabelText('草稿內容')).toHaveValue('new text');
    },
  );
  it.each(['cancel', 'reject', 'edit', 'close', 'restart'] as const)('preserves the old draft when async replacement is invalidated by %s', async (change) => {
    const { p, view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'old lease draft' } });
    const replacementPane = makePane({ startToken: 2, state: 'running' });
    view.rerender(<TerminalPane {...p} pane={replacementPane} />);
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2));
    completeSnapshot(mocks.launch.mock.calls[1][1]);
    let resolve!: (value: boolean) => void; let reject!: (error: Error) => void;
    vi.spyOn(window, 'confirm').mockReturnValue(new Promise<boolean>((done, fail) => { resolve = done; reject = fail; }) as unknown as boolean);
    fireEvent.click(view.getByText('另開目前終端草稿'));
    if (change === 'edit') fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'new retained text' } });
    if (change === 'close') fireEvent.click(view.getByText('取消並保留草稿'));
    if (change === 'restart') view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 3, state: 'running' })} />);
    await act(async () => { if (change === 'reject') reject(new Error('fixture denied')); else resolve(change !== 'cancel'); });
    if (change === 'close') shiftEnter();
    expect(view.getByLabelText('草稿內容')).toHaveValue(change === 'edit' ? 'new retained text' : 'old lease draft');
    expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each(['Cancel', 'Ok', 'denied'] as const)('honors the actual native plugin %s response for draft paste', async (button) => {
    const { view } = await ready(); shiftEnter();
    fireEvent.change(view.getByLabelText('草稿內容'), { target: { value: 'original\n' } });
    const invoke = button === 'denied' ? vi.fn().mockRejectedValue(new Error('permission denied')) : vi.fn().mockResolvedValue(button);
    installNativeConfirmation(invoke);
    fireEvent.click(view.getByText('確認貼上…'));
    await waitFor(() => expect(view.getByText('確認貼上…')).toBeEnabled());
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|message', expect.objectContaining({ buttons: 'OkCancel' }), undefined);
    if (button === 'Ok') expect(mocks.termPaste).toHaveBeenCalledExactlyOnceWith('original\n');
    else { expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); }
  });
  it.each(['clipboard', 'stop'] as const)('awaits native Cancel and denial for the original %s action', async (action) => {
    const { view } = await ready();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue('one\ntwo') } });
    const button = view.getByRole('button', { name: action === 'clipboard' ? '貼上' : '停止' });
    const invoke = vi.fn().mockResolvedValue('Cancel'); installNativeConfirmation(invoke);
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error('permission denied')); fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce('Ok'); fireEvent.click(button);
    await waitFor(() => expect(action === 'clipboard' ? mocks.termPaste : mocks.stop).toHaveBeenCalledOnce());
  });
  it.each(['clipboard', 'stop'] as const)('invalidates original %s confirmation when a draft opens and closes', async (action) => {
    const { view } = await ready();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn().mockResolvedValue('one\ntwo') } });
    let resolve!: (button: string) => void;
    const invoke = vi.fn(() => new Promise<string>((done) => { resolve = done; })); installNativeConfirmation(invoke);
    fireEvent.click(view.getByRole('button', { name: action === 'clipboard' ? '貼上' : '停止' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    shiftEnter(); fireEvent.click(view.getByText('取消並保留草稿'));
    await act(async () => resolve('Ok'));
    expect(mocks.termPaste).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
  });

});
