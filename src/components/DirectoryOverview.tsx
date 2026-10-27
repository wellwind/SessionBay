import { ArrowRight, Folder, AlertTriangle, Check } from 'lucide-react';
import type { Project } from '../types';
import { agentName, dateLabel } from './History';
import { AgentIcon } from './AgentIcon';
import { projectCountLabel } from '../project-runtime';
import { t } from '../i18n';

interface Props {
  page: 'projects' | 'directories';
  projects: Project[];
  searching: boolean;
  busy: boolean;
  onSelect: (project: Project) => void;
  onMembership: (project: Project, curated: boolean) => Promise<void>;
  onAdd: () => void;
  onDirectories: () => void;
  /** Starting/running runtimes per project id; absent means 0. */
  openCounts?: Record<string, number>;
}

/** Directory-first overview: no cross-directory history query until explicitly requested. */
export function DirectoryOverview({ page, projects, searching, busy, onSelect, onMembership, onDirectories, openCounts = {} }: Props) {
  const curated = page === 'projects';
  return <section className={`directory-overview ${curated ? 'projects-overview' : 'all-directories-overview'}`} aria-label={curated ? t('Projects overview') : t('All directories overview')}>
    <div className="directory-overview-heading">
      <h2>{curated ? t('My projects') : t('Directories with sessions')}</h2>
      <span className="overview-total">{curated ? t('{{count}} projects', { count: projects.length }) : t('{{count}} directories', { count: projects.length })}</span>
    </div>
    {projects.length ? <ul className={curated ? "directory-cards" : "directory-rows"}>{projects.map((project) => <li key={project.id}>
      <button className="directory-card-main" onClick={() => onSelect(project)}
        aria-label={curated ? t('Browse project {{name}}', { name: project.name }) : t('Browse directory {{name}}', { name: project.name })}>
        <div className="directory-card-title"><span className="directory-folder-mark"><Folder size={21} aria-hidden="true" /></span><h3>{project.name}</h3>
          </div>
        <p className="directory-card-path" title={project.path || t('No working directory recorded')}>{project.path || t('Unclassified · no working directory recorded')}</p>
        {project.launchPath && <p className="directory-card-relocation">{t('Launch location: {{path}}', { path: project.launchPath })}</p>}
        <div className="directory-card-details"><span className="directory-card-counts">{projectCountLabel(project.sessionCount, openCounts[project.id] ?? 0)}</span>
          <span className="directory-agents">{project.agents.length ? project.agents.map((kind) => <span key={kind} title={agentName(kind)}><AgentIcon kind={kind} /><span>{agentName(kind)}</span></span>) : t('No history yet')}</span></div>
        <div className="directory-location-state">{!project.exists ? <><AlertTriangle size={13} aria-hidden="true" />{project.path ? t('Folder needs relocating') : t('Working directory not recorded')}</> : <><Check size={13} aria-hidden="true" />{project.launchPath ? t('Using the relocated folder') : t('Folder available')}</>}</div>
        <div className="directory-card-activity"><span>{dateLabel(project.updatedAt)}</span><ArrowRight size={16} /></div>
      </button>
      <div className="directory-card-actions"><span>{project.curated ? t('In projects') : t('Not in projects')}</span>
        <button className="secondary" disabled={busy} onClick={() => void onMembership(project, !project.curated)}
          aria-label={project.curated ? t('Remove {{name}} from projects', { name: project.name }) : t('Add {{name}} to projects', { name: project.name })}
          title={project.curated ? t('Only removes it from the project list; files, history and processes are untouched') : t('Add to your project list')}>
          {project.curated ? t('Remove from projects') : t('Add project')}</button></div>
    </li>)}</ul> : <div className="directory-empty">
      <Folder size={36} /><h3>{searching ? t('No matching directories') : curated ? t('Add the projects you care about') : t('No session directories found yet')}</h3>
      <p>{searching ? t('Try another name or the full path.') : curated ? t('Pick from all directories, add an existing folder or create a new project.')
        : t('Check your history sources in Settings, then update the index. Directories not in your projects show up here too.')}</p>
      {curated && !searching && <button className="secondary" onClick={onDirectories}>{t('Pick from all directories')}<ArrowRight size={15} /></button>}
    </div>}
  </section>;
}
