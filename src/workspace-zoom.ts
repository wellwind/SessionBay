/** Keep these aligned with the Settings/catalog validation and default. */
export const workspaceZoomMin = 50;
export const workspaceZoomMax = 200;
export const workspaceZoomDefault = 100;
export type WorkspaceZoomAction = 'increase' | 'decrease' | 'reset';
export const workspaceZoomShortcutHelp = '整個工作台（介面與所有終端）：macOS ⌘＋／⌘＝、⌘−、⌘0；Windows／Linux Ctrl＋／Ctrl＝、Ctrl−、Ctrl0。每次 10%，範圍 50–200%，還原 100%；立即套用並儲存。';
export function workspaceZoomShortcut(event: KeyboardEvent, mac = /Mac|iPhone|iPad/.test(navigator.platform)): WorkspaceZoomAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey !== mac || event.ctrlKey !== !mac) return null;
  if (event.key === '+' || event.key === '=') return 'increase';
  if (event.key === '-') return 'decrease';
  if (event.key === '0') return 'reset';
  return null;
}
export function nextWorkspaceZoom(size: number, action: WorkspaceZoomAction): number {
  const current = Number.isInteger(size) ? size : workspaceZoomDefault;
  return action === 'reset' ? workspaceZoomDefault : Math.max(workspaceZoomMin, Math.min(workspaceZoomMax, current + (action === 'increase' ? 10 : -10)));
}
export function acceptsWorkspaceZoomShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  // xterm's hidden textarea is the terminal input, not a settings/search field.
  if (target.matches('textarea.xterm-helper-textarea') && target.closest('.terminal-pane')) return true;
  return !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

export const workspaceZoomEvent = 'sessionbay:workspace-zoom';
/** One native zoom authority; serialize IPC and coalesce queued previews. */
export class WorkspaceZoomController {
  private applied: number | undefined;
  private running = false;
  private queue: { percent: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  constructor(private readonly setZoom: (percent: number) => Promise<void>, private readonly onApplied?: (percent: number) => void) {}
  isApplied(percent: number) { return this.applied === percent && !this.running && !this.queue.length; }
  apply(percent: number): Promise<void> {
    if (!Number.isInteger(percent) || percent < workspaceZoomMin || percent > workspaceZoomMax)
      return Promise.reject(new Error('工作台縮放須為 50–200 的整數百分比。'));
    const result = new Promise<void>((resolve, reject) => { this.queue.push({ percent, resolve, reject }); });
    if (!this.running) void this.drain();
    return result;
  }
  private async drain() {
    this.running = true;
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      const percent = batch[batch.length - 1].percent;
      try {
        if (this.applied !== percent) {
          await this.setZoom(percent);
          this.applied = percent;
          this.onApplied?.(percent);
          // Native layout and xterm DPR measurement settle before fit; ResizeObserver also remains active.
          requestAnimationFrame(() => window.dispatchEvent(new Event(workspaceZoomEvent)));
        }
        batch.forEach(({ resolve }) => resolve());
      } catch (error) {
        const failure = new Error(`工作台縮放未能套用：${error instanceof Error ? error.message : String(error)}`);
        batch.forEach(({ reject }) => reject(failure));
      }
    }
    this.running = false;
  }
}
