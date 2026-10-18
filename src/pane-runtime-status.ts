import { AGENT_OBSERVATION_LABELS, type AgentObservation } from './agent-observation';
import type { Pane } from './types';

// Only explicit states are suitable for persistent text. Event observations
// (prompt/tool/stop/invocation) never imply current work, idle or user action.
const displayedObservations = new Set<AgentObservation>([
  'busy', 'idle', 'retry', 'awaitingInput', 'awaitingPermission',
  'terminalIdle', 'terminalWorking', 'terminalDone', 'terminalBlocked',
  'terminalPermission', 'terminalQuestion', 'terminalAuthentication', 'terminalError',
]);

export function paneRuntimeStatusText(pane: Pane, connecting: boolean, observation: string): string {
  if (connecting) return pane.state === 'starting' ? '正在啟動終端…' : '正在重新附接終端…';
  switch (pane.state) {
    case 'disconnected': return '連線中斷 · 程序狀態待確認';
    case 'interrupted': return '背景程序已中斷';
    case 'starting': return '啟動中…';
    case 'exited': return `已退出 · ${pane.exitCode ?? '未知結束碼'}`;
    case 'failed': return '啟動／執行失敗';
    case 'placeholder': return '已還原布局';
    case 'running':
      if (pane.kind === 'shell') return '執行中';
      return displayedObservations.has(observation as AgentObservation)
        ? AGENT_OBSERVATION_LABELS[observation as AgentObservation] : '';
  }
}
