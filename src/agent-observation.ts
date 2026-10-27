import { t } from './i18n';
/** Provider observations and explicitly labelled terminal-reported status. */
export const AGENT_OBSERVATION_LABELS = {
  terminalIdle: t('Idle (terminal report)'), terminalWorking: t('Working (terminal report)'), terminalDone: t('Done (terminal report)'),
  terminalBlocked: t('Waiting for action (terminal report)'), terminalPermission: t('Waiting for permission (terminal report)'), terminalQuestion: t('Waiting for input (terminal report)'),
  terminalAuthentication: t('Waiting for login (terminal report)'), terminalError: t('Failed (terminal report)'),
  promptSubmitted: t('New prompt received'), toolPending: t('Tool about to run'), toolFinished: t('Tool reported its result'),
  awaitingInput: t('Waiting for input'), awaitingPermission: t('Waiting for permission'),
  waitingInput: t('Input-waiting notice received'), waitingPermission: t('Permission-waiting notice received'),
  permissionRequested: t('Permission request received'), turnStopRequested: t('Turn stop request received'),
  invocationStarted: t('Model call started'), invocationEnded: t('Model call ended'), sessionEnded: t('Session reported its end'),
  interrupted: t('Interruption reported'), failed: t('Failure reported'), busy: t('Working'), idle: t('Idle'), retry: t('Retrying'),
} as const;
export type AgentObservation = keyof typeof AGENT_OBSERVATION_LABELS;
export interface AgentActivityEvent {
  type: 'agentActivity'; runtimeId: string; generation: string; revision: number;
  observation: AgentObservation | null; validForMs: number;
}
export const MAX_OBSERVATION_TTL_MS = 30_000;
export function isAgentObservation(value: unknown): value is AgentObservation {
  return typeof value === 'string' && Object.hasOwn(AGENT_OBSERVATION_LABELS, value);
}

export const TERMINAL_STATUS_OBSERVATIONS = {
  idle: 'terminalIdle', working: 'terminalWorking', done: 'terminalDone', blocked: 'terminalBlocked',
  permission: 'terminalPermission', question: 'terminalQuestion', authentication: 'terminalAuthentication', error: 'terminalError',
} as const;
export interface TerminalStatusEvent {
  type: 'terminalStatus'; runtimeId: string; generation: string; revision: number;
  status: keyof typeof TERMINAL_STATUS_OBSERVATIONS | null;
}
