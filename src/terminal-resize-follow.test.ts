import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { FOLLOW_MAX_FRAMES, followTerminalResize } from './terminal-resize-follow';

function renderer(viewportY = 71) {
  let render = () => {};
  const dispose = vi.fn();
  const buffer = { active: { baseY: 71, viewportY } };
  const scrollToBottom = vi.fn(() => { buffer.active.viewportY = buffer.active.baseY; });
  let scroll = () => {}, selection = () => {}, change = () => {};
  const terminal = { buffer: { ...buffer, onBufferChange: (callback: () => void) => { change = callback; return {dispose() {}}; } },
    onScroll: (callback: () => void) => { scroll = callback; return {dispose() { scroll = () => {}; }}; },
    onSelectionChange: (callback: () => void) => { selection = callback; return {dispose() {}}; },
    hasSelection: () => true, scrollToBottom, scrollLines: vi.fn(), onRender: vi.fn(callback => { render = callback; return { dispose }; }) };
  return { terminal: terminal as unknown as Terminal, buffer, scrollToBottom, dispose, render: () => render(), scroll: () => scroll(), selection: () => selection(), change: () => change() };
}
describe('prompt following after terminal resize', () => {
  it('waits for the render turn to finish synchronizing the scrollbar', async () => {
    const t = renderer();
    const frames: (() => void)[] = [];
    const follow = followTerminalResize(t.terminal, callback => frames.push(callback))!;
    t.buffer.active.baseY = 74;
    t.buffer.active.viewportY = 74;
    t.render();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
    t.buffer.active.viewportY = 71; // xterm scrollbar sync after onRender
    await Promise.resolve();
    expect(t.scrollToBottom).toHaveBeenCalledOnce();
    expect(t.buffer.active.viewportY).toBe(74);
    // Settling frames keep the prompt pinned, then release.
    while (frames.length) frames.shift()!();
    expect(follow.active).toBe(false);
    expect(t.dispose).toHaveBeenCalled();
  });
  it('re-pins when a deferred scrollbar sync restores the old viewport a frame later', async () => {
    const t = renderer();
    const frames: (() => void)[] = [];
    const follow = followTerminalResize(t.terminal, callback => frames.push(callback))!;
    t.buffer.active.baseY = 72;
    t.render();
    await Promise.resolve();
    expect(t.buffer.active.viewportY).toBe(72);
    t.buffer.active.viewportY = 71; // late sync under load
    frames.shift()!();
    expect(t.scrollToBottom).toHaveBeenCalledTimes(2);
    expect(t.buffer.active.viewportY).toBe(72);
    expect(follow.active).toBe(true);
    while (frames.length) frames.shift()!();
    expect(follow.active).toBe(false);
    expect(frames).toHaveLength(0);
  });
  it('gives up after a bounded number of frames if the renderer keeps restoring an old viewport', async () => {
    const t = renderer();
    const frames: (() => void)[] = [];
    const follow = followTerminalResize(t.terminal, callback => frames.push(callback))!;
    t.buffer.active.baseY = 72;
    t.render();
    await Promise.resolve();
    let ran = 0;
    while (frames.length) { t.buffer.active.viewportY = 60; frames.shift()!(); ran += 1; }
    expect(ran).toBe(FOLLOW_MAX_FRAMES);
    expect(follow.active).toBe(false);
  });
  it('forces xterm to resync stale viewport dimensions when scrollToBottom is clamped', async () => {
    const t = renderer();
    let synced = false;
    // Stale viewport height clamps the scroll one screen short until a scroll resyncs it.
    t.scrollToBottom.mockImplementation(() => { t.buffer.active.viewportY = synced ? t.buffer.active.baseY : 71; });
    const scrollLines = t.terminal.scrollLines as unknown as ReturnType<typeof vi.fn>;
    scrollLines.mockImplementation(() => { synced = true; t.buffer.active.viewportY -= 1; });
    followTerminalResize(t.terminal, () => undefined);
    t.buffer.active.baseY = 82;
    t.render();
    await Promise.resolve();
    expect(scrollLines).toHaveBeenCalledWith(-1);
    expect(t.buffer.active.viewportY).toBe(82);
  });
  it('stops settling as soon as user intent disposes the follow', async () => {
    const t = renderer();
    const frames: (() => void)[] = [];
    const follow = followTerminalResize(t.terminal, callback => frames.push(callback))!;
    t.buffer.active.baseY = 72;
    t.render();
    await Promise.resolve();
    follow.dispose(); // wheel, Shift+PageUp, scrollbar or selection
    t.buffer.active.viewportY = 40;
    frames.shift()!();
    expect(t.buffer.active.viewportY).toBe(40);
    expect(frames).toHaveLength(0);
  });
  it('does not move a user reading scrollback', () => {
    const t = renderer(40);
    expect(followTerminalResize(t.terminal)).toBeNull();
    expect(t.terminal.onRender).not.toHaveBeenCalled();
  });
  it('cancels before the microtask on user scrolling, hiding or disposal', async () => {
    const t = renderer();
    const follow = followTerminalResize(t.terminal)!;
    t.render(); follow.dispose();
    await Promise.resolve();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
    expect(follow.active).toBe(false);
  });
  it('preserves navigation between fit and render, including search scrollback', async () => {
    const t = renderer();
    const follow = followTerminalResize(t.terminal)!;
    t.buffer.active.baseY = 74;
    t.scroll(); // synchronous fit scroll is expected
    expect(follow.active).toBe(true);
    follow.resizeComplete();
    t.buffer.active.viewportY = 30;
    t.scroll(); // search or programmatic scroll after fit
    t.render(); await Promise.resolve();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
    expect(t.buffer.active.viewportY).toBe(30);
  });
  it('cancels selection autoscroll even after onRender', async () => {
    const t = renderer();
    followTerminalResize(t.terminal)!.resizeComplete();
    t.render(); t.selection(); await Promise.resolve();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
  });
  it('rejects a different active buffer before the microtask', async () => {
    const t = renderer();
    followTerminalResize(t.terminal)!.resizeComplete();
    t.render();
    Object.assign(t.terminal.buffer, {active: {baseY: 0, viewportY: 0}});
    await Promise.resolve();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
  });
  it('cancels a buffer switch even if the original buffer becomes active again', async () => {
    const t = renderer();
    followTerminalResize(t.terminal)!.resizeComplete();
    t.change(); t.render(); await Promise.resolve();
    expect(t.scrollToBottom).not.toHaveBeenCalled();
  });

});
