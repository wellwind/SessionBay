import type { Pane, Workspace } from './types';
import { paneIds } from './workspace';

/** What restarting an interrupted pane will do. */
export type InterruptedOutcome = 'resume' | 'new' | 'shell';

export interface InterruptedPlanItem {
  pane: Pane;
  outcome: InterruptedOutcome;
}

/**
 * New agent work has no indexed session or manual resume ID, but the backend may have
 * validated its provider conversation ID. Reuse that ID so a restart continues the conversation.
 */
export function interruptedResumeId(pane: Pane): string | undefined {
  if (pane.state !== 'interrupted' || pane.kind === 'shell' || pane.sessionId || pane.resumeId) return undefined;
  const id = pane.providerSessionId?.trim();
  return id ? id : undefined;
}

export function interruptedOutcome(pane: Pane): InterruptedOutcome {
  if (pane.kind === 'shell') return 'shell';
  return pane.sessionId || pane.resumeId || interruptedResumeId(pane) ? 'resume' : 'new';
}

/** Interrupted panes in tab order, so the batch starts in the order the user sees them. */
export function interruptedPlan(workspace: Workspace): InterruptedPlanItem[] {
  const ordered = workspace.tabs.flatMap((tab) => paneIds(tab.layout));
  const seen = new Set<string>();
  const items: InterruptedPlanItem[] = [];
  for (const id of ordered) {
    const pane = workspace.panes[id];
    if (seen.has(id) || !pane || pane.state !== 'interrupted') continue;
    seen.add(id);
    items.push({ pane, outcome: interruptedOutcome(pane) });
  }
  return items;
}
