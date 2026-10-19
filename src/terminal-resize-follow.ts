import type { Terminal } from '@xterm/xterm';

/** Preserve bottom-following across xterm's deferred scrollbar synchronization. */
export function followTerminalResize(terminal: Pick<Terminal, 'buffer' | 'onRender' | 'onScroll' | 'onSelectionChange' | 'hasSelection' | 'scrollToBottom'>) {
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
  const render = terminal.onRender(() => {
    render.dispose();
    scroll.dispose(); // xterm's own scrollbar sync follows onRender in this turn.
    queueMicrotask(() => {
      const follow = active && terminal.buffer.active === buffer;
      dispose();
      if (follow) terminal.scrollToBottom();
    });
  });
  subscriptions.push(render);
  return {
    get active() { return active; },
    resizeComplete() { resizing = false; },
    dispose,
  };
}
