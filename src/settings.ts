import { agentKinds } from './agents';
import type { AgentKind, Settings } from './types';

/** Missing values use the launch-local default; saved opt-outs remain disabled. */
export function isAgentHooksEnabled(settings: Pick<Settings, 'agentHooks'>, kind: AgentKind): boolean {
  return settings.agentHooks?.[kind] !== false;
}

export function defaultAgentHooks(): Record<AgentKind, boolean> {
  return Object.fromEntries(agentKinds.map((kind) => [kind, true])) as Record<AgentKind, boolean>;
}

export function normalizedAgentHooks(settings: Pick<Settings, 'agentHooks'>): Record<AgentKind, boolean> {
  return Object.fromEntries(agentKinds.map((kind) => [kind, isAgentHooksEnabled(settings, kind)])) as Record<AgentKind, boolean>;
}
