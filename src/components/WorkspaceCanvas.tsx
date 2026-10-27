import { useMemo, useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Pane, Project, RuntimeInfo, Settings, Workspace } from '../types';
import { layoutRects, paneIds } from '../workspace';
import { projectColor, projectColorSlots, projectInitials } from '../project-identity';
import { usePaneBranches } from '../use-pane-branches';
import type { Divider } from '../workspace';
import type { TerminalFileOpen } from '../terminal-file-links';
import { TerminalPane } from './TerminalPane';
import { t } from '../i18n';
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
  onOpenFileLink,
  projects = [],
  onMoveHome,
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
  onOpenFileLink?: (paneId: string, request: TerminalFileOpen) => void;
  projects?: Project[];
  onMoveHome?: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const tab = workspace.tabs.find((t) => t.id === activeTabId);
  // Mixed tabs label every pane with its own project; branches are read only while shown.
  const mixedPanes = useMemo(() => tab?.mixed ? paneIds(tab.layout).flatMap((id) => workspace.panes[id] ? [workspace.panes[id]] : []) : [],
    [tab, workspace.panes]);
  const branches = usePaneBranches(mixedPanes.map((pane) => ({ paneId: pane.id, projectId: pane.projectId, cwd: pane.cwd })), visible && mixedPanes.length > 0);
  const colorSlots = useMemo(() => projectColorSlots(projects.map((project) => project.id)), [projects]);
  const identity = (pane: Pane) => {
    if (!mixedPanes.includes(pane)) return undefined;
    const name = pane.projectId === null ? t('Temporary terminal') : projects.find((project) => project.id === pane.projectId)?.name ?? t('Workspace-only project');
    return { initials: projectInitials(name), name, color: projectColor(pane.projectId, colorSlots), branch: branches[pane.id] };
  };
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
      aria-label={t('Development workspace')}
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
              onOpenFileLink={onOpenFileLink ? request => onOpenFileLink(pane.id, request) : undefined}
              identity={identity(pane)}
              onMoveHome={onMoveHome && mixedPanes.includes(pane) ? () => onMoveHome(pane.id) : undefined}
            />
          </div>
        );
      })}
      {!maximizedId &&
        geometry.dividers.map((divider) => (
          <div
            key={divider.id}
            role="separator"
            aria-label={divider.axis === 'horizontal' ? t('Left and right pane ratio') : t('Top and bottom pane ratio')}
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
