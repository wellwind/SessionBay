import { AGENT_OBSERVATION_LABELS, isAgentObservation, MAX_OBSERVATION_TTL_MS, type AgentActivityEvent, type AgentObservation, type TerminalStatusEvent, TERMINAL_STATUS_OBSERVATIONS } from './agent-observation';
/** Ephemeral metadata only. Never stores terminal bytes or infers agent busy/idle. */
interface Activity {
  agent?: { generation: string; revision: number; observation: AgentObservation | null; until: number };
  generations: Set<string>;
  agentBlocked: boolean;
  lease: string;
  active: boolean;
  allowTerminalResult: boolean;
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
  private expiryAt?: number;
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
  agentSnapshot(ids: readonly string[]): string {
    return this.agentStates(ids).split('|').filter(isAgentObservation).map(value => AGENT_OBSERVATION_LABELS[value]).join('、');
  }
  agentStates(ids: readonly string[]): string {
    const labels = new Set<AgentObservation>(), runtimes = new Set<string>();
    for (const id of ids) {
      const item = this.entries.get(id);
      if (!item || (!item.active && !['terminalDone', 'terminalError'].includes(item.agent?.observation ?? '')) || !item.runtimeId || runtimes.has(item.runtimeId)) continue;
      runtimes.add(item.runtimeId);
      if (item.agent?.observation && item.agent.until > performance.now()) labels.add(item.agent.observation);
    }
    return [...labels].join('|');
  }
  observeTerminal(id: string, lease: string, event: TerminalStatusEvent) {
    const retained = this.entries.get(id);
    const settled = event.status === 'done' || event.status === 'error';
    const item = this.current(id, lease) ?? (settled && retained?.lease === lease && retained.allowTerminalResult ? retained : undefined);
    if (!item || item.runtimeId !== event.runtimeId || item.agentBlocked) return;
    if (event.status !== null && !Object.hasOwn(TERMINAL_STATUS_OBSERVATIONS, event.status)) {
      if (item.agent) item.agent.observation = null;
      this.changed(); return;
    }
    const observation = event.status === null ? null : TERMINAL_STATUS_OBSERVATIONS[event.status];
    this.observe(id, lease, { type: 'agentActivity', runtimeId: event.runtimeId, generation: event.generation,
      revision: event.revision, observation, validForMs: observation === null ? 0 : MAX_OBSERVATION_TTL_MS }, settled);
    // The OSC protocol has no heartbeat. Lifetime is native replacement/reset/
    // process events; a lost UI/broker connection still ends this local lease.
    if (item.agent?.generation === event.generation && item.agent.revision === event.revision) item.agent.until = Infinity;
  }
  observe(id: string, lease: string, event: AgentActivityEvent, terminalResult = false) {
    const retained = this.entries.get(id);
    const item = this.current(id, lease) ?? (terminalResult && retained?.lease === lease && retained.allowTerminalResult ? retained : undefined);
    if (!item || item.runtimeId !== event.runtimeId || item.agentBlocked) return;
    if (typeof event.generation !== 'string' || !event.generation.length || event.generation.length > 128
      || Array.from(event.generation).some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))
      || !Number.isSafeInteger(event.revision) || event.revision < 0
      || !Number.isInteger(event.validForMs) || event.validForMs < 0 || event.validForMs > MAX_OBSERVATION_TTL_MS
      || (event.observation !== null && (!isAgentObservation(event.observation) || event.validForMs === 0))
      || (event.observation === null && event.validForMs !== 0)) {
      if (item.agent) item.agent.observation = null;
      this.changed(); return;
    }
    if (item.agent?.generation !== event.generation) {
      if (item.generations.has(event.generation)) return;
      if (item.generations.size >= 32) { item.agentBlocked = true; item.agent = undefined; this.changed(); return; }
      item.generations.add(event.generation);
    } else if (event.revision <= item.agent.revision) return;
    item.agent = { generation: event.generation, revision: event.revision, observation: event.observation, until: performance.now() + event.validForMs };
    this.changed(); this.scheduleExpiry();
  }
  begin(id: string, lease: string, runtimeId: string | undefined, visible: boolean, connecting = true) {
    if (this.disposed) return;
    const previous = this.entries.get(id);
    this.entries.set(id, { lease, generations: new Set(), agentBlocked: false, active: true, allowTerminalResult: false, runtimeId, sequence: -1, visible, recent: false,
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
  revokeAgent(id: string) {
    const item = this.entries.get(id); if (!item) return;
    item.agent = undefined; item.agentBlocked = true; item.allowTerminalResult = false;
    this.changed();
  }
  end(id: string, lease: string, preserveTerminalResult = false) {
    const item = this.entries.get(id); if (!item || item.lease !== lease) return;
    // A later disconnect must also invalidate a result retained after exit.
    if (!item.active && preserveTerminalResult) return;
    item.recent = false; item.connecting = false;
    // Revoke the lease immediately: later queued output cannot revive activity.
    item.active = false; item.allowTerminalResult = preserveTerminalResult;
    if (!preserveTerminalResult || !['terminalDone', 'terminalError'].includes(item.agent?.observation ?? '')) item.agent = undefined;
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
    if (this.disposed) return;
    let next = Infinity;
    for (const item of this.entries.values()) {
      if (item.recent) next = Math.min(next, item.recentUntil - Date.now());
      if (item.connecting) next = Math.min(next, item.connectingUntil - Date.now());
    }
    for (const item of this.entries.values()) if (item.agent?.observation) next = Math.min(next, item.agent.until - performance.now());
    if (!Number.isFinite(next)) return;
    const deadline = performance.now() + Math.max(1, next);
    if (this.expiry && this.expiryAt !== undefined && this.expiryAt <= deadline) return;
    clearTimeout(this.expiry); this.expiryAt = deadline;
    this.expiry = setTimeout(() => {
      this.expiry = undefined; this.expiryAt = undefined;
      const now = Date.now(); let changed = false;
      for (const item of this.entries.values()) {
        if (item.recent && item.recentUntil <= now) { item.recent = false; changed = true; }
        if (item.connecting && item.connectingUntil <= now) { item.connecting = false; changed = true; }
      }
      for (const item of this.entries.values()) if (item.agent?.observation && item.agent.until <= performance.now()) { item.agent.observation = null; changed = true; }
      if (changed) this.changed();
      this.scheduleExpiry();
    }, Math.max(1, next));
  }
}
