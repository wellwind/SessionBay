import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Folder, GripVertical } from 'lucide-react';
import { useAnimatedReorder } from './useAnimatedReorder';
import './workspace-organization.css';
import { ProjectRuntimeTabs } from './ProjectRuntimeTabs';
import { projectRuntimeSummary } from '../project-runtime';
import type { Project, Workspace } from '../types';

export function SidebarProjectList({ projects, selectedId, label, reorderable, onSelect, onReorder, empty, workspace, activeTabId, onFocus }: {
  projects: Project[]; selectedId: string | null | undefined; label: string; reorderable: boolean;
  onSelect: (project: Project) => void; onReorder: (id: string, target: string, after: boolean) => void; empty: string;
  workspace?: Workspace; activeTabId?: string; onFocus?: (paneId: string) => void;
}) {
  const disclosureId = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const helpId = useId();
  const [announcement, setAnnouncement] = useState('');
  const move = (id: string, target: string, after: boolean) => {
    if (!reorderable || id === target || !projects.some(p => p.id === id) || !projects.some(p => p.id === target)) return;
    onReorder(id, target, after);
    setAnnouncement(`已移動「${projects.find(p => p.id === id)!.name}」的專案順序。`);
  };
  const reorder = useAnimatedReorder(projects, 'y', '.project-list', move);
  return <nav className="project-list" aria-label={label}>
    {reorderable && <span className="organization-sr-only" id={helpId}>拖曳排序；聚焦排序把手後按 Alt 加上／下方向鍵移動，拖曳時按 Escape 取消。</span>}
    <span className="organization-sr-only" role="status">{announcement}</span>
    {projects.map((project, index) => {
      const tabs = workspace?.tabs.filter(tab => tab.projectId === project.id) ?? [];
      const expanded = !collapsed.has(project.id);
      const contentId = `${disclosureId}-${index}`;
      return <div key={project.id} className={`project-group ${reorder.className(project.id)}`}
        style={reorder.style(project.id)} ref={element => reorder.ref(project.id, element)}><div
        className={`project-row ${selectedId === project.id ? 'active' : ''}`}
        ref={element => reorder.targetRef(project.id, element)}>
      {reorderable && <button className="project-drag" aria-label={`排序 ${project.name}`} title="拖曳排序；Alt＋上／下方向鍵移動"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-describedby={helpId}
        {...reorder.handlers(project.id)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const after = event.key === 'ArrowDown'; const target = projects[index + (after ? 1 : -1)];
          if (target) move(project.id, target.id, after);
        }}><GripVertical size={14} /></button>}
      {!!tabs.length && <button className="project-runtime-toggle" aria-label={`${expanded ? '收合' : '展開'} ${project.name} 的分頁`}
        aria-expanded={expanded} aria-controls={contentId} onClick={() => setCollapsed(previous => {
          const next = new Set(previous); if (expanded) next.add(project.id); else next.delete(project.id); return next;
        })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
      <button className="project-main" aria-current={selectedId === project.id ? 'true' : undefined} onClick={() => onSelect(project)} title={project.path ?? '未分類'}>
        <Folder size={17} /><span><strong>{project.name}</strong><small>{project.workspaceOnly ? `僅工作區 · ${project.path || '目錄待確認'}` : project.path || '工作目錄未知'}</small><span className="project-runtime-summary" aria-hidden={!tabs.length}>{tabs.length && workspace ? projectRuntimeSummary(tabs, workspace.panes) : ''}</span></span>
        <span className="project-count">{project.sessionCount}</span>{!project.exists && <AlertTriangle className="warning-icon" size={13} />}
      </button>

    </div>{!!tabs.length && workspace && onFocus && <div hidden={!expanded} id={contentId}>
      <ProjectRuntimeTabs tabs={tabs} panes={workspace.panes} activeId={activeTabId} onFocus={onFocus} projectName={project.name} />
    </div>}</div>;
    })}
    {!projects.length && <p className="sidebar-empty">{empty}</p>}
  </nav>;
}
