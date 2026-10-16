import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, TerminalSquare, X } from 'lucide-react';
import type { WorkspaceTab } from '../types';
import { paneIds } from '../workspace';
import './workspace-organization.css';

export function WorkspaceTabs({ tabs, activeId, onSelect, onRename, onClose, onReorder }: {
  tabs: WorkspaceTab[];
  activeId?: string;
  onSelect: (tab: WorkspaceTab) => void;
  onRename: (tab: WorkspaceTab) => void;
  onClose: (tab: WorkspaceTab) => void;
  onReorder: (id: string, targetId: string, after: boolean) => void;
}) {
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const helpId = useId();
  const cancel = () => { dragging.current = null; setDrop(null); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); };
  }, []);
  const move = (id: string, targetId: string, after: boolean) => {
    const source = tabs.find((tab) => tab.id === id);
    const target = tabs.find((tab) => tab.id === targetId);
    if (!source || !target || source.id === target.id || source.projectId !== target.projectId) return;
    const remaining = tabs.filter((tab) => tab.id !== id);
    const position = remaining.findIndex((tab) => tab.id === targetId) + Number(after);
    onReorder(id, targetId, after);
    setAnnouncement(`已將「${source.name}」移至第 ${position + 1} 個分頁，共 ${tabs.length} 個。`);
  };
  return <>
    <span className="organization-sr-only" id={helpId}>可拖曳分頁排序；聚焦分頁後按 Alt 加左／右方向鍵移動。名稱相同時可依目前順序分辨。</span>
    <span className="organization-sr-only" role="status" aria-live="polite">{announcement}</span>
    {tabs.map((tab, index) => <div key={tab.id}
      className={`workspace-tab ${tab.id === activeId ? 'active' : ''} ${drop?.id === tab.id ? (drop.after ? 'drop-after' : 'drop-before') : ''}`}
      onDragOver={(event) => {
        const source = tabs.find((item) => item.id === dragging.current);
        if (!source || source.projectId !== tab.projectId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        setDrop({ id: tab.id, after: event.clientX >= rect.left + rect.width / 2 });
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null);
      }}
      onDrop={(event) => {
        const id = dragging.current;
        if (!id) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        move(id, tab.id, event.clientX >= rect.left + rect.width / 2);
        cancel();
      }}>
      <button className="workspace-tab-select" draggable aria-describedby={helpId}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        title={`${tab.name} · 第 ${index + 1} 個分頁；拖曳或 Alt+←／→ 排序`}
        onDragStart={(event) => {
          dragging.current = tab.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', tab.id);
        }} onDragEnd={cancel}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          const next = tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (next) move(tab.id, next.id, event.key === 'ArrowRight');
        }} onClick={() => onSelect(tab)}>
        <TerminalSquare size={13} /><span className="workspace-tab-name">{tab.name}</span>
        <span>{paneIds(tab.layout).length}</span>
      </button>
      <button aria-label={`重新命名分頁 ${tab.name}`} title="重新命名分頁" onClick={() => onRename(tab)}><Pencil size={13} /></button>
      <button aria-label={`關閉分頁 ${tab.name}`} onClick={() => onClose(tab)}><X size={12} /></button>
    </div>)}
  </>;
}
