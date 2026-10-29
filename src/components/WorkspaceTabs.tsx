import { useId, useState } from 'react';
import { useActiveTabVisibility } from './useActiveTabVisibility';
import { useAnimatedReorder } from './useAnimatedReorder';
import { Pencil, TerminalSquare, X } from 'lucide-react';
import { RuntimeActivityIndicator } from './RuntimeActivity';
import './project-runtime.css';
import type { Workspace, WorkspaceTab } from '../types';
import { paneIds } from '../workspace';
import './workspace-organization.css';
import { t } from '../i18n';

export function WorkspaceTabs({ tabs, activeId, onSelect, onRename, onClose, onReorder, panes, mixedBadges }: {
  tabs: WorkspaceTab[];
  /** Project badges for mixed tabs; the tab is always labelled, never colour-only. */
  mixedBadges?: (tab: WorkspaceTab) => { initials: string; name: string; color: string }[];
  panes?: Workspace['panes'];
  activeId?: string;
  onSelect: (tab: WorkspaceTab) => void;
  onRename: (tab: WorkspaceTab) => void;
  onClose: (tab: WorkspaceTab) => void;
  onReorder: (id: string, targetId: string, after: boolean) => void;
}) {
  const [announcement, setAnnouncement] = useState('');
  const helpId = useId();
  const activeTab = useActiveTabVisibility(activeId);
  const move = (id: string, targetId: string, after: boolean) => {
    const source = tabs.find((tab) => tab.id === id);
    const target = tabs.find((tab) => tab.id === targetId);
    if (!source || !target || source.id === target.id || source.projectId !== target.projectId) return;
    const remaining = tabs.filter((tab) => tab.id !== id);
    const position = remaining.findIndex((tab) => tab.id === targetId) + Number(after);
    onReorder(id, targetId, after);
    setAnnouncement(t('Moved "{{name}}" to tab {{position}} of {{total}}.', { name: source.name, position: position + 1, total: tabs.length }));
  };
  const reorder = useAnimatedReorder(tabs.map(tab => ({ id: tab.id, group: tab.projectId })), 'x', '.workspace-tabs', move);
  return <>
    <span className="organization-sr-only" id={helpId}>{t('Drag tabs to reorder. Focus a tab and press Alt with the left or right arrow to move it. Tabs with the same name are told apart by their order.')}</span>
    <span className="organization-sr-only" role="status" aria-live="polite">{announcement}</span>
    {tabs.map((tab, index) => <div key={tab.id}
      className={`workspace-tab ${tab.id === activeId ? 'active' : ''} ${reorder.className(tab.id)}`}
      style={reorder.style(tab.id)} ref={element => { reorder.ref(tab.id, element); if (tab.id === activeId) activeTab.current = element; }}>
      <button className="workspace-tab-select" aria-current={tab.id === activeId ? 'true' : undefined} aria-label={`${tab.name} ${paneIds(tab.layout).length}`} aria-describedby={`${helpId}${panes ? ` ${helpId}-activity-${index}` : ''}`}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        title={tab.mixed && mixedBadges ? t('Mixed tab: {{names}}', { names: mixedBadges(tab).map((badge) => badge.name).join(t(', ')) }) : tab.name}
        {...reorder.handlers(tab.id)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          const next = tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)];
          if (next) move(tab.id, next.id, event.key === 'ArrowRight');
        }} onClick={event => {
          if (reorder.consumeClick(event.detail)) return;
          onSelect(tab);
        }}>
        {/* The lead groups status and tab icon so an unread-only dot badges the icon, not the button corner. */}
        <span className="workspace-tab-lead">
          {panes && <RuntimeActivityIndicator id={`${helpId}-activity-${index}`} tab={tab} panes={panes} />}
          {tab.mixed && mixedBadges ? <span className="mixed-chip" role="img" aria-label={t('Mixed: {{names}}', { names: mixedBadges(tab).map((badge) => badge.name).join(t(', ')) })}>
            {mixedBadges(tab).map((badge) => <span key={badge.name} className="project-initials" style={{ ['--pane-project' as string]: badge.color }}>{badge.initials}</span>)}
          </span> : <TerminalSquare size={13} />}
        </span><span className="workspace-tab-name">{tab.name}</span>
        <span>{paneIds(tab.layout).length}</span>
      </button>
      <button aria-label={t('Rename tab {{name}}', { name: tab.name })} title={t('Rename tab')} onClick={(event) => { event.currentTarget.focus(); onRename(tab); }}><Pencil size={13} /></button>
      <button aria-label={t('Close tab {{name}}', { name: tab.name })} onClick={() => onClose(tab)}><X size={12} /></button>
    </div>)}
  </>;
}
