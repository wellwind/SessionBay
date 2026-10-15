import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './components/TerminalPane';
import type { Pane, RuntimeInfo, Settings, TerminalEvent } from './types';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  ack: vi.fn(),
  stop: vi.fn(),
  termWrite: vi.fn(),
  disposed: vi.fn(),
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
    open() {}
    reset() {}
    focus() {}
    getSelection() {
      return '';
    }
    paste() {}
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
  executables: { codex: 'codex', claude: 'claude' },
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
