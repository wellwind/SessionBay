import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Pane, RuntimeInfo, Settings, Workspace } from '../types';
import { layoutRects } from '../workspace';
import type { Divider } from '../workspace';
import { Folder, X } from 'lucide-react';
import { WorkspaceFiles } from './WorkspaceFiles';
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
  const [fileTabs, setFileTabs] = useState<Record<string, boolean>>({});
  const [openedTabs, setOpenedTabs] = useState<Record<string, boolean>>({});
  const fileToggle = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const tab = workspace.tabs.find((t) => t.id === activeTabId);
  const canBrowse = !!tab?.projectId && knownProjectIds.includes(tab.projectId);
  const filesVisible = canBrowse && !!fileTabs[tab!.id];
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
      className="workspace-canvas"
      style={{ display: visible ? undefined : 'none' }}
      aria-label="開發工作區"
    >
      {canBrowse && <div className="workspace-files-toolbar"><button ref={fileToggle}
        aria-expanded={filesVisible} onClick={() => {
          setFileTabs((old) => ({ ...old, [tab!.id]: !old[tab!.id] }));
          setOpenedTabs((old) => ({ ...old, [tab!.id]: true }));
        }}><Folder size={14} />{filesVisible ? '隱藏檔案預覽' : '檔案預覽'}</button></div>}
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
      {workspace.tabs.filter((item) => openedTabs[item.id] && item.projectId !== null && knownProjectIds.includes(item.projectId)).map((item) =>
        <aside className="workspace-files-pane" key={`${item.id}:${item.projectId}`}
          style={{ display: filesVisible && item.id === tab?.id ? undefined : 'none' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setFileTabs((old) => ({ ...old, [item.id]: false }));
              fileToggle.current?.focus();
            }
          }}>
          <div className="workspace-files-heading"><strong>檔案預覽</strong><button aria-label="關閉檔案預覽" onClick={() => {
            setFileTabs((old) => ({ ...old, [item.id]: false }));
            fileToggle.current?.focus();
          }}><X size={14} /></button></div>
          <WorkspaceFiles projectId={item.projectId!} />
        </aside>)}
      </div>
    </div>
  );
}
