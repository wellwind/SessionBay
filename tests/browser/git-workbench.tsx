import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { api } from '../../src/api';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap, GitDiscovery, GitRepository } from '../../src/types';
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
  settings: { version: 1, theme: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
    appZoom: 100, defaultAgent: 'codex', defaultProfileId: 'default', profiles: [], sources: [],
    agentOptions: defaultAgentOptions(), executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' }, shortcuts: {}, onboardingComplete: true },
  projects: ['工作台介面', '文件與設計', 'API 開發'].map((name, i) => ({ id: `p${i}`, name, path: `/synthetic/project-${i}`, launchPath: null,
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
api.sessions = async () => ({ catalogRevision: 'fixture', items: [], total: 0 });

// Synthetic Git bridge: p0 has two same-named repos, p1 has none. No real repositories are read.
const repo = (id: string): GitRepository => ({ id, name: 'app', worktreeRoot: `/synthetic/project-0/${id}/app`,
  gitDir: `/synthetic/project-0/${id}/app/.git`, commonDir: `/synthetic/project-0/${id}/app/.git`, kind: 'primary',
  superproject: null, relativePath: `${id}/app`, containsProject: false, parentId: null });
const gitCalls: string[] = [];
Object.assign(window, { gitFixture: { calls: gitCalls } });
api.discoverGit = async (projectId) => {
  gitCalls.push(`discover:${projectId}`);
  const repositories = projectId === 'p0' ? [repo('alpha'), repo('beta')] : [];
  return { projectRoot: `/synthetic/${projectId}`, gitAvailable: true, gitVersion: 'git version 2.47.0',
    root: { path: `/synthetic/${projectId}`, state: 'notRepository', repository: null, gitDir: null, message: null },
    repositories, issues: [], scannedDirectories: 4, truncated: false, cancelled: false } satisfies GitDiscovery;
};
api.cancelGitDiscovery = async () => false;
api.gitStatus = async (_projectId, root) => {
  gitCalls.push(`status:${root}`);
  const alpha = root.includes('alpha');
  return { repoId: alpha ? 'alpha' : 'beta', worktreeRoot: root, branch: alpha ? 'main' : 'feature/very-long-branch-name-for-layout',
    oid: 'abc1234', detached: false, unborn: false, upstream: 'origin/main', ahead: alpha ? 2 : 0, behind: 0,
    staged: alpha ? 1 : 0, unstaged: alpha ? 3 : 0, untracked: 0, conflicted: 0, limited: false };
};
for (const name of ['launch', 'stop', 'forget', 'detach'] as const) {
  const original = (api as Record<string, unknown>)[name];
  if (typeof original === 'function') (api as Record<string, unknown>)[name] = (...args: unknown[]) => { gitCalls.push(`runtime:${name}`); return (original as (...a: unknown[]) => unknown)(...args); };
}
createRoot(document.getElementById('root')!).render(<App />);
