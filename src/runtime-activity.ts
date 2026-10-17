/** Ephemeral metadata only. Never stores terminal bytes or infers agent busy/idle. */
interface Activity {
  lease: string;
  active: boolean;
  runtimeId?: string;
  sequence: number;
  visible: boolean;
  recent: boolean;
  unread: boolean;
  connecting: boolean;
  recentUntil: number;
  connectingUntil: number;
}
export const OUTPUT_RECENCY_MS = 1400;
export const CONNECTING_RECENCY_MS = 1600;
const NOTIFY_INTERVAL_MS = 100;
export class RuntimeActivityStore {
  private entries = new Map<string, Activity>();
  private listeners = new Set<() => void>();
  private foreground = true;
  private expiry?: ReturnType<typeof setTimeout>;
  private notification?: ReturnType<typeof setTimeout>;
  private disposed = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot(ids: readonly string[]): string {
    let recent = false, unread = false, connecting = false;
    for (const id of ids) {
      const item = this.entries.get(id);
      recent ||= !!item?.recent; unread ||= !!item?.unread; connecting ||= !!item?.connecting;
    }
    return `${Number(recent)}${Number(unread)}${Number(connecting)}`;
  }
  begin(id: string, lease: string, runtimeId: string | undefined, visible: boolean, connecting = true) {
    if (this.disposed) return;
    const previous = this.entries.get(id);
    this.entries.set(id, { lease, active: true, runtimeId, sequence: -1, visible, recent: false,
      unread: !!runtimeId && runtimeId === previous?.runtimeId && !!previous.unread && !(visible && this.foreground),
      connecting, recentUntil: 0, connectingUntil: connecting ? Date.now() + CONNECTING_RECENCY_MS : 0 });
    this.changed(); this.scheduleExpiry();
  }
  bind(id: string, lease: string, runtimeId: string) {
    const item = this.current(id, lease);
    if (!item || (item.runtimeId && item.runtimeId !== runtimeId)) return false;
    item.runtimeId = runtimeId;
    return true;
  }
  ready(id: string, lease: string) {
    const item = this.current(id, lease); if (!item) return;
    if (item.connecting) {
      item.connecting = false; this.changed();
      clearTimeout(this.expiry); this.expiry = undefined; this.scheduleExpiry();
    }
  }
  output(id: string, lease: string, runtimeId: string, sequence: number) {
    const item = this.current(id, lease);
    if (!item || item.runtimeId !== runtimeId || sequence <= item.sequence) return;
    item.sequence = sequence;
    const wasRecent = item.recent, wasUnread = item.unread;
    item.recent = true; item.recentUntil = Date.now() + OUTPUT_RECENCY_MS;
    item.unread = !(item.visible && this.foreground);
    if (!wasRecent || wasUnread !== item.unread) this.changed();
    this.scheduleExpiry();
  }
  visible(id: string, visible: boolean) {
    const item = this.entries.get(id); if (!item) return;
    item.visible = visible;
    if (visible && this.foreground && item.unread) { item.unread = false; this.changed(); }
  }
  setForeground(foreground: boolean) {
    this.foreground = foreground;
    if (!foreground) return;
    let changed = false;
    for (const item of this.entries.values()) if (item.visible && item.unread) { item.unread = false; changed = true; }
    if (changed) this.changed();
  }
  end(id: string, lease: string) {
    const item = this.current(id, lease); if (!item) return;
    item.recent = false; item.connecting = false;
    // Revoke the lease immediately: later queued output cannot revive activity.
    item.active = false;
    this.changed();
  }
  remove(id: string, lease: string) {
    const item = this.entries.get(id);
    if (!item || item.lease !== lease) return;
    this.entries.delete(id); this.changed();
    if (!this.entries.size) { clearTimeout(this.expiry); this.expiry = undefined; }
  }
  dispose() {
    this.disposed = true; clearTimeout(this.expiry); clearTimeout(this.notification);
    this.expiry = undefined; this.notification = undefined; this.entries.clear(); this.listeners.clear();
  }
  private current(id: string, lease: string) { const item = this.entries.get(id); return lease && item?.lease === lease && item.active ? item : undefined; }
  private changed() {
    if (this.disposed || this.notification) return;
    this.notification = setTimeout(() => { this.notification = undefined; for (const listener of this.listeners) listener(); }, NOTIFY_INTERVAL_MS);
  }
  private scheduleExpiry() {
    if (this.disposed || this.expiry) return;
    let next = Infinity;
    for (const item of this.entries.values()) {
      if (item.recent) next = Math.min(next, item.recentUntil);
      if (item.connecting) next = Math.min(next, item.connectingUntil);
    }
    if (!Number.isFinite(next)) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      const now = Date.now(); let changed = false;
      for (const item of this.entries.values()) {
        if (item.recent && item.recentUntil <= now) { item.recent = false; changed = true; }
        if (item.connecting && item.connectingUntil <= now) { item.connecting = false; changed = true; }
      }
      if (changed) this.changed();
      this.scheduleExpiry();
    }, Math.max(1, next - Date.now()));
  }
}
