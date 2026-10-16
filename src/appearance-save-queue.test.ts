import { describe, expect, it, vi } from 'vitest';
import { AppearanceSaveQueue } from './appearance-save-queue';
import { defaultAgentOptions } from './agents';
import { shortcutDefaults } from './commands';
import type { Settings } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let settings: Settings = {
    version: 1, theme: 'dark', terminalTheme: 'classic', fontFamily: 'monospace', fontSize: 14, appZoom: 100,
    defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [{ id: 'shell', name: 'Shell', executable: '/bin/sh', args: [], env: {} }],
    sources: [], executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
    agentOptions: defaultAgentOptions(), shortcuts: { ...shortcutDefaults }, onboardingComplete: true,
  };
  const save = vi.fn(async (next: Settings) => next);
  const beforeSave = vi.fn<(_: Partial<Settings>) => void | Promise<void>>(() => undefined);
  const busy = vi.fn();
  const queue = new AppearanceSaveQueue({ getSettings: () => settings, save, beforeSave, busy,
    committed: patch => { settings = { ...settings, ...patch }; } });
  return { queue, save, beforeSave, busy, saved: () => settings, external: (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; } };
}
describe('shared appearance save queue', () => {
  it('coalesces narrow queued fields while returning a truthful result to each caller', async () => {
    const h = harness(); const disk = deferred<Settings>();
    h.save.mockImplementationOnce(() => disk.promise);
    const first = h.queue.persist({ theme: 'light' });
    const superseded = h.queue.persist({ appZoom: 110 });
    const zoom = h.queue.persist({ appZoom: 130 });
    const palette = h.queue.persist({ themePalette: 'code-modern' });
    disk.resolve(h.save.mock.calls[0][0]);
    expect(await Promise.all([first, superseded, zoom, palette])).toEqual([true, false, true, true]);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.saved()).toMatchObject({ theme: 'light', appZoom: 130, themePalette: 'code-modern' });
    expect(h.beforeSave.mock.calls.map(([patch]) => patch)).toEqual([{ theme: 'light' }, { appZoom: 130, themePalette: 'code-modern' }]);
    expect(h.busy.mock.calls).toEqual([[true], [false]]);
  });
  it('rejects every affected caller on failure, commits nothing and supports retry', async () => {
    const h = harness(); const disk = deferred<Settings>();
    h.save.mockImplementationOnce(() => disk.promise);
    const first = h.queue.persist({ theme: 'light' });
    const zoom = h.queue.persist({ appZoom: 130 });
    const all = Promise.allSettled([first, zoom]);
    disk.reject(new Error('Disk full'));
    expect((await all).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(h.saved()).toMatchObject({ appZoom: 100 });
    expect(h.save).toHaveBeenCalledOnce();
    expect(await h.queue.persist({ appZoom: 120 })).toBe(true);
    expect(h.saved().appZoom).toBe(120);
  });
  it('uses latest settings after delayed native preparation and commits only owned fields', async () => {
    const h = harness(); const native = deferred<void>();
    h.beforeSave.mockReturnValueOnce(native.promise);
    const result = h.queue.persist({ appZoom: 130 });
    h.external({ fontSize: 20, themePalette: 'code-2026' });
    native.resolve();
    expect(await result).toBe(true);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ appZoom: 130, fontSize: 20, themePalette: 'code-2026' }));
    // API responses may include unrelated fields from an older full snapshot.
    h.save.mockImplementationOnce(async next => ({ ...next, fontSize: 9 }));
    expect(await h.queue.persist({ theme: 'light' })).toBe(true);
    expect(h.saved().fontSize).toBe(20);
  });
  it('reports false if the persisted response does not contain the requested value', async () => {
    const h = harness();
    h.save.mockImplementationOnce(async next => ({ ...next, appZoom: 100 }));
    expect(await h.queue.persist({ appZoom: 130 })).toBe(false);
    expect(h.saved().appZoom).toBe(100);
  });
  it('rejects native failures before disk writes including callers queued during preparation', async () => {
    const h = harness(); const native = deferred<void>(); h.beforeSave.mockReturnValueOnce(native.promise);
    const first = h.queue.persist({ appZoom: 130 }); const next = h.queue.persist({ theme: 'light' });
    const all = Promise.allSettled([first, next]); native.reject(new Error('Native failure'));
    expect((await all).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(h.save).not.toHaveBeenCalled();
  });
});
