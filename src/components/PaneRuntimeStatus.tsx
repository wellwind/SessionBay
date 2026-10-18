import { useSyncExternalStore } from 'react';
import type { Pane } from '../types';
import { paneRuntimeStatusText } from '../pane-runtime-status';
import { useRuntimeActivity } from './RuntimeActivity';

const noopSubscribe = () => () => {};
// Subscribe only this small label, not the terminal, to the existing store.
// Its expiry and lease invalidation also clear this text; no polling is added.
export function PaneRuntimeStatus({ pane, connecting }: { pane: Pane; connecting: boolean }) {
  const store = useRuntimeActivity();
  const observation = useSyncExternalStore(store?.subscribe ?? noopSubscribe,
    () => store?.paneAgentState(pane.id, pane.runtimeId) ?? '', () => '');
  const text = paneRuntimeStatusText(pane, connecting, observation);
  return text ? <span className="pane-runtime-status" title={text}>{text}</span> : null;
}
