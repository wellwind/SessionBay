import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api';
import { t } from '../i18n';
import { paneRuntimeStatusText } from '../pane-runtime-status';
import { paneAttention } from '../workspace-overview';
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanSession, Pane, Workspace } from '../types';
import { useRuntimeActivity } from './RuntimeActivity';

export const columnName = (column: KanbanColumn) => column.name ?? t(column.defaultName ?? 'Untitled column');
export const cardTitle = (card: KanbanCard) => card.title || t('Untitled task');
export const ordered = <T extends { position: number }>(items: T[]) => [...items].sort((a, b) => a.position - b.position);
const noopSubscribe = () => () => {};
function sessionPane(link: KanbanSession, panes: Pane[]) {
  const session = link.session;
  return panes.find(pane => pane.sessionId === session.id) ?? panes.find(pane =>
    !pane.sessionId && pane.kind === session.kind && (pane.resumeId === session.externalId || pane.providerSessionId === session.externalId) && pane.cwd === session.cwd);
}


/** One catalog reader/mutation lock for both board surfaces, shared by their owner. */
export function useKanbanBoards(workspace: Workspace, projectId?: string, eligible = true, refreshToken = 0) {
  const [snapshots, setSnapshots] = useState<KanbanBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), mutationGeneration = useRef(0), generation = useRef(0), alive = useRef(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcementOrigin, setAnnouncementOrigin] = useState<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const scope = useRef(projectId);
  scope.current = projectId;
  const load = useCallback(async () => {
    if (!projectId) return api.listKanbanBoards();
    const board = await api.kanbanBoard(projectId);
    return board ? [board] : [];
  }, [projectId]);
  const read = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await load();
      if (alive.current && generation.current === current) { setSnapshots(next); setError(''); }
    } catch (cause) {
      if (alive.current && generation.current === current) setError(errorMessage(cause));
    } finally {
      if (alive.current && generation.current === current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    alive.current = true;
    setSnapshots([]); setLoading(true); setSelectedId(null); setError(''); setAnnouncement('');
    lock.current = false; setBusy(false); mutationGeneration.current++; generation.current++;
    return () => { alive.current = false; };
  }, [projectId]);
  useEffect(() => {
    if (!eligible) { setLoading(false); return; }
    if (!lock.current) void read();
    const refresh = () => { if (!lock.current && document.visibilityState !== 'hidden') void read(); };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [eligible, read, refreshToken]);
  const mutate = async (action: () => Promise<unknown>, message?: string, focusCard?: string, origin?: HTMLElement | null) => {
    if (lock.current || !eligible) return false;
    const mutationScope = projectId, mutationId = ++mutationGeneration.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedDialog = focused?.closest<HTMLElement>('[role="dialog"]');
    const surface = focused?.closest('[data-kanban-surface]') ?? document;
    lock.current = true;
    generation.current++;
    setBusy(true); setError('');
    try {
      await action();
      if (!alive.current || scope.current !== mutationScope) return false;
      const next = await load();
      if (!alive.current || scope.current !== mutationScope) return false;
      setSnapshots(next);
      if (message) {
        setAnnouncement(message);
        setAnnouncementOrigin(origin ?? focused?.closest<HTMLElement>('[data-kanban-surface]') ?? null);
      }
      return true;
    } catch (cause) {
      if (alive.current && scope.current === mutationScope) setError(errorMessage(cause));
      return false;
    } finally {
      if (alive.current && mutationGeneration.current === mutationId) {
        lock.current = false;
        setBusy(false);
        requestAnimationFrame(() => {
          if (scope.current !== mutationScope || mutationGeneration.current !== mutationId) return;
          if (document.activeElement !== focused && document.activeElement !== document.body) return;
          const card = focusCard && !focusedDialog ? [...surface.querySelectorAll<HTMLElement>('[data-kanban-card]')]
            .find(element => element.dataset.kanbanCard === focusCard) : null;
          if (card && !card.closest('[hidden]')) card.querySelector<HTMLElement>(focused?.classList.contains('kanban-card-handle') ? '.kanban-card-handle' : '.kanban-card-open')?.focus();
          else if (focused?.isConnected && !focused.matches(':disabled') && !focused.closest('[hidden]')) focused.focus();
          else if (focusedDialog?.isConnected) focusedDialog.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')?.focus();
          else surface.querySelector<HTMLElement>('.board-group-toggle, .kanban-toolbar input')?.focus();
        });
      }
    }
  };
  const store = useRuntimeActivity();
  const panes = Object.values(workspace.panes);
  const observed = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => panes.map(pane => store?.paneAgentState(pane.id, pane.runtimeId) ?? '').join('\u0001'), () => '');
  const states = observed.split('\u0001');
  const status = (link: KanbanSession) => {
    const pane = sessionPane(link, panes);
    const observations = pane ? (states[panes.indexOf(pane)] ?? '').split('|') : [];
    const kind = pane ? paneAttention(pane, observations) : 'other';
    const text = pane ? observations.map(value => paneRuntimeStatusText(pane, false, value)).find(Boolean)
      || paneRuntimeStatusText(pane, false, '') || t('Running') : t('Not running');
    const shortText = !pane ? t('Not running') : kind === 'input' ? t('Waiting for input') : kind === 'error' ? t('Needs attention')
      : kind === 'working' ? t('Working') : kind === 'idle' ? t('Idle') : kind === 'ended' ? t('Ended') : t('Preparing');
    return { text, shortText, attention: kind === 'input' || kind === 'error', kind };
  };

  const [undo, setUndo] = useState<{ message: string; action: () => Promise<unknown>; origin: HTMLElement | null } | null>(null);
  useEffect(() => { setUndo(null); }, [projectId]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [undo]);
  const move = async (card: KanbanCard, column: KanbanColumn, position: number, origin?: HTMLElement | null) => {
    if (await mutate(() => api.moveKanbanCard(card.id, column.id, position),
      t('Moved "{{title}}" to {{column}}, position {{position}}.', { title: cardTitle(card), column: columnName(column), position: position + 1 }), card.id, origin)) {
      setUndo({ message: t('Moved to {{column}}', { column: columnName(column) }), action: () => api.moveKanbanCard(card.id, card.columnId, card.position), origin: origin ?? null });
    }
  };
  const archive = async (id: string, origin?: HTMLElement | null) => {
    const success = await mutate(() => api.archiveKanbanCard(id, true));
    if (success) setUndo({ message: t('Archived'), action: () => api.archiveKanbanCard(id, false), origin: origin ?? null });
    return success;
  };
  const undoLast = async () => { if (undo && await mutate(undo.action)) setUndo(null); };
  const attentionCount = snapshots.filter(board => board.enabled).flatMap(board => board.cards)
    .filter(card => !card.archived && card.sessions.some(link => status(link).attention)).length;
  return { selectedId, setSelectedId, snapshots, loading, error, busy, lock, announcement, announcementOrigin, read, mutate, status, move, archive, undo, undoLast, attentionCount };
}
export type KanbanBoards = ReturnType<typeof useKanbanBoards>;
