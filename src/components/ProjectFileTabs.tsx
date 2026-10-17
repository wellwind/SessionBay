import { useRef } from 'react';
import { Pin, X } from 'lucide-react';
import { FileIcon } from './ExplorerTree';
import type { FileTabs, TabAction } from './explorer-model';

export function ProjectFileTabs({ state, active, dispatch, close }: {
  state: FileTabs; active: boolean; dispatch: (action: TabAction) => void; close: (path: string) => void;
}) {
  const dragged = useRef('');
  return <div className="project-file-tabs explorer" role="tablist" aria-label="唯讀檔案分頁" onKeyDown={event => {
    if (document.querySelector('[role="dialog"], dialog[open]') || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const target = state.tabs[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (target) dispatch({ type: 'move', path: state.tabs[index].path, target: target.path });
    } else if (!event.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    } else if (!event.altKey && event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); close(state.tabs[index].path); }
  }}>
    {state.tabs.map(tab => <div key={tab.path} className={`project-file-tab${active && state.active === tab.path ? ' active' : ''}${tab.pinned ? ' pinned' : ' preview'}`} draggable
      onDragStart={event => { event.stopPropagation(); dragged.current = tab.path; event.dataTransfer.clearData(); event.dataTransfer.setData('application/x-sessionbay-file-tab', 'internal'); event.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={event => { event.stopPropagation(); dragged.current = ''; }}
      onDragOver={event => { event.stopPropagation(); if (dragged.current) event.preventDefault(); }}
      onDrop={event => { event.stopPropagation(); if (dragged.current) { event.preventDefault(); dispatch({ type: 'move', path: dragged.current, target: tab.path }); dragged.current = ''; } }}>
      <button role="tab" aria-selected={active && state.active === tab.path} tabIndex={state.active === tab.path ? 0 : -1} title={tab.path}
        onClick={() => dispatch({ type: 'open', path: tab.path })} onDoubleClick={() => dispatch({ type: 'open', path: tab.path, pinned: true })}>
        <FileIcon path={tab.path} /><span>{tab.path.split('/').pop()}</span>{tab.pinned && <Pin size={12} aria-label="已固定" />}
      </button>
      <button aria-label={`關閉檔案 ${tab.path}`} title="關閉檔案分頁" onClick={() => close(tab.path)}><X size={13} /></button>
    </div>)}
  </div>;
}
