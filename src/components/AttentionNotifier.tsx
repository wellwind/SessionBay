import { useEffect, useRef } from 'react';
import { api, isDesktop } from '../api';
import { agentNames } from '../agents';
import type { AttentionKind } from '../runtime-activity';
import type { Project, Workspace } from '../types';
import { useRuntimeActivity } from './RuntimeActivity';
import { t } from '../i18n';
import { AttentionSoundBurst, PANE_COOLDOWN_MS, playAttentionSound, unlockAttentionAudio } from '../attention-sound';

const MESSAGES: Record<AttentionKind, string> = { waiting: t('is waiting for your input or confirmation'), done: t('has finished'), failed: t('reported a failure') };

export function attentionNotification(kind: AttentionKind, pane: Workspace['panes'][string], projects: readonly Project[]) {
  const agent = pane.kind === 'shell' ? 'Terminal' : agentNames[pane.kind];
  const project = projects.find(item => item.id === pane.projectId)?.name;
  return { title: `${agent} ${MESSAGES[kind]}`, body: [pane.title, project].filter(Boolean).join(' · ') };
}

/** Delivers attention alerts using the store's shared off-screen/background gating. */
export function AttentionNotifier({ enabled, soundEnabled = false, soundVolume = 70, workspace, projects }: {
  enabled: boolean; soundEnabled?: boolean; soundVolume?: number; workspace: Workspace; projects: readonly Project[];
}) {
  const store = useRuntimeActivity();
  const latest = useRef({ workspace, projects, enabled, soundEnabled, soundVolume });
  latest.current = { workspace, projects, enabled, soundEnabled, soundVolume };
  const sent = useRef(new Map<string, number>());
  useEffect(() => {
    if (!store || (!enabled && !soundEnabled) || !isDesktop()) return;
    let active = true;
    const burst = new AttentionSoundBurst(kind => {
      const options = latest.current;
      if (options.soundEnabled) void playAttentionSound(kind, options.soundVolume,
        () => active && latest.current.soundEnabled && latest.current.soundVolume === options.soundVolume);
    });
    store.onAttention = (id, kind) => {
      const options = latest.current;
      const pane = options.workspace.panes[id];
      const now = Date.now();
      if (!pane || now - (sent.current.get(id) ?? -Infinity) < PANE_COOLDOWN_MS) return;
      sent.current.set(id, now);
      if (options.enabled) {
        const { title, body } = attentionNotification(kind, pane, options.projects);
        void api.notify(title, body, id, options.soundEnabled).catch(() => {});
      }
      if (options.soundEnabled) burst.enqueue(kind);
    };
    return () => { active = false; burst.cancel(); store.onAttention = undefined; };
  }, [store, enabled, soundEnabled]);
  useEffect(() => {
    if (!soundEnabled || !isDesktop()) return;
    window.addEventListener('pointerdown', unlockAttentionAudio);
    window.addEventListener('keydown', unlockAttentionAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAttentionAudio);
      window.removeEventListener('keydown', unlockAttentionAudio);
    };
  }, [soundEnabled]);
  return null;
}
