import { useMemo } from 'react';
import { agentNames } from '../agents';
import { agentCountText, agentLifecycleText, agentStatusGroups, countAgentStatuses } from '../agent-status';
import type { Project, Workspace } from '../types';
import './agent-status.css';
import { t } from '../i18n';

export function AgentStatusOverview({ workspace, projects, onFocus }: {
  workspace: Workspace;
  projects: Project[];
  onFocus: (paneId: string) => void;
}) {
  const groups = useMemo(() => agentStatusGroups(workspace), [workspace]);
  const total = countAgentStatuses(groups.flatMap((group) => group.agents));
  const scopes = [...projects.filter((project) => project.curated || groups.some((group) => group.projectId === project.id))
    .map((project) => ({ id: project.id as string | null, name: project.name })),
    ...groups.filter((group) => group.projectId !== null && !projects.some((project) => project.id === group.projectId))
      .map((group) => ({ id: group.projectId, name: t('Workspace-only project') })),
    { id: null, name: t('Global sessions') }];
  return <details className="agent-status-overview" open>
    <summary>{t('Agent status')} <span>{t('{{live}} alive / {{opened}} open', { live: total.live, opened: total.opened })}</span></summary>
    <div className="agent-status-content">
      {scopes.map((scope) => {
        const group = groups.find((item) => item.projectId === scope.id);
        const counts = group?.counts ?? countAgentStatuses([]);
        return <details key={scope.id ?? 'global'} className="agent-status-project">
          <summary><strong>{scope.name}</strong><span>{agentCountText(counts)}</span></summary>
          {group?.agents.length ? <ul>{group.agents.map((agent) => <li key={agent.key}>
            <button onClick={() => onFocus(agent.paneId)} title={agent.runtimeId ? `Runtime ${agent.runtimeId}` : t('No runtime yet')}>
              <span className="agent-status-title">{agentNames[agent.kind]} · {agent.title}</span>
              <span className={`agent-lifecycle ${agent.state}`}>{agentLifecycleText(agent.state)}</span>
            </button>
          </li>)}</ul> : <p className="agent-status-help">{t('No open agents')}</p>}
        </details>;
      })}
    </div>
  </details>;
}
