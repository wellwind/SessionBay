/** Provider observations and explicitly labelled terminal-reported status. */
export const AGENT_OBSERVATION_LABELS = {
  terminalIdle: '閒置（終端回報）', terminalWorking: '工作中（終端回報）', terminalDone: '已完成（終端回報）',
  terminalBlocked: '等待操作（終端回報）', terminalPermission: '等待權限（終端回報）', terminalQuestion: '等待輸入（終端回報）',
  terminalAuthentication: '等待登入（終端回報）', terminalError: '失敗（終端回報）',
  promptSubmitted: '收到新提示', toolPending: '工具即將執行', toolFinished: '工具已回報結果',
  awaitingInput: '等待輸入', awaitingPermission: '等待權限確認',
  waitingInput: '收到等待輸入通知', waitingPermission: '收到權限等待通知',
  permissionRequested: '收到權限請求', turnStopRequested: '收到回合停止請求',
  invocationStarted: '模型呼叫開始', invocationEnded: '模型呼叫結束', sessionEnded: 'Session 已回報結束',
  interrupted: '收到中斷回報', failed: '收到失敗回報', busy: '工作中', idle: '閒置', retry: '重試中',
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
