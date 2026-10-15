import { agentCapabilities } from '../agents';
import type { AgentKind } from '../types';

/** Registry-provided monograms are deliberate fallbacks, not third-party brand artwork. */
export function AgentIcon({ kind, name }: { kind: string; name?: string }) {
  const provider = agentCapabilities[kind as AgentKind];
  const fallback = Array.from(name?.trim() || kind.trim() || '?')[0].toLocaleUpperCase();
  return <span className="agent-icon" data-agent={provider?.id ?? 'unknown'} aria-hidden="true">
    {provider?.logo?.trim() || fallback}
  </span>;
}
