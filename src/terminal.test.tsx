import { defaultAgentOptions } from './agents';
import { shouldHandleTerminalKey } from './terminal-ime';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './components/TerminalPane';
import { installNativeConfirmation } from './test/dialog-init';
import type { Pane, RuntimeInfo, Settings, TerminalEvent } from './types';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  ack: vi.fn(),
  stop: vi.fn(),
  termWrite: vi.fn(),
  termPaste: vi.fn(),
  disposed: vi.fn(),
  keyHandler: vi.fn(),
  input: undefined as undefined | ((value: string) => void),
}));
vi.mock('./api', () => ({ errorMessage: (e: unknown) => String(e), api: mocks }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { mocks.keyHandler(handler); }
    open() {}
    reset() {}
    focus() {}
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
    fit() {}
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
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.launch.mockResolvedValue(info);
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
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 41);
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
    expect(mocks.ack).toHaveBeenCalledWith('runtime', 92);
    act(() => currentChannel({ type: 'exit', runtimeId: 'new-runtime', exitCode: 3 }));
    expect(p.onPatch).toHaveBeenCalledExactlyOnceWith('pane', { state: 'exited', exitCode: 3 });
  });
  it('stops an obsolete launch response without changing the latest runtime', async () => {
    let resolveOld!: (value: RuntimeInfo) => void;
    mocks.launch.mockImplementationOnce(() => new Promise<RuntimeInfo>((done) => { resolveOld = done; }));
    const p = props(makePane({ startToken: 1 }));
    const view = render(<TerminalPane {...p} />);
    mocks.launch.mockResolvedValueOnce({ ...info, id: 'new-runtime' });
    view.rerender(<TerminalPane {...p} pane={makePane({ startToken: 2 })} />);
    await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith('pane', expect.objectContaining({ runtimeId: 'new-runtime' })));
    p.onPatch.mockClear();
    await act(async () => resolveOld(info));
    expect(mocks.stop).toHaveBeenCalledWith('runtime');
    expect(p.onPatch).not.toHaveBeenCalled();
    await act(async () => { mocks.input?.('latest'); });
    expect(mocks.write).toHaveBeenCalledWith('new-runtime', 'latest');
  });
  it('stops a launch completed after its pane was removed', async () => {
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
    expect(mocks.stop).toHaveBeenCalledWith('runtime');
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
    }, expect.any(Function));
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
    await act(async () => fireEvent.click(view.getByRole('button', { name: '貼上' })));
    expect(mocks.termPaste).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '貼上' })).toBeEnabled();
  });
  it.each(['Cancel', 'rejection'])('never stops a runtime after native %s', async (result) => {
    installNativeConfirmation(result === 'Cancel' ? vi.fn().mockResolvedValue('Cancel') : vi.fn().mockRejectedValue(new Error('Denied')));
    const view = render(<TerminalPane {...running()} />);
    await act(async () => fireEvent.click(view.getByRole('button', { name: '停止' })));
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '停止' })).toBeEnabled();
  });
  it('allows native Ok to paste once and to stop only the captured runtime', async () => {
    clipboard();
    installNativeConfirmation(vi.fn().mockResolvedValue('Ok'));
    const view = render(<TerminalPane {...running()} />);
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
    fireEvent.click(view.getByRole('button', { name: '貼上' }));
    view.rerender(<TerminalPane {...p} visible={false} />);
    await act(async () => finish('unsafe command\n'));
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.termPaste).not.toHaveBeenCalled();
  });
});
