import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { api } from '../../src/api';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap, RuntimeRecord, TerminalEvent } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Synthetic bridge only. No user data, native process, filesystem or credentials.
Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async () => 1, transformCallback: () => 1,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const records: RuntimeRecord[] = [
  ['a', 'codex', 'p0', 'running'], ['b', 'claude', 'p0', 'exited'],
  ['c', 'opencode', 'p1', 'interrupted'], ['global', 'grok', null, 'running'],
  ['shell', 'shell', 'p0', 'running'],
].map(([id, kind, projectId, state]) => ({ id: `runtime-${id}`, paneId: id!, kind: kind as RuntimeRecord['kind'],
  projectId, state: state!, sessionId: null, resumeId: null, profileId: null, cwd: '/synthetic', exitCode: state === 'exited' ? 0 : null }));
const data: Bootstrap = {
  runtimes: records, installations: [], warnings: [],
  index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
  settings: { version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
    appZoom: 100, defaultAgent: 'codex', defaultProfileId: 'default', profiles: [], sources: [],
    agentOptions: defaultAgentOptions(), executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' }, shortcuts: {}, onboardingComplete: true },
  projects: ['工作台介面', 'API 開發'].map((name, i) => ({ id: `p${i}`, name, path: `/synthetic/project-${i}`, launchPath: null,
    exists: true, curated: true, pinned: false, sessionCount: 99, updatedAt: null, agents: ['codex'] })),
  workspace: null,
};
const channels = new Map<string, (event: TerminalEvent) => void>();
Object.assign(window, { agentStatusFixture: {
  emit: (event: TerminalEvent) => channels.get(event.runtimeId)?.(event),
} });
api.bootstrap = async () => data;
api.projects = async () => data.projects;
api.scan = api.index = async () => data.index;
api.runtimes = async () => records;
api.saveWorkspace = api.setWorkspaceZoom = api.ack = api.write = api.detach = api.resize = async () => {};
api.sessions = async () => ({ items: [], total: 0 });
api.attach = async (id, callback) => {
  const record = records.find((item) => item.id === id)!;
  channels.set(id, callback);
  callback({ type: 'snapshot', runtimeId: id, sequence: 1,
    data: Array.from(new TextEncoder().encode('Synthetic Agent runtime\r\n')), cols: 80, rows: 24, truncated: false });
  return record;
};
createRoot(document.getElementById('root')!).render(<App />);
