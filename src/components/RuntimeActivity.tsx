import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CheckCircle2, LoaderCircle, OctagonAlert, Unplug } from 'lucide-react';
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
  const states = ids.flatMap(id => panes[id] ? [panes[id].state] : []);
  const attention = states.some(state => state === 'failed' || state === 'interrupted');
  const disconnected = states.includes('disconnected');
  const ended = states.length > 0 && states.every(state => state === 'exited');
  const recent = bits[0] === '1', unread = bits[1] === '1', connecting = bits[2] === '1';
  const label = [tabRuntimeSummary(tab, panes), recent ? '有新輸出' : '', unread ? '未讀輸出' : '', connecting ? '正在連線' : ''].filter(Boolean).join(' · ');
  const Icon = attention ? OctagonAlert : ended ? CheckCircle2 : connecting ? LoaderCircle : disconnected ? Unplug : null;
  // Keep lifecycle descriptions available without inventing an unknown activity icon.
  if (!Icon && !recent && !unread) return <span id={id} className="organization-sr-only">{label}</span>;
  return <span id={id} className={`runtime-activity${attention ? ' attention' : ''}`} role="img" aria-label={label} title={label}>
    {Icon && <Icon size={12} aria-hidden="true" className={connecting && !attention && !ended ? 'runtime-connecting' : undefined} />}
    {(recent || unread) && <span aria-hidden="true" className={`runtime-output-dot${recent ? ' recent' : ''}${unread ? ' unread' : ''}`} />}
  </span>;
}
