import { ArrowRight, Folder, AlertTriangle, Pin, Check } from 'lucide-react';
import type { Project } from '../types';
import { agentName, dateLabel } from './History';
import { AgentIcon } from './AgentIcon';

interface Props {
  page: 'projects' | 'directories';
  projects: Project[];
  searching: boolean;
  busy: boolean;
  onSelect: (project: Project) => void;
  onMembership: (project: Project, curated: boolean) => Promise<void>;
  onAdd: () => void;
  onDirectories: () => void;
}

/** Directory-first overview: no cross-directory history query until explicitly requested. */
export function DirectoryOverview({ page, projects, searching, busy, onSelect, onMembership, onDirectories }: Props) {
  const curated = page === 'projects';
  return <section className={`directory-overview ${curated ? 'projects-overview' : 'all-directories-overview'}`} aria-label={curated ? '專案管理總覽' : '所有目錄總覽'}>
    <div className="directory-overview-heading">
      <div><h2>{curated ? '我的專案' : '工作階段所在目錄'}</h2>
        <p>{curated ? '只有你加入的目錄會出現在這裡。移出專案不會刪除任何檔案或對話。'
          : '依原工作目錄分組，包含尚未加入專案、已失效或未分類的歷史。'}</p></div>
      <span className="overview-total">{projects.length} {curated ? '個專案' : '個目錄'}</span>
    </div>
    {projects.length ? <ul className={curated ? "directory-cards" : "directory-rows"}>{projects.map((project) => <li key={project.id}>
      <button className="directory-card-main" onClick={() => onSelect(project)}
        aria-label={`瀏覽${curated ? '專案' : '目錄'} ${project.name}`}>
        <div className="directory-card-title"><span className="directory-folder-mark"><Folder size={21} aria-hidden="true" /></span><h3>{project.name}</h3>
          {project.pinned && <Pin size={14} aria-label="已置頂" />}</div>
        <p className="directory-card-path" title={project.path || '未記錄工作目錄'}>{project.path || '未分類 · 未記錄工作目錄'}</p>
        {project.launchPath && <p className="directory-card-relocation">啟動位置：{project.launchPath}</p>}
        <div className="directory-card-details"><span>{project.sessionCount} 個工作階段</span>
          <span className="directory-agents">{project.agents.length ? project.agents.map((kind) => <span key={kind} title={agentName(kind)}><AgentIcon kind={kind} /><span>{agentName(kind)}</span></span>) : '尚無歷史'}</span></div>
        <div className="directory-location-state">{!project.exists ? <><AlertTriangle size={13} aria-hidden="true" />{project.path ? '目錄需重新定位' : '工作目錄未記錄'}</> : <><Check size={13} aria-hidden="true" />{project.launchPath ? '使用重新定位目錄' : '目錄可用'}</>}</div>
        <div className="directory-card-activity"><span>{dateLabel(project.updatedAt)}</span><ArrowRight size={16} /></div>
      </button>
      <div className="directory-card-actions"><span>{project.curated ? '已加入專案' : '尚未加入專案'}</span>
        <button className="secondary" disabled={busy} onClick={() => void onMembership(project, !project.curated)}
          aria-label={`${project.curated ? '移出專案' : '加入專案'} ${project.name}`}
          title={project.curated ? '只移出專案清單，不刪除檔案、歷史或關閉程序' : '加入自選專案清單'}>
          {project.curated ? '移出專案' : '加入專案'}</button></div>
    </li>)}</ul> : <div className="directory-empty">
      <Folder size={36} /><h3>{searching ? '沒有符合的目錄' : curated ? '先加入想關注的專案' : '尚未找到工作階段目錄'}</h3>
      <p>{searching ? '試試其他名稱或完整路徑。' : curated ? '從所有目錄挑選，或加入既有目錄、建立新專案。'
        : '請在設定確認歷史資料來源，再更新索引。尚未加入專案的目錄也會顯示在這裡。'}</p>
      {curated && !searching && <button className="secondary" onClick={onDirectories}>從所有目錄挑選<ArrowRight size={15} /></button>}
    </div>}
  </section>;
}
