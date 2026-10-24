import { GitBranch, GitCompare, GitPullRequest, History, ScrollText, Swords, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GitDocument, GitDocuments } from './git-documents';
import { documentTitle } from './git-documents';

const icons: Record<GitDocument['spec']['kind'], LucideIcon> = {
  diff: GitCompare, comparison: GitCompare, graph: GitBranch, blame: ScrollText, fileHistory: History, conflict: Swords, pullRequest: GitPullRequest,
};

/** Central Git view tabs; titles carry the repository for disambiguation. */
export function GitDocumentTabs({ state, active, onActivate, onClose }: {
  state: GitDocuments; active: boolean; onActivate: (key: string) => void; onClose: (key: string) => void;
}) {
  return <div className="project-file-tabs git-tabs" role="tablist" aria-label="Git 檢視分頁" onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    } else if (event.key === 'Delete') { event.preventDefault(); onClose(state.documents[index].key); }
  }}>
    {state.documents.map(document => {
      const Icon = icons[document.spec.kind];
      const selected = active && state.active === document.key;
      const title = documentTitle(document);
      return <div key={document.key} className={`project-file-tab${selected ? ' active' : ''}`}>
        <button role="tab" aria-selected={selected} tabIndex={state.active === document.key ? 0 : -1}
          title={`${document.repoName} · ${title}`} onClick={() => onActivate(document.key)}>
          <Icon size={13} aria-hidden="true" /><span>{title}</span><span className="git-tab-repo">{document.repoName}</span>
        </button>
        <button aria-label={`關閉 ${title}（${document.repoName}）`} title="關閉 Git 分頁" onClick={() => onClose(document.key)}><X size={13} /></button>
      </div>;
    })}
  </div>;
}
