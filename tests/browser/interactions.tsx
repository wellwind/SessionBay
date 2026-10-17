import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { api } from '../../src/api';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Synthetic bridge only: no native filesystem, history, shell, or user data.
Object.assign(globalThis, { isTauri: true });
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => 1, transformCallback: () => 1,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const data: Bootstrap = {
  runtimes: [], installations: [], warnings: [],
  index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
  settings: { version: 1, theme: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark', themePalette: new URLSearchParams(location.search).get('palette') || 'bay', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
    appZoom: 100, defaultAgent: 'codex', defaultProfileId: 'default', profiles: [], sources: [],
    agentOptions: defaultAgentOptions(), executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' }, shortcuts: {}, onboardingComplete: true },
  projects: ['工作台介面', '文件與設計', 'API 開發'].map((name, i) => ({ id: `p${i}`, name: i === 0 && new URLSearchParams(location.search).has('long') ? `${name}：${'很長的專案名稱'.repeat(8)}` : name, path: `/synthetic/project-${i}`, launchPath: null,
    exists: true, curated: true, pinned: i === 1, sessionCount: i + 1, updatedAt: null, agents: ['codex'] })),
  workspace: { version: 1, panes: { pane: { id: 'pane', kind: 'shell', title: 'Shell', projectId: 'p0', cwd: '/synthetic/project-0', state: 'stopped' } },
    tabs: [{ id: 'tab', projectId: 'p0', name: '開發 Terminal', focusedPaneId: 'pane', layout: { kind: 'pane', paneId: 'pane' } }], activeTabByProject: { p0: 'tab' } },
};
api.bootstrap = async () => data;
api.listWorkspaceFiles = async () => ({ entries: [], nextOffset: null });
api.readWorkspaceFile = async () => { throw new Error('No file fixture is configured for this scenario'); };
api.projects = async () => data.projects;
api.scan = api.index = async () => data.index;
api.runtimes = async () => [];
api.saveWorkspace = api.setWorkspaceZoom = async () => {};
let sessions = ['介面互動整理', '修正鍵盤焦點', '檢查深淺色對比'].map((title, i) => ({
  id: `s${i}`, trashIdentity: `token-${i}`, sourceId: 'synthetic', kind: 'codex' as const,
  externalId: `synthetic-${i}`, projectId: 'p0', title, cwd: '/synthetic/project-0',
  updatedAt: '2026-10-17T01:00:00Z', timeSource: 'event' as const, archived: false,
  parentId: null, partial: false, snippet: '合成測試資料，用來檢查 hover 與鍵盤操作。',
}));
api.sessions = async () => ({ items: sessions, total: sessions.length });
api.transcript = async () => ({ messages: [], hasMore: false, beforeLine: null, stale: false, warning: null });
api.trashSession = async id => { sessions = sessions.filter(s => s.id !== id); return id; };
api.saveSettings = async settings => settings;
createRoot(document.getElementById('root')!).render(<App />);
