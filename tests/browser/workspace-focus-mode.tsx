import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap, RuntimeRecord, TerminalEvent } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Full App + real xterm, with synthetic IPC only: never start a native process,
// read local histories, contact an agent, or access user settings/files.
const runtime: RuntimeRecord = {
  id: 'runtime-focus', paneId: 'pane-focus', projectId: 'project-focus',
  sessionId: null, profileId: 'shell', resumeId: null, kind: 'shell',
  state: 'running', cwd: '/synthetic/focus', exitCode: null,
};
const bootstrap: Bootstrap = {
  settings: {
    version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 13,
    defaultAgent: 'codex', defaultProfileId: 'shell',
    profiles: [{ id: 'shell', name: 'Synthetic shell', executable: '/synthetic/shell', args: [], env: {} }],
    sources: [], agentOptions: defaultAgentOptions(),
    executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
    shortcuts: {}, onboardingComplete: true,
  },
  projects: ['focus', 'other'].map(id => ({
    id: `project-${id}`, name: `Synthetic ${id}`, path: `/synthetic/${id}`, launchPath: null,
    exists: true, pinned: false, curated: true, sessionCount: 0, updatedAt: null, agents: [],
  })),
  runtimes: [runtime], installations: [], warnings: [],
  index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
  workspace: {
    version: 1,
    tabs: [{ id: 'tab-focus', projectId: 'project-focus', name: 'Focus shell', focusedPaneId: 'pane-focus', layout: { kind: 'pane', paneId: 'pane-focus' } }],
    panes: { 'pane-focus': { id: 'pane-focus', title: 'Focus shell', kind: 'shell', projectId: 'project-focus', cwd: '/synthetic/focus', profileId: 'shell', state: 'running', runtimeId: runtime.id } },
    activeTabByProject: { 'project-focus': 'tab-focus' },
  },
};
const calls: { command: string; cols?: number; rows?: number }[] = [];
Object.assign(window, { isTauri: true, focusFixture: { calls } });
mockWindows('main');
mockIPC((command, payload = {}) => {
  const args = payload as Record<string, unknown>;
  calls.push({ command, ...(command === 'resize_runtime' ? { cols: args.cols as number, rows: args.rows as number } : {}) });
  switch (command) {
    case 'bootstrap': return bootstrap;
    case 'start_index': case 'index_status': return bootstrap.index;
    case 'list_projects': return bootstrap.projects;
    case 'list_runtimes': return [runtime];
    case 'query_sessions': return { items: [], total: 0 };
    case 'detect_installations': case 'detect_shells': return [];
    case 'save_settings': bootstrap.settings = args.settings as Bootstrap['settings']; return bootstrap.settings;
    case 'attach_runtime': {
      const data = Array.from(new TextEncoder().encode(Array.from({ length: 100 }, (_, i) => `Synthetic focus output ${i + 1}\r\n`).join('') + '$ '));
      (args.onEvent as Channel<TerminalEvent>).onmessage({ type: 'snapshot', runtimeId: runtime.id, sequence: 1, data, cols: 100, rows: 30, truncated: false });
      return runtime;
    }
    case 'resize_runtime': case 'ack_runtime': case 'write_runtime': case 'detach_runtime':
    case 'save_workspace': case 'plugin:webview|set_webview_zoom': return;
    default: throw new Error(`Unexpected synthetic fixture IPC: ${command}`);
  }
}, { shouldMockEvents: true });
const { default: App } = await import('../../src/App');
createRoot(document.getElementById('root')!).render(<App />);
