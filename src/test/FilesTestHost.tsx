import { useState } from 'react';
import { WorkspaceFiles, type WorkspaceFilesProps } from '../components/WorkspaceFiles';
export function FilesTestHost({ projectId, ...props }: Partial<WorkspaceFilesProps> & { projectId: string }) {
  const [sidebarHost, setSidebarHost] = useState<HTMLDivElement | null>(null);
  const [tabsHost, setTabsHost] = useState<HTMLDivElement | null>(null);
  const [documentHost, setDocumentHost] = useState<HTMLDivElement | null>(null);
  return <><div ref={setSidebarHost} /><div ref={setTabsHost} /><div ref={setDocumentHost} />
    <WorkspaceFiles projectId={projectId} visible active sidebarVisible sidebarHost={sidebarHost} tabsHost={tabsHost} documentHost={documentHost}
      onActivate={() => {}} onEmpty={() => {}} onHideSidebar={() => {}} {...props} />
  </>;
}
