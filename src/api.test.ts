import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { api } from './api';
import type { LaunchRequest } from './types';

const native = vi.hoisted(() => ({ channels: vi.fn() }));
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
  it.each(['grok', 'antigravity'] as const)('sends a %s preview request unchanged without creating an output channel or launching', async (kind) => {
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
