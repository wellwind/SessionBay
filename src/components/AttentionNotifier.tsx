import { useEffect, useRef } from 'react';
import { api, isDesktop } from '../api';
import { agentNames } from '../agents';
import type { AttentionKind } from '../runtime-activity';
import type { Project, Workspace } from '../types';
import { useRuntimeActivity } from './RuntimeActivity';

const MESSAGES: Record<AttentionKind, string> = { waiting: '正在等待你的輸入或確認', done: '已完成', failed: '回報失敗' };
// Collapse bursts (e.g. several panes finishing together) without dropping distinct panes.
const PANE_COOLDOWN_MS = 5_000;

export function attentionNotification(kind: AttentionKind, pane: Workspace['panes'][string], projects: readonly Project[]) {
  const agent = pane.kind === 'shell' ? 'Terminal' : agentNames[pane.kind];
  const project = projects.find(item => item.id === pane.projectId)?.name;
  return { title: `${agent} ${MESSAGES[kind]}`, body: [pane.title, project].filter(Boolean).join(' · ') };
}

/** Sends OS notifications for panes that need attention while out of view. */
export function AttentionNotifier({ enabled, workspace, projects }: { enabled: boolean; workspace: Workspace; projects: readonly Project[] }) {
  const store = useRuntimeActivity();
  const latest = useRef({ workspace, projects });
  latest.current = { workspace, projects };
  useEffect(() => {
    if (!store || !enabled || !isDesktop()) return;
    const sent = new Map<string, number>();
    store.onAttention = (id, kind) => {
      const pane = latest.current.workspace.panes[id];
      const now = Date.now();
      if (!pane || now - (sent.get(id) ?? -Infinity) < PANE_COOLDOWN_MS) return;
      sent.set(id, now);
      const { title, body } = attentionNotification(kind, pane, latest.current.projects);
      void api.notify(title, body, id).catch(() => {});
    };
    return () => { store.onAttention = undefined; };
  }, [store, enabled]);
  return null;
}
