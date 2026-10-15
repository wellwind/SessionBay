import type { AgentKind, AgentOptions, Settings } from './types';
export const agentKinds = ['codex', 'claude', 'grok', 'antigravity'] as const;
export const historyAgentKinds = ['codex', 'claude', 'grok'] as const;
export const agentNames: Record<AgentKind, string> = {
  codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', antigravity: 'Antigravity CLI',
};
export const executableDefaults: Record<AgentKind, string> = {
  codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy',
};
export const bypassFlags: Record<AgentKind, string> = {
  codex: '--dangerously-bypass-approvals-and-sandbox',
  claude: '--dangerously-skip-permissions',
  grok: '--always-approve',
  antigravity: '--dangerously-skip-permissions',
};
export function defaultAgentOptions(): Record<AgentKind, AgentOptions> {
  return { codex: { extraArgs: [], bypassPermissions: false }, claude: { extraArgs: [], bypassPermissions: false },
    grok: { extraArgs: [], bypassPermissions: false }, antigravity: { extraArgs: [], bypassPermissions: false } };
}
export function normalizedAgentOptions(settings: Settings): Record<AgentKind, AgentOptions> {
  const result = defaultAgentOptions();
  for (const kind of agentKinds) {
    const saved = settings.agentOptions?.[kind];
    if (saved) result[kind] = { ...saved, extraArgs: [...saved.extraArgs] };
  }
  return result;
}
