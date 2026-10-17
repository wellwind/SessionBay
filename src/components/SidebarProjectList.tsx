import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Folder, GripVertical } from 'lucide-react';
import type { Project } from '../types';

export function SidebarProjectList({ projects, selectedId, label, reorderable, onSelect, onReorder, empty }: {
  projects: Project[]; selectedId: string | null | undefined; label: string; reorderable: boolean;
  onSelect: (project: Project) => void; onReorder: (id: string, target: string, after: boolean) => void; empty: string;
}) {
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const cancel = () => { dragging.current = null; setDrop(null); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); };
  }, []);
  const move = (id: string, target: string, after: boolean) => {
    if (!reorderable || id === target || !projects.some(p => p.id === id) || !projects.some(p => p.id === target)) return;
    onReorder(id, target, after);
    setAnnouncement(`已移動「${projects.find(p => p.id === id)!.name}」的專案順序。`);
  };
  return <nav className="project-list" aria-label={label}>
    <span className="organization-sr-only" role="status">{announcement}</span>
    {projects.map((project, index) => <div key={project.id}
      className={`project-row ${selectedId === project.id ? 'active' : ''} ${drop?.id === project.id ? (drop.after ? 'drop-after' : 'drop-before') : ''}`}
      onDragOver={event => {
        if (!reorderable || !dragging.current || !projects.some(p => p.id === dragging.current)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        setDrop({ id: project.id, after: event.clientY >= rect.top + rect.height / 2 });
      }} onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null);
      }} onDrop={event => {
        if (!dragging.current) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        move(dragging.current, project.id, event.clientY >= rect.top + rect.height / 2); cancel();
      }}>
      {reorderable && <button className="project-drag" draggable aria-label={`排序 ${project.name}`} title="拖曳排序；Alt＋上／下方向鍵移動"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onDragStart={event => { dragging.current = project.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', project.id); }} onDragEnd={cancel}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const after = event.key === 'ArrowDown'; const target = projects[index + (after ? 1 : -1)];
          if (target) move(project.id, target.id, after);
        }}><GripVertical size={14} /></button>}
      <button className="project-main" onClick={() => onSelect(project)} title={project.path ?? '未分類'}>
        <Folder size={17} /><span><strong>{project.name}</strong><small>{project.workspaceOnly ? `僅工作區 · ${project.path || '目錄待確認'}` : project.path || '工作目錄未知'}</small></span>
        <span className="project-count">{project.sessionCount}</span>{!project.exists && <AlertTriangle className="warning-icon" size={13} />}
      </button>
      {reorderable && <div className="project-move-buttons">
        <button aria-label={`上移 ${project.name}`} aria-disabled={index === 0} onClick={() => { if (index > 0) move(project.id, projects[index - 1].id, false); }}><ArrowUp size={12} /></button>
        <button aria-label={`下移 ${project.name}`} aria-disabled={index === projects.length - 1} onClick={() => { if (index < projects.length - 1) move(project.id, projects[index + 1].id, true); }}><ArrowDown size={12} /></button>
      </div>}
    </div>)}
    {!projects.length && <p className="sidebar-empty">{empty}</p>}
  </nav>;
}
