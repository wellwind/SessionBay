import { useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Pane, RuntimeInfo, Settings, Workspace } from '../types';
import { layoutRects } from '../workspace';
import type { Divider } from '../workspace';
import { TerminalPane } from './TerminalPane';
export function WorkspaceCanvas({
  workspace,
  knownProjectIds,
  activeTabId,
  settings,
  visible,
  maximizedId,
  onPatch,
  onFocus,
  onStart,
  onClose,
  onMaximize,
  onSplit,
  onRatio,
  onAlreadyOpen,
}: {
  workspace: Workspace;
  knownProjectIds: string[];
  activeTabId?: string;
  settings: Settings;
  visible: boolean;
  maximizedId: string | null;
  onPatch: (id: string, patch: Partial<Pane>) => void;
  onFocus: (id: string) => void;
  onStart: (id: string) => void;
  onClose: (id: string) => void;
  onMaximize: (id: string) => void;
  onSplit: (id: string, axis: 'horizontal' | 'vertical') => void;
  onRatio: (id: string, ratio: number) => void;
  onAlreadyOpen: (paneId: string, info: RuntimeInfo) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const tab = workspace.tabs.find((t) => t.id === activeTabId);
  const geometry = tab ? layoutRects(tab.layout) : { panes: {}, dividers: [] };
  const drag = (event: PointerEvent<HTMLDivElement>, divider: Divider) => {
    if (!root.current) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const rect = root.current.getBoundingClientRect();
    const move = (e: globalThis.PointerEvent) => {
      const value =
        divider.axis === 'horizontal'
          ? (((e.clientX - rect.left) / rect.width) * 100 - divider.bounds.left) /
            divider.bounds.width
          : (((e.clientY - rect.top) / rect.height) * 100 - divider.bounds.top) /
            divider.bounds.height;
      onRatio(divider.id, value);
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  };
  return (
    <div
      className={`workspace-canvas${tab?.layout.kind === 'pane' ? ' single-pane' : ''}`}
      style={{ display: visible ? undefined : 'none' }}
      aria-label="開發工作區"
    >
      <div className="workspace-canvas-body">
      <div className="workspace-terminal-surface" ref={root}>
      {Object.values(workspace.panes).map((pane) => {
        const rect = geometry.panes[pane.id];
        const show = visible && !!rect && (!maximizedId || maximizedId === pane.id);
        const style: CSSProperties = show
          ? {
              left: maximizedId ? 0 : `${rect.left}%`,
              top: maximizedId ? 0 : `${rect.top}%`,
              width: maximizedId ? '100%' : `${rect.width}%`,
              height: maximizedId ? '100%' : `${rect.height}%`,
            }
          : { display: 'none' };
        return (
          <div className="pane-position" key={pane.id} style={style}>
            <TerminalPane
              pane={pane}
              projectAvailable={pane.projectId !== null && knownProjectIds.includes(pane.projectId)}
              settings={settings}
              visible={show}
              activityVisible={visible && !!rect}
              focused={tab?.focusedPaneId === pane.id}
              maximized={maximizedId === pane.id}
              onPatch={onPatch}
              onFocus={() => onFocus(pane.id)}
              onStart={() => onStart(pane.id)}
              onClose={() => onClose(pane.id)}
              onMaximize={() => onMaximize(pane.id)}
              onSplit={(axis) => onSplit(pane.id, axis)}
              onAlreadyOpen={(info) => onAlreadyOpen(pane.id, info)}
            />
          </div>
        );
      })}
      {!maximizedId &&
        geometry.dividers.map((divider) => (
          <div
            key={divider.id}
            role="separator"
            aria-label={divider.axis === 'horizontal' ? '左右面板比例' : '上下面板比例'}
            aria-orientation={divider.axis === 'horizontal' ? 'vertical' : 'horizontal'}
            aria-valuenow={Math.round(divider.ratio * 100)}
            aria-valuemin={15}
            aria-valuemax={85}
            tabIndex={0}
            className={`split-divider ${divider.axis}`}
            style={{
              left: `${divider.left}%`,
              top: `${divider.top}%`,
              width: divider.axis === 'horizontal' ? undefined : `${divider.width}%`,
              height: divider.axis === 'vertical' ? undefined : `${divider.height}%`,
            }}
            onPointerDown={(event) => drag(event, divider)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                onRatio(
                  divider.id,
                  divider.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -0.05 : 0.05),
                );
              }
            }}
          />
        ))}
      </div>
      </div>
    </div>
  );
}
