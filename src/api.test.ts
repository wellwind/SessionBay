import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { api } from './api';
import type { LaunchRequest } from './types';

const native = vi.hoisted(() => ({ channels: vi.fn(), setZoom: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ setZoom: native.setZoom }) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  Channel: class {
    constructor() { native.channels(); }
    onmessage = () => {};
  },
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
});

describe('launch preview IPC contract', () => {
  it.each(['grok', 'antigravity', 'opencode'] as const)('sends a %s preview request unchanged without creating an output channel or launching', async (kind) => {
    vi.mocked(isTauri).mockReturnValue(true);
    const request: LaunchRequest = {
      paneId: 'synthetic-preview', kind, projectId: 'synthetic-project',
      cwd: '/synthetic/work tree; $(not-run)', resumeId: 'synthetic-conversation',
      cols: 80, rows: 24,
    };
    const preview = {
      executable: kind === 'grok' ? '/synthetic/grok' : '/synthetic/agy',
      args: [kind === 'grok' ? '--resume' : '--conversation', request.resumeId!, '--model', 'literal model'],
      cwd: request.cwd,
    };
    vi.mocked(invoke).mockResolvedValue(preview);
    await expect(api.preview(request)).resolves.toEqual(preview);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('preview_launch', { request });
    expect(native.channels).not.toHaveBeenCalled();
  });
  it('rejects a preview in a disconnected browser before native IPC is invoked', async () => {
    await expect(api.preview({ paneId: 'preview', kind: 'grok', cwd: '/synthetic/project', cols: 80, rows: 24 }))
      .rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
    expect(native.channels).not.toHaveBeenCalled();
  });
});

describe('fresh Agent launch IPC contract', () => {
  it('returns the backend pane identity without creating an output channel or legacy launch', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const request: LaunchRequest = { paneId: 'launch-intent', kind: 'codex',
      projectId: 'synthetic-project', cwd: '/synthetic/project', cols: 80, rows: 24 };
    const info = { id: 'backend-runtime', paneId: 'backend-pane', sessionId: null,
      state: 'running', cwd: '/canonical/project', exitCode: null };
    vi.mocked(invoke).mockResolvedValue(info);
    await expect(api.launchFresh(request)).resolves.toEqual(info);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('launch_fresh_runtime', { request });
    expect(native.channels).not.toHaveBeenCalled();
  });

  it('uses separate explicit confirmation and cancellation commands without rewriting the request', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const request: LaunchRequest = { paneId: 'original-intent', kind: 'claude', cols: 80, rows: 24 };
    await api.launchFreshWithoutHooks(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('launch_fresh_without_hooks', { request });
    vi.mocked(invoke).mockClear();
    await api.cancelFresh(request.paneId);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('cancel_fresh_launch', { intent: request.paneId });
    expect(native.channels).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain fresh launch response', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('response lost'));
    await expect(api.launchFresh({ paneId: 'intent', kind: 'claude', cols: 80, rows: 24 }))
      .rejects.toThrow('response lost');
    expect(invoke).toHaveBeenCalledOnce();
    expect(native.channels).not.toHaveBeenCalled();
  });
});


describe('shell discovery IPC contract', () => {
  it('reads shell candidates without creating a PTY or supplying configuration changes', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const candidates = [{ name: 'Zsh', executable: '/synthetic/zsh' }];
    vi.mocked(invoke).mockResolvedValue(candidates);
    await expect(api.detectShells()).resolves.toEqual(candidates);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('detect_shells', undefined);
    expect(native.channels).not.toHaveBeenCalled();
  });
  it('requires the desktop environment for shell discovery', async () => {
    await expect(api.detectShells()).rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('history source discovery IPC contract', () => {
  it.each(['codex', 'claude', 'grok', 'antigravity', 'opencode'] as const)('passes only the %s registry ID without launching or mutating settings', async (kind) => {
    vi.mocked(isTauri).mockReturnValue(true);
    const result = { kind, supported: kind !== 'antigravity', candidates: [], message: null };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(api.detectHistorySources(kind)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('detect_history_sources', { kind });
    expect(native.channels).not.toHaveBeenCalled();
  });
  it('does not call native discovery in browser preview', async () => {
    await expect(api.detectHistorySources('grok')).rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('persistent attachment IPC contract', () => {
  it('passes the attachment lease on attach, ACK and detach while keeping explicit stop separate', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const listener = vi.fn();
    await api.attach('runtime', listener, 'lease');
    const channel = (vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>).onEvent as { onmessage: (value: unknown) => void };
    expect(invoke).toHaveBeenCalledWith('attach_runtime', { runtimeId: 'runtime', attachmentId: 'lease', onEvent: channel });
    const event = { type: 'snapshot', runtimeId: 'runtime', sequence: 0, data: [], cols: 80, rows: 24, truncated: false };
    channel.onmessage(event);
    expect(listener).toHaveBeenCalledWith(event);
    await api.ack('runtime', 0, 'lease');
    await api.detach('runtime', 'lease');
    await api.forget('runtime');
    expect(invoke).toHaveBeenCalledWith('ack_runtime', { runtimeId: 'runtime', sequence: 0, attachmentId: 'lease' });
    expect(invoke).toHaveBeenCalledWith('detach_runtime', { runtimeId: 'runtime', attachmentId: 'lease' });
    expect(invoke).toHaveBeenCalledWith('forget_runtime', { runtimeId: 'runtime' });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'stop_runtime' || command === 'launch_runtime')).toBe(false);
  });
});

it('settles only the requested panes before explicit close, including failed launches', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  let fail!: (reason: Error) => void;
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
  const one = api.launch({ paneId: 'closing', kind: 'shell', cols: 80, rows: 24 }, () => {}, 'lease-one');
  const two = api.launch({ paneId: 'other', kind: 'shell', cols: 80, rows: 24 }, () => {}, 'lease-two');
  const failed = one.catch(() => undefined);
  let settled = false;
  const waiting = api.settleLaunches(['closing']).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  fail(new Error('launch status uncertain'));
  await waiting;
  await failed;
  expect(settled).toBe(true);
  finish();
  await two;
  await api.settleLaunches(['closing', 'other']);
});

describe('native zoom API', () => {
  it('uses the current WebView page zoom factor without changing runtime IPC', async () => {
    vi.mocked(isTauri).mockReturnValue(true); native.setZoom.mockResolvedValue(undefined);
    await api.setWorkspaceZoom(150);
    expect(native.setZoom).toHaveBeenCalledWith(1.5); expect(invoke).not.toHaveBeenCalled();
  });
  it('does not claim a browser-only preview changed native zoom', async () => {
    await expect(api.setWorkspaceZoom(150)).rejects.toThrow('桌面');
    expect(native.setZoom).not.toHaveBeenCalled();
  });
});

describe('workspace filename search IPC contract', () => {
  it('passes only project identity and query and preserves truncation', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const result = { paths: ['unloaded/nested/file.ts'], truncated: true };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(api.searchWorkspaceFiles('project-id', 'nested/file')).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('search_workspace_files', {
      projectId: 'project-id', query: 'nested/file',
    });
  });
  it('does not try native search without a desktop connection', async () => {
    await expect(api.searchWorkspaceFiles('project-id', 'needle')).rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('Kanban IPC contract', () => {
  const cases: [string, () => Promise<unknown>, Record<string, unknown> | undefined][] = [
    ['kanban_board', () => api.kanbanBoard('project'), { projectId: 'project' }],
    ['list_kanban_boards', () => api.listKanbanBoards(), undefined],
    ['set_kanban_board_enabled', () => api.setKanbanBoardEnabled('project', false), { projectId: 'project', enabled: false }],
    ['create_kanban_column', () => api.createKanbanColumn('project', 'Blocked', undefined), { projectId: 'project', name: 'Blocked', stage: undefined }],
    ['rename_kanban_column', () => api.renameKanbanColumn('column', 'Inbox'), { columnId: 'column', name: 'Inbox' }],
    ['set_kanban_column_stage', () => api.setKanbanColumnStage('column', 'review'), { columnId: 'column', stage: 'review' }],
    ['reorder_kanban_columns', () => api.reorderKanbanColumns('project', ['b', 'a']), { projectId: 'project', columnIds: ['b', 'a'] }],
    ['delete_kanban_column', () => api.deleteKanbanColumn('column', 'target'), { columnId: 'column', targetColumnId: 'target' }],
    ['create_kanban_card', () => api.createKanbanCard('column', '', 'Draft'), { columnId: 'column', title: '', notes: 'Draft' }],
    ['edit_kanban_card', () => api.editKanbanCard('card', 'Plan', 'Notes'), { cardId: 'card', title: 'Plan', notes: 'Notes' }],
    ['move_kanban_card', () => api.moveKanbanCard('card', 'column', 0), { cardId: 'card', columnId: 'column', position: 0 }],
    ['archive_kanban_card', () => api.archiveKanbanCard('card', false), { cardId: 'card', archived: false }],
    ['delete_kanban_card', () => api.deleteKanbanCard('card', 'unsorted'), { cardId: 'card', sessions: 'unsorted' }],
    ['attach_kanban_session', () => api.attachKanbanSession('card', 'session'), { cardId: 'card', sessionId: 'session' }],
    ['detach_kanban_session', () => api.detachKanbanSession('card', 'session'), { cardId: 'card', sessionId: 'session' }],
    ['merge_kanban_cards', () => api.mergeKanbanCards('source', 'target'), { sourceCardId: 'source', targetCardId: 'target' }],
    ['split_kanban_session', () => api.splitKanbanSession('card', 'session'), { cardId: 'card', sessionId: 'session' }],
    ['add_kanban_session', () => api.addKanbanSession('session'), { sessionId: 'session' }],
    ['kanban_session_card', () => api.kanbanSessionCard('session'), { sessionId: 'session' }],
  ];
  it.each(cases)('calls %s with camelCase arguments and returns the native result', async (command, run, args) => {
    vi.mocked(isTauri).mockReturnValue(true);
    const result = { synthetic: command };
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(run()).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, args);
    expect(native.channels).not.toHaveBeenCalled();
  });
  it('requires a desktop connection before mutating a board', async () => {
    await expect(api.createKanbanCard('column', 'Task', '')).rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
  });
});
