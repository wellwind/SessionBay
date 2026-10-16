import { describe, expect, it, vi } from 'vitest';
import { acceptsWorkspaceZoomShortcut, nextWorkspaceZoom, workspaceZoomShortcut, WorkspaceZoomController, workspaceZoomEvent } from './workspace-zoom';
import { reservedWorkspaceShortcut } from './commands';
const key = (key: string, patch: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, ...patch });
describe('workspace zoom shortcuts', () => {
  it('recognizes semantic plus/equal, minus and zero on the platform modifier', () => {
    for (const mac of [false, true]) {
      const mods = { ctrlKey: !mac, metaKey: mac };
      expect(workspaceZoomShortcut(key('=', mods), mac)).toBe('increase');
      expect(workspaceZoomShortcut(key('+', { ...mods, shiftKey: true }), mac)).toBe('increase');
      expect(workspaceZoomShortcut(key('+', { ...mods, code: 'NumpadAdd' }), mac)).toBe('increase');
      expect(workspaceZoomShortcut(key('-', mods), mac)).toBe('decrease');
      expect(workspaceZoomShortcut(key('0', mods), mac)).toBe('reset');
      // Some keyboard layouts require Shift to produce these semantic keys.
      expect(workspaceZoomShortcut(key('=', { ...mods, shiftKey: true }), mac)).toBe('increase');
      expect(workspaceZoomShortcut(key('-', { ...mods, shiftKey: true }), mac)).toBe('decrease');
      expect(workspaceZoomShortcut(key('0', { ...mods, shiftKey: true }), mac)).toBe('reset');
      expect(workspaceZoomShortcut(key('=', { ctrlKey: mac, metaKey: !mac }), mac)).toBeNull();
    }
  });
  it('leaves composing, non-zoom and modified terminal keys alone', () => {
    for (const e of [key('=', { isComposing: true }), key('=', { keyCode: 229 }), key('=', { altKey: true }), key('=', { metaKey: true }), key('=', { ctrlKey: false }), key('_', { shiftKey: true }), key(')', { shiftKey: true }), key('Enter', { shiftKey: true }), key('c')]) expect(workspaceZoomShortcut(e, false)).toBeNull();
    const cancelled = key('='); cancelled.preventDefault();
    expect(workspaceZoomShortcut(cancelled, false)).toBeNull();
  });
  it('clamps to existing bounds and resets to the catalog default', () => {
    expect(nextWorkspaceZoom(50, 'decrease')).toBe(50);
    expect(nextWorkspaceZoom(200, 'increase')).toBe(200);
    expect(nextWorkspaceZoom(130, 'reset')).toBe(100);
    expect(nextWorkspaceZoom(130, 'increase')).toBe(140);
    expect(nextWorkspaceZoom(Number.NaN, 'decrease')).toBe(90);
  });
  it('excludes editable fields but accepts the actual xterm textarea', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input><textarea></textarea><select></select><div contenteditable="true"><b>Text</b></div><div role="textbox"></div><section class="terminal-pane"><textarea class="xterm-helper-textarea"></textarea></section><button>Tools</button>';
    for (const selector of ['input', 'textarea', 'select', 'b', '[role="textbox"]']) expect(acceptsWorkspaceZoomShortcut(root.querySelector(selector))).toBe(false);
    expect(acceptsWorkspaceZoomShortcut(root.querySelector('.xterm-helper-textarea'))).toBe(true);
    expect(acceptsWorkspaceZoomShortcut(root.querySelector('button'))).toBe(true);
  });
  it('reserves zoom combinations against custom command conflicts', () => {
    for (const mac of [true, false]) {
      for (const binding of ['Mod+=', 'Mod++', 'Mod+Shift+=', 'Mod+Shift++', 'Mod+-', 'Mod+Shift+-', 'Mod+0', 'Mod+Shift+0']) expect(reservedWorkspaceShortcut(binding, mac)).toBe(true);
      expect(reservedWorkspaceShortcut('Mod+Alt+-', mac)).toBe(false);
    }
  });
});

describe('native zoom serialization', () => {
  it('serializes, coalesces pending previews, and applies cancellation last', async () => {
    let finish!: () => void;
    const native = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const applied = vi.fn(); const zoom = new WorkspaceZoomController(native, applied);
    const first = zoom.apply(110), second = zoom.apply(120), third = zoom.apply(150), cancelled = zoom.apply(100);
    expect(native).toHaveBeenCalledTimes(1); expect(zoom.isApplied(100)).toBe(false);
    finish(); await Promise.all([first, second, third, cancelled]);
    expect(native.mock.calls).toEqual([[110], [100]]);
    expect(applied.mock.calls).toEqual([[110], [100]]);
    expect(zoom.isApplied(100)).toBe(true);
    await zoom.apply(100); expect(native).toHaveBeenCalledTimes(2);
  });
  it('does not cache failed applies and emits a fit event only after success', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const native = vi.fn().mockRejectedValueOnce(new Error('native')).mockResolvedValue(undefined);
    const applied = vi.fn(), fit = vi.fn(); window.addEventListener(workspaceZoomEvent, fit);
    try {
      const zoom = new WorkspaceZoomController(native, applied);
      await expect(zoom.apply(120)).rejects.toThrow('縮放未能套用');
      expect(applied).not.toHaveBeenCalled(); expect(frames).toHaveLength(0);
      await zoom.apply(120); expect(applied).toHaveBeenCalledWith(120); expect(fit).not.toHaveBeenCalled();
      frames.forEach((frame) => frame(0)); expect(fit).toHaveBeenCalledOnce();
      expect(native).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener(workspaceZoomEvent, fit); }
  });
  it.each([49, 201, 100.5, Number.NaN, Infinity])('rejects invalid percentage %s before native IPC', async (percent) => {
    const native = vi.fn(); const zoom = new WorkspaceZoomController(native);
    await expect(zoom.apply(percent)).rejects.toThrow('50–200'); expect(native).not.toHaveBeenCalled();
  });
});
