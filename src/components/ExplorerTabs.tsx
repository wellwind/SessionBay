import { useRef } from 'react';
import { ArrowLeft, ArrowRight, Pin, X } from 'lucide-react';
import { FileIcon } from './ExplorerTree';
import type { FileTabs, TabAction } from './explorer-model';
export function ExplorerTabs({ state, dispatch, close }: { state: FileTabs; dispatch: (action: TabAction) => void; close: (path: string) => void }) {
  const dragged = useRef('');
  const move = (delta: number) => {
    const index = state.tabs.findIndex(tab => tab.path === state.active); const target = state.tabs[index + delta];
    if (target) dispatch({ type: 'move', path: state.active, target: target.path });
  };
  return <>
    <div className="explorer-tabs" role="tablist" aria-label="唯讀檔案分頁" onKeyDown={event => {
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus(); tabs[next].click();
      } else if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); close(state.tabs[index].path); }
    }}>
      {state.tabs.map(tab => <div key={tab.path} className={`explorer-tab${state.active === tab.path ? ' active' : ''}${tab.pinned ? ' pinned' : ' preview'}`} draggable
        onDragStart={event => { dragged.current = tab.path; event.dataTransfer.setData('application/x-sessionbay-file-tab', tab.path); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { dragged.current = ''; }} onDragOver={event => { if (dragged.current) event.preventDefault(); }}
        onDrop={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dispatch({ type: 'move', path: dragged.current, target: tab.path }); dragged.current = ''; } }}>
        <button role="tab" aria-selected={state.active === tab.path} tabIndex={state.active === tab.path ? 0 : -1} title={tab.path} onClick={() => dispatch({ type: 'open', path: tab.path })} onDoubleClick={() => dispatch({ type: 'open', path: tab.path, pinned: true })}><FileIcon path={tab.path} /><span>{tab.path.split('/').pop()}</span>{tab.pinned ? <Pin size={12} aria-label="已固定" /> : <small>預覽</small>}</button>
        <button aria-label={`關閉檔案 ${tab.path}`} title="關閉檔案分頁" onClick={() => close(tab.path)}><X size={13} /></button>
      </div>)}
    </div>
    {state.active && <div className="explorer-tab-actions"><button aria-label="固定目前檔案" disabled={state.tabs.find(tab => tab.path === state.active)?.pinned} onClick={() => dispatch({ type: 'open', path: state.active, pinned: true })}><Pin size={13} />固定</button><span />
      <button aria-label="檔案分頁往前移" disabled={state.tabs[0]?.path === state.active} onClick={() => move(-1)}><ArrowLeft size={13} /></button><button aria-label="檔案分頁往後移" disabled={state.tabs.at(-1)?.path === state.active} onClick={() => move(1)}><ArrowRight size={13} /></button></div>}
  </>;
}
