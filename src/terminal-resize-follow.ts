import type { Terminal } from '@xterm/xterm';

/** Release once the prompt has stayed at the bottom for this many frames… */
export const FOLLOW_STABLE_FRAMES = 2;
/**
 * …but never keep pinning longer than this (~1.5 s at 60 fps). xterm clamps
 * scrollToBottom to scroll dimensions it only refreshes when it renders, and a
 * paused renderer (late IntersectionObserver under load) can take that long.
 */
export const FOLLOW_MAX_FRAMES = 90;

/** Preserve bottom-following across xterm's deferred scrollbar synchronization. */
export function followTerminalResize(
  terminal: Pick<Terminal, 'buffer' | 'onRender' | 'onScroll' | 'onSelectionChange' | 'hasSelection' | 'scrollToBottom' | 'scrollLines'>,
  nextFrame: (callback: () => void) => unknown = requestAnimationFrame,
) {
  const buffer = terminal.buffer.active;
  if (buffer.viewportY !== buffer.baseY) return null;
  const initialViewport = buffer.viewportY;
  let active = true;
  let resizing = true;
  const subscriptions: { dispose(): void }[] = [];
  const dispose = () => { active = false; subscriptions.forEach(subscription => subscription.dispose()); };
  // Synchronous resize scrolls are expected. Later navigation before render is user intent.
  const scroll = terminal.onScroll(() => { if (!resizing && buffer.viewportY !== initialViewport && buffer.viewportY !== buffer.baseY) dispose(); });
  subscriptions.push(scroll, terminal.onSelectionChange(() => { if (!resizing && terminal.hasSelection()) dispose(); }), terminal.buffer.onBufferChange(dispose));
  /** Returns whether the viewport was already at the bottom, or null once cancelled. */
  const pin = () => {
    if (!active || terminal.buffer.active !== buffer) { dispose(); return null; }
    if (buffer.viewportY === buffer.baseY) return true;
    terminal.scrollToBottom();
    if (buffer.viewportY !== buffer.baseY) {
      // xterm 6 can miss its viewport dimension sync after a resize and keep the
      // old height, clamping scrollToBottom short of the prompt. A one-line scroll
      // runs that sync synchronously, after which the bottom is reachable.
      terminal.scrollLines(-1);
      terminal.scrollToBottom();
    }
    return false;
  };
  const render = terminal.onRender(() => {
    render.dispose();
    scroll.dispose(); // xterm's own scrollbar sync follows onRender in this turn.
    queueMicrotask(() => {
      if (pin() === null) return;
      // Under load the scrollbar sync (and a follow-up fit) can land frames later
      // and restore an old viewport. Keep pinning until it stays at the bottom;
      // explicit user intent (wheel, keys, scrollbar, selection) still cancels.
      let frames = 0, stable = 0;
      const settle = () => {
        const settled = pin();
        if (settled === null) return;
        stable = settled ? stable + 1 : 0;
        if (stable >= FOLLOW_STABLE_FRAMES || ++frames >= FOLLOW_MAX_FRAMES) dispose();
        else nextFrame(settle);
      };
      // A resumed renderer refreshes scroll dimensions; pin right after it paints.
      subscriptions.push(terminal.onRender(() => queueMicrotask(() => { if (active) pin(); })));
      nextFrame(settle);
    });
  });
  subscriptions.push(render);
  return {
    get active() { return active; },
    resizeComplete() { resizing = false; },
    dispose,
  };
}
