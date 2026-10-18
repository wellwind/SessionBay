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
const fileBytes = new Map(['synthetic.txt', 'README.md', 'large.ts', '.config', 'settings.json', 'src/index.ts', 'deep/unvisited.ts'].map(path => {
  const text = path === 'large.ts'
    ? Array.from({ length: 3000 }, (_, index) => `const row = ${index};`).join('\n') + '\n' + 'x'.repeat(12000) + 'END_SENTINEL\n'
    : path === 'README.md' ? '# Synthetic project\n<script>alert("never executed")</script>\n'
    : path === 'settings.json' ? '{\n  "synthetic": true,\n  "count": 42\n}\n'
    : path === 'src/index.ts' ? 'export const greeting = () => {\n  const message = "Synthetic";\n  return message;\n};\n' : 'synthetic preview only';
  return [path, new TextEncoder().encode(text)];
}));
const terminalFileFixture = fixtureParams.has('file-links');
if (terminalFileFixture) for (const path of ['src/中文 file(test).ts', 'src/same.ts', 'other/same.ts', 'slow.ts'])
  fileBytes.set(path, new TextEncoder().encode('first line\nsecond line\nthird line\n'));
const generatedFileSizes = new Map<string, number>(fixtureParams.get('large-files') === '1' ? [
  ['medium.txt', 1024 * 1024], ['big.txt', 21 * 1024 * 1024],
  ['huge.txt', 65 * 1024 * 1024], ['slow.txt', 2 * 1024 * 1024],
] as const : []);
const imageFixture = fixtureParams.get('file-images') === '1';
const imageFiles = imageFixture ? ['picture.png', 'drawing.svg', 'broken.png'] : [];
const imagePacket = (svg: boolean): ArrayBuffer => {
  const data = svg ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="red"/></svg>')
    : Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const header = new TextEncoder().encode(JSON.stringify({ mime: svg ? 'image/svg+xml' : 'image/png', sourceFormat: svg ? 'svg' : 'png', width: svg ? 120 : 1, height: svg ? 80 : 1, firstFrameOnly: false }));
  const result = new ArrayBuffer(8 + header.length + data.length); const bytes = new Uint8Array(result);
  bytes.set([83, 66, 73, 49]); new DataView(result).setUint32(4, header.length, true); bytes.set(header, 8); bytes.set(data, 8 + header.length); return result;
};
const generatedLine = 'synthetic row '.padEnd(127, '.') + '\n';
const fileVersion = (projectId: unknown, path: unknown) => `fixture:${projectId}:${path}:1`;
const calls: { projectId?: string; query?: SessionQuery; sessionId?: string; command: string; data?: string; runtimeId?: string; paneId?: string; cols?: number; rows?: number; showHidden?: boolean; path?: string; version?: string; offset?: number; maxBytes?: number }[] = [];
Object.assign(window, { isTauri: true, focusFixture: { calls } });
mockWindows('main');
mockIPC((command, payload = {}) => {
  const args = payload as Record<string, unknown>;
  calls.push({ command, ...(command === 'resolve_terminal_file' ? { projectId: args.projectId as string, paneId: args.paneId as string, runtimeId: args.runtimeId as string, path: args.path as string } : {}), ...(['inspect_workspace_file', 'read_workspace_file_chunk'].includes(command) ? { path: args.path as string, version: args.version as string | undefined, offset: args.offset as number | undefined, maxBytes: args.maxBytes as number | undefined } : {}), ...(command === 'query_sessions' ? { query: args.query as SessionQuery } : {}), ...(command === 'read_transcript' ? { sessionId: args.sessionId as string } : {}), ...(command === 'list_workspace_files' ? { showHidden: args.showHidden as boolean } : {}), ...(command === 'write_runtime' ? { data: args.data as string } : {}), ...(edgeFixture ? { runtimeId: args.runtimeId as string | undefined, paneId: (args.request as LaunchRequest | undefined)?.paneId } : {}), ...(command === 'resize_runtime' ? { cols: args.cols as number, rows: args.rows as number } : {}) });
  switch (command) {
    case 'bootstrap': return bootstrap;
    case 'start_index': case 'index_status': return bootstrap.index;
    case 'list_projects': return bootstrap.projects;
    case 'list_workspace_files': return { entries: args.path ? [
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
    ] : [
      { name: 'src', path: 'src', kind: 'directory' },
      ...['synthetic.txt', 'README.md', 'large.ts', '.config', 'settings.json', ...generatedFileSizes.keys(), ...imageFiles].map(name => ({ name, path: name, kind: 'file' })),
      { name: 'outside-link', path: 'outside-link', kind: 'blocked' },
    ], nextOffset: null };
    case 'search_workspace_files': return { paths: ['src/index.ts', 'deep/unvisited.ts', 'README.md'].filter(path => String(args.query).trim() && path.toLowerCase().includes(String(args.query).toLowerCase())), truncated: false };
    case 'resolve_terminal_file': {
      if (!terminalFileFixture) throw new Error('Terminal file links disabled in this fixture');
      const source = runtimes.find(runtime => runtime.id === args.runtimeId && runtime.paneId === args.paneId && runtime.projectId === args.projectId);
      if (!source) throw new Error('終端身分已變更');
      const root = bootstrap.projects.find(project => project.id === args.projectId)!.path!;
      const raw = String(args.path);
      const absolute = raw.startsWith('/');
      if (absolute && !raw.startsWith(root + '/')) throw new Error('路徑不在此終端所屬專案內，未開啟檔案');
      const relative = absolute ? raw.slice(root.length + 1) : raw.replace(/^\.\//, '');
      const candidates = [...fileBytes.keys()].filter(path => path === relative || !absolute && path.endsWith('/' + relative))
        .map(path => ({ path, version: fileVersion(args.projectId, path), fromLaunchDirectory: path === relative }));
      const result = { absolute, candidates, launchDirectory: absolute ? null : '', truncated: false };
      return relative === 'slow.ts' ? new Promise(resolve => setTimeout(() => resolve(result), 700)) : result;
    }
    case 'inspect_workspace_file': {
      const path = args.path as string;
      if (imageFiles.includes(path)) return { path, sizeBytes: 100, version: fileVersion(args.projectId, path), kind: 'image' };
      const sizeBytes = generatedFileSizes.get(path) ?? fileBytes.get(path)?.length;
      if (sizeBytes === undefined || !bootstrap.projects.some(project => project.id === args.projectId)) throw new Error('Unknown synthetic file');
      return { path, sizeBytes, version: fileVersion(args.projectId, path), kind: 'text' };
    }
    case 'read_workspace_image': {
      if (!imageFiles.includes(args.path as string) || args.version !== fileVersion(args.projectId, args.path)) throw new Error('Unknown synthetic image');
      if (args.path === 'broken.png') throw new Error('圖片內容無效');
      return imagePacket(args.path === 'drawing.svg');
    }
    case 'read_workspace_file_chunk': {
      const path = args.path as string;
      const bytes = fileBytes.get(path);
      const sizeBytes = generatedFileSizes.get(path) ?? bytes?.length;
      const offset = args.offset as number, maxBytes = args.maxBytes as number;
      if (sizeBytes === undefined || !bootstrap.projects.some(project => project.id === args.projectId)
        || args.version !== fileVersion(args.projectId, args.path)) throw new Error('Synthetic file version changed');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > sizeBytes
        || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 256 * 1024) throw new Error('Invalid synthetic file range');
      // Generate only the requested range, even for the 65 MiB fixture.
      const length = Math.min(maxBytes, sizeBytes - offset);
      const chunk = bytes ? Array.from(bytes.subarray(offset, offset + length))
        : Array.from({ length }, (_, index) => generatedLine.charCodeAt((offset + index) % generatedLine.length));
      const result = { bytes: chunk, eof: offset + length === sizeBytes };
      return path === 'slow.txt' ? new Promise(resolve => setTimeout(() => resolve(result), 100)) : result;
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
    case 'launch_fresh_runtime': {
      if (!fixtureParams.has('hook-skip')) throw new Error('Fresh launch disabled');
      throw new Error('[SESSIONBAY_LAUNCH_NOT_STARTED] 目前背景 broker 尚不支援真實活動 hooks；這次未啟動 Agent，既有工作不受影響。');
    }
    case 'launch_fresh_without_hooks': {
      if (!fixtureParams.has('hook-skip')) throw new Error('Confirmation disabled');
      const request = args.request as LaunchRequest;
      const record: RuntimeRecord = { ...runtime, id: 'runtime-synthetic-fresh', paneId: 'pane-synthetic-fresh',
        kind: request.kind, profileId: request.profileId ?? null, projectId: request.projectId ?? null, cwd: request.cwd! };
      runtimes.push(record);
      return record;
    }
    case 'cancel_fresh_launch': return;
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
      const data = Array.from(new TextEncoder().encode(terminalFileFixture ? [
        'ABS /synthetic/focus/src/index.ts:2:3',
        'REL src/index.ts:3:4',
        'SPACE \"/synthetic/focus/src/中文 file(test).ts\":2:2',
        'BARE same.ts:1',
        'OSC \x1b]8;;file:///outside/secret.ts\x1b\\/synthetic/focus/src/index.ts:4:1\x1b]8;;\x1b\\',
        'OSC-PART /synthetic/\x1b]8;;javascript:evil\x1b\\focus\x1b]8;;\x1b\\/src/index.ts:4:1',
        'OSC-TAIL /synthetic/focus/src/index.ts:4:\x1b]8;;file:///outside/secret.ts\x1b\\1\x1b]8;;\x1b\\',
        'COLOR \x1b[36m/synthetic/focus/src/index.ts:2:3\x1b[0m',
        'HTTP https://example.invalid/src/index.ts',
        'BLOCK /outside/secret.ts:1',
        '$ ',
      ].join('\r\n') : Array.from({ length: 100 }, (_, i) => `Synthetic focus output ${i + 1}\r\n`).join('') + '$ '));
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
void import('../../src/App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<App />);
});
