import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { api } from '../../src/api';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Synthetic bridge only: no native filesystem, history, shell, or user data.
Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async () => 1, transformCallback: () => 1,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const data: Bootstrap = {
  runtimes: [], installations: [], warnings: [],
  index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
  settings: { version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
    appZoom: 100, defaultAgent: 'codex', defaultProfileId: 'default', profiles: [], sources: [],
    agentOptions: defaultAgentOptions(), executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' }, shortcuts: {}, onboardingComplete: true },
  projects: ['工作台介面', '文件與設計', 'API 開發'].map((name, i) => ({ id: `p${i}`, name, path: `/synthetic/project-${i}`, launchPath: null,
    exists: true, curated: true, pinned: i === 1, sessionCount: i + 1, updatedAt: null, agents: ['codex'] })),
  workspace: { version: 1,
    panes: Object.fromEntries(['a', 'b', 'c', 'other', 'global-a', 'global-b'].map(id => [id, { id, kind: 'shell', title: id,
      projectId: id.startsWith('global') ? null : id === 'other' ? 'p1' : 'p0', cwd: '/synthetic', state: 'stopped' }])),
    tabs: ['a', 'other', 'b', 'global-a', 'c', 'global-b'].map(id => ({ id, projectId: id.startsWith('global') ? null : id === 'other' ? 'p1' : 'p0',
      name: `Tab ${id}`, focusedPaneId: id, layout: { kind: 'pane', paneId: id } })),
    activeTabByProject: { p0: 'b', p1: 'other' }, activeTemporaryTabId: 'global-a' },
};
api.bootstrap = async () => ({ ...data, workspace: JSON.parse(localStorage.getItem('workspace-test') || JSON.stringify(data.workspace)) });
api.projects = async () => data.projects;
api.scan = api.index = async () => data.index;
api.runtimes = async () => [];
api.saveWorkspace = async workspace => { localStorage.setItem('workspace-test', JSON.stringify(workspace)); };
api.setWorkspaceZoom = async () => {};
api.sessions = async () => ({ catalogRevision: 'fixture', items: [], total: 0 });
createRoot(document.getElementById('root')!).render(<App />);
