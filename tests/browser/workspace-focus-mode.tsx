import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import { defaultAgentOptions } from '../../src/agents';
import type { Bootstrap, LaunchRequest, RuntimeRecord, Session, SessionQuery, TerminalEvent, Workspace } from '../../src/types';
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
const edgeFixture = new URLSearchParams(location.search).has('edge');
const fixtureParams = new URLSearchParams(location.search);
const temporaryFixture = fixtureParams.has('temporary');
if (fixtureParams.get('theme') === 'light') bootstrap.settings.theme = 'light';
if (['bay', 'code-modern', 'code-2026'].includes(fixtureParams.get('palette') ?? ''))
  bootstrap.settings.themePalette = fixtureParams.get('palette')!;
const runtimes = [runtime];
if (edgeFixture) {
  const workspace = bootstrap.workspace as Workspace;
  const hidden: RuntimeRecord = { ...runtime, id: 'runtime-hidden', paneId: 'pane-hidden' };
  runtimes.push(hidden);
  bootstrap.runtimes = runtimes;
  workspace.tabs.push({ id: 'tab-hidden', projectId: 'project-focus', name: 'Hidden shell',
    focusedPaneId: hidden.paneId, layout: { kind: 'pane', paneId: hidden.paneId } });
  workspace.panes[hidden.paneId] = { ...workspace.panes['pane-focus'], id: hidden.paneId,
    title: 'Hidden shell', runtimeId: hidden.id };
}
const activityFixture = fixtureParams.has('activity');
if (activityFixture) bootstrap.projects.forEach(project => { project.sessionCount = 80; project.agents = ['codex', 'claude']; });
if (fixtureParams.has('empty')) Object.assign(bootstrap.projects[1], { sessionCount: 0, agents: [] });
const sessions = bootstrap.projects.flatMap(project => Array.from({ length: project.sessionCount }, (_, index): Session => ({
  id: `${project.id}-session-${index}`, title: `${project.name} session ${index}`,
  sourceId: 'synthetic-source', kind: index % 2 === 0 ? 'codex' : 'claude',
  externalId: `synthetic-external-${project.id}-${index}`, projectId: project.id,
  cwd: project.path, updatedAt: '2026-10-17T12:00:00Z', timeSource: 'event',
  archived: false, parentId: null, partial: false, snippet: `Synthetic session ${index} only`,
})));
const calls: { query?: SessionQuery; sessionId?: string; command: string; data?: string; runtimeId?: string; paneId?: string; cols?: number; rows?: number; showHidden?: boolean }[] = [];
Object.assign(window, { isTauri: true, focusFixture: { calls } });
mockWindows('main');
mockIPC((command, payload = {}) => {
  const args = payload as Record<string, unknown>;
  calls.push({ command, ...(command === 'query_sessions' ? { query: args.query as SessionQuery } : {}), ...(command === 'read_transcript' ? { sessionId: args.sessionId as string } : {}), ...(command === 'list_workspace_files' ? { showHidden: args.showHidden as boolean } : {}), ...(command === 'write_runtime' ? { data: args.data as string } : {}), ...(edgeFixture ? { runtimeId: args.runtimeId as string | undefined, paneId: (args.request as LaunchRequest | undefined)?.paneId } : {}), ...(command === 'resize_runtime' ? { cols: args.cols as number, rows: args.rows as number } : {}) });
  switch (command) {
    case 'bootstrap': return bootstrap;
    case 'start_index': case 'index_status': return bootstrap.index;
    case 'list_projects': return bootstrap.projects;
    case 'list_workspace_files': return { entries: args.path ? [
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
    ] : [
      { name: 'src', path: 'src', kind: 'directory' },
      ...['synthetic.txt', 'README.md', 'large.ts', '.config'].map(name => ({ name, path: name, kind: 'file' })),
      { name: 'outside-link', path: 'outside-link', kind: 'blocked' },
    ], nextOffset: null };
    case 'read_workspace_file': {
      const path = args.path as string;
      const text = path === 'large.ts'
        ? Array.from({ length: 3000 }, (_, index) => `const row = ${index};`).join('\n') + '\n' + 'x'.repeat(12000) + 'END_SENTINEL\n'
        : path === 'README.md' ? '# Synthetic project\n<script>alert("never executed")</script>\n'
        : path === 'src/index.ts' ? 'export const greeting = () => {\n  const message = "Synthetic";\n  return message;\n};\n' : 'synthetic preview only';
      return { path, text, sizeBytes: new TextEncoder().encode(text).length };
    }
    case 'update_project': {
      const project = bootstrap.projects.find(item => item.id === args.projectId)!;
      for (const field of ['name', 'curated', 'launchPath'] as const)
        if (args[field] !== undefined) Object.assign(project, { [field]: args[field] });
      return project;
    }
    case 'list_runtimes': return runtimes;
    case 'query_sessions': {
      const query = args.query as SessionQuery;
      const filtered = activityFixture ? sessions.filter(session =>
        (!query.projectId || session.projectId === query.projectId) &&
        (!query.kind || session.kind === query.kind) &&
        (!query.query || session.title.toLowerCase().includes(query.query.toLowerCase()))) : [];
      const offset = query.offset ?? 0;
      return { catalogRevision: 'fixture', items: filtered.slice(offset, offset + (query.limit ?? 40)), total: filtered.length };
    }
    case 'read_transcript': return {
      messages: Array.from({ length: 60 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant',
        text: `Synthetic transcript ${args.sessionId} message ${index}`, timestamp: null, line: index + 1 })),
      hasMore: false, beforeLine: null, stale: false, warning: null,
    };
    case 'detect_installations': case 'detect_shells': return [];
    case 'save_settings': bootstrap.settings = args.settings as Bootstrap['settings']; return bootstrap.settings;
    case 'preview_launch': {
      if (!edgeFixture && !temporaryFixture) throw new Error('Launch is disabled in the default fixture');
      return { executable: '/synthetic/shell', args: [], cwd: '/synthetic/focus' };
    }
    case 'launch_runtime':
    case 'attach_runtime': {
      if (command === 'launch_runtime') {
        if (!edgeFixture && !temporaryFixture) throw new Error('Launch is disabled in the default fixture');
        const request = args.request as LaunchRequest;
        runtimes.push({ ...runtime, id: `runtime-${request.paneId}`, paneId: request.paneId,
          projectId: request.projectId ?? null, cwd: request.cwd || '/synthetic/home' });
      }
      const target = command === 'launch_runtime' ? runtimes.at(-1)!
        : runtimes.find(item => item.id === args.runtimeId)!;
      const data = Array.from(new TextEncoder().encode(Array.from({ length: 100 }, (_, i) => `Synthetic focus output ${i + 1}\r\n`).join('') + '$ '));
      (args.onEvent as Channel<TerminalEvent>).onmessage({ type: 'snapshot', runtimeId: target.id, sequence: 1, data, cols: 100, rows: 30, truncated: false });
      return target;
    }
    case 'stop_runtime': {
      if (!edgeFixture) throw new Error('Stop is disabled in the default fixture');
      const target = runtimes.find(item => item.id === args.runtimeId);
      if (target) target.state = 'exited';
      return;
    }
    case 'forget_runtime': {
      if (!edgeFixture) throw new Error('Forget is disabled in the default fixture');
      const index = runtimes.findIndex(item => item.id === args.runtimeId);
      if (index >= 0) runtimes.splice(index, 1);
      return;
    }
    case 'resize_runtime': case 'ack_runtime': case 'write_runtime': case 'detach_runtime':
    case 'save_workspace': case 'plugin:webview|set_webview_zoom': return;
    default: throw new Error(`Unexpected synthetic fixture IPC: ${command}`);
  }
}, { shouldMockEvents: true });
const { default: App } = await import('../../src/App');
createRoot(document.getElementById('root')!).render(<App />);
