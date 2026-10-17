import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
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
  const dragging = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean; button: HTMLButtonElement } | null>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const helpId = useId();
  const cancel = () => {
    const drag = dragging.current;
    dragging.current = null;
    if (drag?.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
    setDrop(null);
  };
  const targetAt = (event: PointerEvent<HTMLButtonElement>) => {
    const source = tabs.find(tab => tab.id === dragging.current?.id);
    if (!source) return null;
    // Offscreen flex children retain rectangles beyond the scrolling strip.
    // Reject that clipped geometry before considering any tab as a drop target.
    const strip = dragging.current?.button.closest('.workspace-tabs')?.getBoundingClientRect();
    if (strip && (event.clientX < strip.left || event.clientX >= strip.right || event.clientY < strip.top || event.clientY >= strip.bottom)) return null;
    // Pointer capture retargets events, but hit testing still identifies the visible control.
    // Sticky controls can cover an otherwise valid tab rectangle inside the strip.
    const canHitTest = typeof document.elementFromPoint === 'function';
    const hit = canHitTest ? document.elementFromPoint(event.clientX, event.clientY) : null;
    if (canHitTest && !hit) return null;
    for (const tab of tabs) {
      if (tab.projectId !== source.projectId) continue;
      const element = tabElements.current.get(tab.id);
      if (canHitTest && (!hit || !element?.contains(hit))) continue;
      const rect = element?.getBoundingClientRect();
      if (rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
        return { id: tab.id, after: event.clientX >= rect.left + rect.width / 2 };
    }
    return null;
  };
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
      ref={element => { if (element) tabElements.current.set(tab.id, element); else tabElements.current.delete(tab.id); }}>
      <button className="workspace-tab-select" aria-current={tab.id === activeId ? 'true' : undefined} aria-describedby={helpId}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        title={`${tab.name} · 第 ${index + 1} 個分頁；拖曳或 Alt+←／→ 排序`}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary || dragging.current) return;
          suppressClick.current = false;
          dragging.current = { id: tab.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button: event.currentTarget };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragging.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
          drag.moved = true;
          suppressClick.current = true;
          setDrop(targetAt(event));
        }}
        onPointerUp={event => {
          const drag = dragging.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const target = drag.moved ? targetAt(event) : null;
          if (target) move(drag.id, target.id, target.after);
          cancel();
        }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onDragStart={event => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          const next = tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (next) move(tab.id, next.id, event.key === 'ArrowRight');
        }} onClick={event => {
          if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
          onSelect(tab);
        }}>
        <TerminalSquare size={13} /><span className="workspace-tab-name">{tab.name}</span>
        <span>{paneIds(tab.layout).length}</span>
      </button>
      <button aria-label={`重新命名分頁 ${tab.name}`} title="重新命名分頁" onClick={(event) => { event.currentTarget.focus(); onRename(tab); }}><Pencil size={13} /></button>
      <button aria-label={`關閉分頁 ${tab.name}`} onClick={() => onClose(tab)}><X size={12} /></button>
    </div>)}
  </>;
}
