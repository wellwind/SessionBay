import { useId } from 'react';
import { RuntimeActivityIndicator } from './RuntimeActivity';
import { tabRuntimeSummary } from '../project-runtime';
import type { Workspace, WorkspaceTab } from '../types';
import { paneIds } from '../workspace';
import './project-runtime.css';

export function ProjectRuntimeTabs({ tabs, panes, activeId, onFocus, id, projectName }: {
  tabs: WorkspaceTab[]; panes: Workspace['panes']; activeId?: string;
  onFocus: (paneId: string) => void; id?: string; projectName: string;
}) {
  const descriptionId = useId();
  return <ul className="project-runtime-tabs" id={id} aria-label="已開啟的分頁">
    {tabs.map((tab, index) => <li key={tab.id}>
      <button className={activeId === tab.id ? 'active' : ''} aria-current={activeId === tab.id ? 'page' : undefined}
        aria-label={`開啟工作區 ${projectName} ${tab.name}`} aria-describedby={`${descriptionId}-${index}`}
        title={`${tab.name} · ${tabRuntimeSummary(tab, panes)}`}
        onClick={() => {
          const ids = paneIds(tab.layout).filter(paneId => !!panes[paneId]);
          const target = ids.includes(tab.focusedPaneId) ? tab.focusedPaneId : ids[0];
          if (target) onFocus(target);
        }}>
        <RuntimeActivityIndicator id={`${descriptionId}-${index}`} tab={tab} panes={panes} />
        <span className="project-runtime-name"><strong>{tab.name}</strong><small>{tabRuntimeSummary(tab, panes)}</small></span>
        <span className="project-runtime-pane-count" aria-label={`${paneIds(tab.layout).length} 個面板`}>{paneIds(tab.layout).length}</span>
      </button>
    </li>)}
    {!tabs.length && <li className="sidebar-empty">沒有已開啟的分頁</li>}
  </ul>;
}
