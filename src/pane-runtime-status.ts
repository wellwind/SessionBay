import { AGENT_OBSERVATION_LABELS, type AgentObservation } from './agent-observation';
import type { Pane } from './types';
import { t } from './i18n';

// Only explicit states are suitable for persistent text. Event observations
// (prompt/tool/stop/invocation) never imply current work, idle or user action.
const displayedObservations = new Set<AgentObservation>([
  'busy', 'idle', 'retry', 'awaitingInput', 'awaitingPermission',
  'terminalIdle', 'terminalWorking', 'terminalDone', 'terminalBlocked',
  'terminalPermission', 'terminalQuestion', 'terminalAuthentication', 'terminalError',
]);

export function paneRuntimeStatusText(pane: Pane, connecting: boolean, observation: string): string {
  if (connecting) return pane.state === 'starting' ? t('Starting terminal…') : t('Reattaching terminal…');
  switch (pane.state) {
    case 'disconnected': return t('Disconnected · process state unconfirmed');
    case 'interrupted': return t('Background process interrupted');
    case 'starting': return t('Starting…');
    case 'exited': return t('Exited · {{code}}', { code: pane.exitCode ?? t('unknown exit code') });
    case 'failed': return t('Failed to start or run');
    case 'placeholder': return t('Layout restored');
    case 'running':
      if (pane.kind === 'shell') return t('Running');
      return displayedObservations.has(observation as AgentObservation)
        ? AGENT_OBSERVATION_LABELS[observation as AgentObservation] : '';
  }
}
