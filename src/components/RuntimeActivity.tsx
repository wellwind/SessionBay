import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Activity, CheckCircle2, Hand, LoaderCircle, MessageCircle, OctagonAlert, Unplug } from 'lucide-react';
import { RuntimeActivityStore } from '../runtime-activity';
import { tabRuntimeSummary } from '../project-runtime';
import { paneIds } from '../workspace';
import type { Workspace, WorkspaceTab } from '../types';
import './project-runtime.css';
const Context = createContext<RuntimeActivityStore | null>(null);
export const useRuntimeActivity = () => useContext(Context);
export function RuntimeActivityProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new RuntimeActivityStore());
  const [lifetime] = useState(() => ({ generation: 0 }));
  useEffect(() => {
    const current = ++lifetime.generation;
    const blur = () => store.setForeground(false);
    const update = () => store.setForeground(document.visibilityState === 'visible' && document.hasFocus());
    update();
    window.addEventListener('focus', update); window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update); window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', update);
      // Strict Mode immediately replays setup; dispose only after a genuine unmount.
      queueMicrotask(() => { if (lifetime.generation === current) store.dispose(); });
    };
  }, [store, lifetime]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
const noopSubscribe = () => () => {};
export function RuntimeActivityIndicator({ tab, panes, id }: { tab: WorkspaceTab; panes: Workspace['panes']; id?: string }) {
  const store = useRuntimeActivity();
  const ids = paneIds(tab.layout);
  const bits = useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.snapshot(ids) ?? '000', () => '000');
  const observation = useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.agentSnapshot(ids) ?? '', () => '');
  const agentStates = useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.agentStates(ids) ?? '', () => '').split('|');
  const busy = agentStates.includes('busy') || agentStates.includes('retry') || agentStates.includes('terminalWorking');
  const permission = agentStates.includes('awaitingPermission') || agentStates.includes('terminalPermission');
  const input = agentStates.includes('awaitingInput') || agentStates.some(state => ['terminalQuestion', 'terminalAuthentication', 'terminalBlocked'].includes(state));
  const idle = agentStates.includes('idle') || agentStates.includes('terminalIdle') || agentStates.includes('terminalDone');
  const states = ids.flatMap(id => panes[id] ? [panes[id].state] : []);
  const attention = states.some(state => state === 'failed' || state === 'interrupted') || agentStates.some(state => state === 'failed' || state === 'interrupted' || state === 'terminalError');
  const disconnected = states.includes('disconnected');
  const ended = states.length > 0 && states.every(state => state === 'exited');
  const recent = bits[0] === '1', unread = bits[1] === '1', connecting = bits[2] === '1';
  const label = [tabRuntimeSummary(tab, panes), recent ? '有新輸出' : '', unread ? '未讀輸出' : '', connecting ? '正在連線' : '', observation ? `Agent 最近回報：${observation}` : ''].filter(Boolean).join(' · ');
  const Icon = attention ? OctagonAlert : ended ? CheckCircle2 : connecting ? LoaderCircle : disconnected ? Unplug : permission ? Hand : input ? MessageCircle : busy ? LoaderCircle : idle ? CheckCircle2 : observation ? Activity : null;
  // Keep lifecycle descriptions available without inventing an unknown activity icon.
  if (!Icon && !recent && !unread) return <span id={id} className="organization-sr-only">{label}</span>;
  return <span id={id} className={`runtime-activity${!Icon ? ' output-only' : ''}${attention || permission || input ? ' attention' : ''}${busy && !attention && !disconnected && !permission && !input ? ' agent-working' : ''}`} role="img" aria-label={label} title={label}>
    {Icon && <Icon size={12} aria-hidden="true" className={(connecting || busy) && !attention && !ended && !disconnected && !permission && !input ? 'runtime-connecting' : undefined} />}
    {(recent || unread) && <span aria-hidden="true" className={`runtime-output-dot${recent ? ' recent' : ''}${unread ? ' unread' : ''}`} />}
  </span>;
}
