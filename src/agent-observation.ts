/** Expiring provider observations, never a claim based on terminal output. */
export const AGENT_OBSERVATION_LABELS = {
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
