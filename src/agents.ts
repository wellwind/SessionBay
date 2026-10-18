import type { AgentKind, AgentOptions, Installation, Settings } from './types';
import manifest from './agent-manifest.json';

export type HistoryAgentKind = AgentKind;

export interface AgentCapability {
  id: AgentKind;
  name: string;
  executable: string;
  logo: string;
  bypassFlag: string;
  /** Opt-in bridge API; launch-local Codex/Claude hooks are separately enabled in Settings. */
  activity: {
    adapter: 'codexHooks' | 'claudeHooks' | 'grokHooks' | 'antigravityHooks' | 'openCodeV1Events';
    transport: 'orderedBridgeOptIn';
  };
  history: {
    supported: true;
    parserId: HistoryAgentKind;
    defaultDirectory: string;
    sourceEnv: string | null;
    rootPlaceholder: string;
    description: string;
  } | {
    supported: false;
    parserId: null;
    defaultDirectory: string;
    sourceEnv: null;
    rootPlaceholder: null;
    description: string;
  };
  launch: {
    versionArgs: string[];
    newArgs: string[];
    resumeArgs: string[];
    cwdArgs: string[];
  };
  resume: {
    manualId: boolean;
    argument: string;
    description: string;
  };
}

/** Built-in registration is shared with Rust; contract tests reject unregistered or inconsistent entries. */
const builtinProviders = manifest.providers as AgentCapability[];
export const agentKinds: readonly AgentKind[] = builtinProviders.map((provider) => provider.id);
export const agentCapabilities = Object.fromEntries(builtinProviders.map((provider) => [provider.id, provider])) as Record<AgentKind, AgentCapability>;

export const historyAgentKinds = agentKinds.filter(
  (kind): kind is HistoryAgentKind => agentCapabilities[kind].history.supported,
);
export const agentNames = Object.fromEntries(agentKinds.map((kind) => [kind, agentCapabilities[kind].name])) as Record<AgentKind, string>;
export const executableDefaults = Object.fromEntries(agentKinds.map((kind) => [kind, agentCapabilities[kind].executable])) as Record<AgentKind, string>;
export const bypassFlags = Object.fromEntries(agentKinds.map((kind) => [kind, agentCapabilities[kind].bypassFlag])) as Record<AgentKind, string>;

export function defaultAgentOptions(): Record<AgentKind, AgentOptions> {
  return Object.fromEntries<AgentOptions>(agentKinds.map((kind) => [kind, { extraArgs: [], bypassPermissions: false }])) as Record<AgentKind, AgentOptions>;
}
export function normalizedAgentOptions(settings: Settings): Record<AgentKind, AgentOptions> {
  const result = defaultAgentOptions();
  for (const kind of agentKinds) {
    const saved = settings.agentOptions?.[kind];
    if (saved) result[kind] = { ...saved, extraArgs: [...saved.extraArgs] };
  }
  return result;
}


/** Executable discovery and version probing never establish a provider's login state. */
export function installationState(installation?: Installation, changed = false): {
  text: string;
  className: 'success' | 'neutral' | 'warning';
} {
  if (changed) return { text: '設定尚未套用', className: 'neutral' };
  if (!installation) return { text: '尚未偵測', className: 'neutral' };
  if (installation.status === 'versionCheckFailed')
    return { text: '已找到執行檔 · 版本檢查失敗', className: 'warning' };
  if (installation.status === 'missing' || !installation.available)
    return { text: '未偵測到', className: 'neutral' };
  return { text: installation.version ? '可啟動' : '已找到執行檔', className: 'success' };
}

/** Provider preference is independent of executable discovery and source-level toggles. */
export function isAgentEnabled(settings: Pick<Settings, 'agentEnabled'>, kind: AgentKind): boolean {
  return settings.agentEnabled?.[kind] !== false;
}
export function preferredEnabledAgent(settings: Pick<Settings, 'agentEnabled' | 'defaultAgent'>): AgentKind | undefined {
  return isAgentEnabled(settings, settings.defaultAgent) ? settings.defaultAgent : agentKinds.find((kind) => isAgentEnabled(settings, kind));
}
