import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import { kanbanFixture, moveFixtureCard, createFixtureCard, deleteFixtureCard, mergeFixtureCards, splitFixtureSession } from '../fixtures/kanban';
import { defaultAgentOptions } from '../../src/agents';
import type { AgentKind, Bootstrap, Pane, Project, RuntimeRecord, Session, SessionQuery, TerminalEvent, Workspace } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Website screenshots: the full App with believable but entirely synthetic data.
// Nothing here starts a process, reads local history or touches user files.
const zh = navigator.language.toLowerCase().startsWith('zh');
const L = (en: string, zhText: string) => (zh ? zhText : en);
const params = new URLSearchParams(location.search);
const home = '/Users/you/code';
const ago = (minutes: number) => new Date(Date.parse('2026-10-27T09:30:00Z') - minutes * 60_000).toISOString();

const project = (id: string, name: string, agents: AgentKind[], sessionCount: number, minutes: number, curated = true): Project => ({
  id, name, path: `${home}/${name}`, launchPath: null, exists: true, pinned: false, curated,
  sessionCount, updatedAt: ago(minutes), agents,
});
const projects: Project[] = [
  project('p-harbor', 'harbor-api', ['claude', 'codex', 'opencode'], 7, 12),
  project('p-web', 'web-dashboard', ['claude', 'opencode'], 4, 95),
  project('p-mobile', 'mobile-app', ['grok', 'codex'], 3, 60 * 26),
  project('p-infra', 'infra', ['codex'], 2, 60 * 72),
  project('p-notes', 'notes-cli', ['antigravity'], 1, 60 * 24 * 9, false),
  project('p-spike', 'perf-spike', ['claude'], 2, 60 * 24 * 15, false),
];

const harborSessions: [AgentKind, string, string, number][] = [
  ['claude', L('Add rate limiting to the upload endpoint', '為上傳 API 加上速率限制'), L('Token bucket per API key, 429 with Retry-After, tests for burst traffic.', '每個 API key 一個 token bucket，回傳 429 與 Retry-After，並補上突發流量測試。'), 12],
  ['codex', L('Fix flaky retry test in the payments client', '修正 payments client 不穩定的重試測試'), L('The test relied on wall-clock time; switched to a fake timer.', '測試依賴實際時間，改用假時鐘。'), 140],
  ['opencode', L('Migrate the config loader to TOML', '把設定載入器改成 TOML'), L('Kept JSON as a fallback for one release and added a deprecation warning.', '保留 JSON 作為一個版本的備援，並加上棄用警告。'), 60 * 5],
  ['claude', L('Explain the queue backpressure design', '解釋佇列 backpressure 的設計'), L('Walkthrough of how the worker pool pauses reads when the queue is full.', '說明 worker pool 在佇列滿時如何暫停讀取。'), 60 * 26],
  ['codex', L('Upgrade to Node 24 and fix type errors', '升級到 Node 24 並修正型別錯誤'), L('Updated @types/node, replaced deprecated Buffer APIs.', '更新 @types/node，替換已棄用的 Buffer API。'), 60 * 30],
  ['claude', L('Investigate the slow /search query', '調查 /search 查詢變慢的原因'), L('Missing index on (tenant_id, created_at); added a migration.', '缺少 (tenant_id, created_at) 索引，已補上 migration。'), 60 * 50],
  ['opencode', L('Draft release notes for v2.3', '撰寫 v2.3 版本說明'), L('Grouped changes into features, fixes and breaking changes.', '依新功能、修正與破壞性變更分組。'), 60 * 24 * 4],
];
const sessions: Session[] = harborSessions.map(([kind, title, snippet, minutes], index) => ({
  id: `s-harbor-${index}`, sourceId: kind, kind, externalId: `${kind}-${(index + 1) * 7919}`,
  projectId: 'p-harbor', title, cwd: `${home}/harbor-api`, updatedAt: ago(minutes), timeSource: 'event',
  archived: false, parentId: null, partial: false, snippet,
}));

const board = kanbanFixture('p-harbor', sessions);
board.enabled = params.get('board') !== 'off';

const transcript = [
  ['user', L('Add rate limiting to POST /uploads. Limit each API key to 60 requests per minute and return 429 with a Retry-After header.', '幫 POST /uploads 加上速率限制：每個 API key 每分鐘 60 次，超過回 429 並帶 Retry-After header。')],
  ['assistant', L('I looked at src/routes/uploads.ts and the existing middleware in src/http/. I will add a token-bucket limiter keyed by API key, backed by the Redis client we already use for sessions, so limits hold across instances.', '我看過 src/routes/uploads.ts 和 src/http/ 裡現有的 middleware。我會加一個以 API key 為單位的 token bucket，用目前 session 已在使用的 Redis client 儲存，這樣多台機器也能共用限制。')],
  ['assistant', L('Done:\n• src/http/rateLimit.ts — token bucket with 60 tokens, refilled every second\n• uploads route now responds 429 with Retry-After\n• tests cover a burst of 61 requests and the refill', '完成：\n• src/http/rateLimit.ts：60 個 token、每秒補充的 token bucket\n• uploads 路由超過時回 429 並帶 Retry-After\n• 測試涵蓋連續 61 次請求與補充行為')],
  ['user', L('Can the limit be configured per plan?', '可以依方案設定不同的上限嗎？')],
  ['assistant', L('Yes. I moved the numbers into config/limits.toml with a default and a "pro" plan override, and the middleware reads the plan from the API key record.', '可以。我把數值移到 config/limits.toml，提供預設值與 "pro" 方案覆寫，middleware 會從 API key 紀錄讀取方案。')],
];

const settings: Bootstrap['settings'] = {
  version: 1, theme: params.get('theme') === 'light' ? 'light' : 'dark', terminalTheme: 'bay', themePalette: 'bay',
  fontFamily: 'monospace', fontSize: 13, defaultAgent: 'claude', defaultProfileId: 'zsh',
  profiles: [{ id: 'zsh', name: 'zsh', executable: '/bin/zsh', args: ['-l'], env: {} }],
  sources: (['claude', 'codex', 'opencode', 'grok', 'antigravity'] as AgentKind[]).map(kind => ({
    id: kind, kind, enabled: true,
    root: { claude: '/Users/you/.claude', codex: '/Users/you/.codex', opencode: '/Users/you/.local/share/opencode', grok: '/Users/you/.grok', antigravity: '/Users/you/.gemini/antigravity-cli' }[kind]!,
  })),
  agentOptions: defaultAgentOptions(),
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
  shortcuts: {}, onboardingComplete: true,
};

// Terminal panes: an agent and a dev server side by side, plus work in other projects for the overview.
const esc = '\x1b[';
const c = (code: string, text: string) => `${esc}${code}m${text}${esc}0m`;
const paneOutput: Record<string, string> = {
  'pane-agent': [
    c('1;36', '> ') + L('Add rate limiting to POST /uploads (60 req/min per API key)', '幫 POST /uploads 加上速率限制（每個 API key 每分鐘 60 次）'),
    '',
    c('2', '● ') + L('Reading src/routes/uploads.ts', '讀取 src/routes/uploads.ts'),
    c('2', '● ') + L('Reading src/http/middleware.ts', '讀取 src/http/middleware.ts'),
    c('32', '● ') + L('Created src/http/rateLimit.ts', '建立 src/http/rateLimit.ts'),
    c('32', '+ ') + 'export function rateLimit({ capacity = 60, refillPerSecond = 1 }) {',
    c('32', '+ ') + '  return async (req, res, next) => {',
    c('32', '+ ') + '    const bucket = await buckets.take(req.apiKey);',
    c('32', '+ ') + '    if (!bucket.ok) return tooManyRequests(res, bucket.retryAfter);',
    c('32', '+ ') + '    next();',
    c('32', '+ ') + '  };',
    c('32', '+ ') + '}',
    c('33', '● ') + L('Running npm test -- rateLimit', '執行 npm test -- rateLimit'),
    c('32', '  ✓ ') + L('allows 60 requests in a minute', '一分鐘內允許 60 次請求'),
    c('32', '  ✓ ') + L('returns 429 with Retry-After on the 61st request', '第 61 次回傳 429 與 Retry-After'),
    c('32', '  ✓ ') + L('refills one token per second', '每秒補充一個 token'),
    '',
    c('1', L('Done. 3 files changed, 3 tests added.', '完成，修改 3 個檔案，新增 3 個測試。')),
    '',
    c('1;36', '> ') + c('2', L('Ask a follow-up…', '繼續提問…')),
  ].join('\r\n'),
  'pane-dev': [
    c('2', '~/code/harbor-api') + ' ' + c('35', 'main*') + ' $ npm run dev',
    '',
    c('36', '[dev]') + ' harbor-api listening on http://localhost:8080',
    c('36', '[dev]') + ' connected to redis://localhost:6379',
    c('2', '[req]') + ' POST /uploads 201 18ms',
    c('2', '[req]') + ' POST /uploads 201 12ms',
    c('2', '[req]') + ' GET  /health 200 1ms',
    c('33', '[req]') + ' POST /uploads 429 2ms  retry-after=1',
    c('2', '[req]') + ' POST /uploads 201 15ms',
    c('36', '[dev]') + ' file changed: src/http/rateLimit.ts, restarting…',
    c('36', '[dev]') + ' harbor-api listening on http://localhost:8080',
    '',
  ].join('\r\n'),
  'pane-web': [
    c('1;36', '> ') + L('Make the usage chart responsive on small screens', '讓用量圖表在小螢幕上也能正常顯示'),
    '',
    c('2', '● ') + L('Reading src/components/UsageChart.tsx', '讀取 src/components/UsageChart.tsx'),
    c('33', '? ') + L('Allow edits to src/components/UsageChart.tsx? (y/n)', '允許修改 src/components/UsageChart.tsx 嗎？(y/n)'),
  ].join('\r\n'),
  'pane-mobile': [
    c('2', '~/code/mobile-app') + ' ' + c('35', 'release/2.4') + ' $ npm test',
    '',
    c('32', ' PASS ') + ' src/auth/login.test.ts',
    c('32', ' PASS ') + ' src/sync/queue.test.ts',
    c('32', ' PASS ') + ' src/ui/Button.test.tsx',
    '',
    'Tests:       48 passed, 48 total',
    'Time:        6.214 s',
    c('2', '~/code/mobile-app') + ' $ ',
  ].join('\r\n'),
  'pane-scratch': [
    c('2', '~') + ' $ brew upgrade gh',
    '==> Upgrading 1 outdated package:',
    'gh 2.81.0 -> 2.82.1',
    c('2', '~') + ' $ ',
  ].join('\r\n'),
};

type PaneSpec = [paneId: string, projectId: string | null, kind: Pane['kind'], title: string];
const panes: PaneSpec[] = [
  ['pane-agent', 'p-harbor', 'claude', L('Rate limiting', '速率限制')],
  ['pane-dev', 'p-harbor', 'shell', 'npm run dev'],
  ['pane-web', 'p-web', 'opencode', L('Responsive chart', '響應式圖表')],
  ['pane-mobile', 'p-mobile', 'shell', 'npm test'],
  ['pane-scratch', null, 'shell', 'zsh'],
];
const runtimes: RuntimeRecord[] = panes.map(([paneId, projectId, kind]) => ({
  id: `runtime-${paneId}`, paneId, projectId, sessionId: paneId === 'pane-agent' ? sessions[0].id : null, profileId: kind === 'shell' ? 'zsh' : null,
  resumeId: null, kind, state: 'running', exitCode: null,
  cwd: projectId ? `${home}/${projects.find(p => p.id === projectId)!.name}` : '/Users/you',
}));
const workspace: Workspace = {
  version: 1,
  tabs: [
    { id: 'tab-harbor', projectId: 'p-harbor', name: L('Rate limiting', '速率限制'), focusedPaneId: 'pane-agent',
      layout: { kind: 'split', id: 'split-harbor', axis: 'horizontal', ratio: 0.58, first: { kind: 'pane', paneId: 'pane-agent' }, second: { kind: 'pane', paneId: 'pane-dev' } } },
    { id: 'tab-web', projectId: 'p-web', name: L('Responsive chart', '響應式圖表'), focusedPaneId: 'pane-web', layout: { kind: 'pane', paneId: 'pane-web' } },
    { id: 'tab-mobile', projectId: 'p-mobile', name: 'npm test', focusedPaneId: 'pane-mobile', layout: { kind: 'pane', paneId: 'pane-mobile' } },
    { id: 'tab-scratch', projectId: null, name: 'zsh', focusedPaneId: 'pane-scratch', layout: { kind: 'pane', paneId: 'pane-scratch' } },
  ],
  panes: Object.fromEntries(panes.map(([id, projectId, kind, title]) => [id, {
    id, title, kind, projectId, cwd: runtimes.find(r => r.paneId === id)!.cwd, profileId: kind === 'shell' ? 'zsh' : undefined,
    state: 'running', runtimeId: `runtime-${id}`, sessionId: id === 'pane-agent' ? sessions[0].id : undefined,
  } as Pane])),
  activeTabByProject: { 'p-harbor': 'tab-harbor', 'p-web': 'tab-web', 'p-mobile': 'tab-mobile' },
  activeTemporaryTabId: 'tab-scratch',
};

const bootstrap: Bootstrap = {
  settings, projects, runtimes, workspace, warnings: [],
  installations: (['claude', 'codex', 'opencode', 'grok', 'antigravity'] as AgentKind[]).map(kind => ({
    kind, executable: `/opt/homebrew/bin/${kind === 'antigravity' ? 'agy' : kind}`, available: true,
    version: { claude: '2.4.1', codex: '0.98.0', opencode: '1.19.4', grok: '0.6.2', antigravity: '1.4.2' }[kind]!,
    status: 'available', error: null,
  })),
  index: { running: false, processed: 1284, total: 1284, cancelled: false, errors: [], sources: [] },
};

const fileText = (path: string) => new TextEncoder().encode(path.endsWith('rateLimit.ts') ? [
  "import { buckets } from './buckets';",
  '',
  'export function rateLimit({ capacity = 60, refillPerSecond = 1 } = {}) {',
  '  return async (req, res, next) => {',
  '    const bucket = await buckets.take(req.apiKey, { capacity, refillPerSecond });',
  '    if (!bucket.ok) return tooManyRequests(res, bucket.retryAfter);',
  '    next();',
  '  };',
  '}',
  '',
].join('\n') : `# ${path}\n\nSynthetic showcase file.\n`);

const kanbanCalls: { command: string; args: Record<string, unknown> }[] = [];
Object.assign(window, { kanbanCalls });
mockWindows('main');
mockIPC((command, payload = {}) => {
  const args = payload as Record<string, unknown>;
  kanbanCalls.push({ command, args });
  switch (command) {
    case 'bootstrap': return bootstrap;
    case 'set_kanban_auto_archive': board.autoArchiveDays = args.days as number | null; return;
    case 'create_kanban_card': return createFixtureCard(board, String(args.columnId), String(args.title), String(args.notes));
    case 'edit_kanban_card': {
      const card = board.cards.find(card => card.id === args.cardId)!;
      card.title = String(args.title); card.notes = String(args.notes); return structuredClone(card);
    }
    case 'archive_kanban_card': {
      const card = board.cards.find(card => card.id === args.cardId)!;
      card.archived = Boolean(args.archived); return structuredClone(card);
    }
    case 'delete_kanban_card': return deleteFixtureCard(board, String(args.cardId), String(args.sessions));
    case 'merge_kanban_cards': return mergeFixtureCards(board, String(args.sourceCardId), String(args.targetCardId));
    case 'split_kanban_session': return splitFixtureSession(board, String(args.cardId), String(args.sessionId));
    case 'trash_session':
      for (const card of board.cards) card.sessions = card.sessions.filter(link => link.session.id !== args.sessionId);
      return 'synthetic-trash-' + String(args.sessionId);
    case 'launch_runtime': {
      const request = args.request as { paneId: string; kind: AgentKind | 'shell'; projectId: string; cwd: string; profileId: string; sessionId?: string };
      const runtime: RuntimeRecord = { id: 'synthetic-runtime-' + runtimes.length, paneId: request.paneId, kind: request.kind,
        projectId: request.projectId, profileId: request.profileId, sessionId: request.sessionId ?? null, resumeId: null,
        cwd: request.cwd, state: 'running', exitCode: null };
      runtimes.push(runtime);
      const channel = args.onEvent as Channel<TerminalEvent>;
      channel.onmessage({ type: 'snapshot', runtimeId: runtime.id, sequence: 1,
        data: Array.from(new TextEncoder().encode('\x1b[?2004hSynthetic ready\r\n')), cols: 80, rows: 24, truncated: false });
      return runtime;
    }
    case 'launch_fresh_runtime': {
      const request = args.request as { kind: AgentKind; projectId: string; cwd: string; profileId: string; kanbanCardId?: string };
      const id = 'synthetic-launched-' + runtimes.length;
      const session: Session = { ...sessions[0], id, kind: request.kind, externalId: id, cwd: request.cwd, title: 'Synthetic started session' };
      const runtime: RuntimeRecord = { id, paneId: id, sessionId: null, providerSessionId: id, kind: request.kind,
        projectId: request.projectId, profileId: request.profileId, resumeId: null, state: 'running', cwd: request.cwd, exitCode: null };
      runtimes.push(runtime); sessions.push(session);
      if (request.kanbanCardId) board.cards.find(card => card.id === request.kanbanCardId)!.sessions.push({ session, branch: null });
      return runtime;
    }
    case 'kanban_board': return args.projectId === board.projectId ? structuredClone(board) : null;
    case 'set_kanban_board_enabled': board.enabled = Boolean(args.enabled); return structuredClone(board);
    case 'move_kanban_card': return structuredClone(moveFixtureCard(board, String(args.cardId), String(args.columnId), Number(args.position)));
    case 'reorder_kanban_columns': {
      (args.columnIds as string[]).forEach((id, position) => { board.columns.find(column => column.id === id)!.position = position; });
      return;
    }
    case 'create_kanban_column': {
      const column = { id: `column-${board.columns.length}`, projectId: board.projectId, name: String(args.name), defaultName: null,
        stage: (args.stage ?? 'doing') as typeof board.columns[number]['stage'], position: board.columns.length, systemRole: null };
      board.columns.push(column);
      return structuredClone(column);
    }
    case 'rename_kanban_column': {
      const column = board.columns.find(column => column.id === args.columnId)!;
      column.name = String(args.name);
      return structuredClone(column);
    }
    case 'set_kanban_column_stage': {
      const column = board.columns.find(column => column.id === args.columnId)!;
      column.stage = args.stage as typeof column.stage;
      return structuredClone(column);
    }
    case 'delete_kanban_column': {
      for (const card of board.cards.filter(card => card.columnId === args.columnId))
        moveFixtureCard(board, card.id, String(args.targetColumnId), board.cards.filter(item => item.columnId === args.targetColumnId).length);
      board.columns = board.columns.filter(column => column.id !== args.columnId);
      board.columns.sort((a, b) => a.position - b.position).forEach((column, index) => { column.position = index; });
      return;
    }
    case 'set_locale': case 'frontend_diagnostic': return true;
    case 'start_index': case 'index_status': return bootstrap.index;
    case 'list_projects': return projects;
    case 'list_runtimes': return runtimes;
    case 'detect_installations': return bootstrap.installations;
    case 'detect_shells': return [];
    case 'query_sessions': {
      const query = args.query as SessionQuery;
      const items = sessions.filter(s => (!query.projectId || s.projectId === query.projectId)
        && (!query.kind || s.kind === query.kind)
        && (!query.query || s.title.toLowerCase().includes(query.query.toLowerCase())));
      return { catalogRevision: 'showcase', items, total: items.length };
    }
    case 'read_transcript': return {
      messages: transcript.map(([role, text], index) => ({ role, text, timestamp: ago(20 - index * 2), line: index + 1 })),
      hasMore: false, beforeLine: null, stale: false, warning: null,
    };
    case 'list_trashed_sessions': return { catalogRevision: 'showcase', total: 1, items: [{
      id: 'trash-1', session: { ...sessions[4], id: 's-trashed', title: L('Try a different logging library', '試用另一套 logging 函式庫') },
      sourceRoot: '/Users/you/.codex', deletedAt: ago(60 * 3), unavailableReason: null }] };
    case 'detect_history_sources': return { kind: args.kind, supported: true, message: null, candidates: [
      { kind: args.kind, root: settings.sources.find(s => s.kind === args.kind)?.root ?? '/Users/you/.agent', status: 'found', configured: true, configuredSourceIds: [String(args.kind)] }] };
    case 'preview_launch': {
      const request = args.request as { kind: string; cwd?: string };
      return { executable: request.kind === 'shell' ? '/bin/zsh' : `/opt/homebrew/bin/${request.kind}`, args: request.kind === 'shell' ? ['-l'] : [], cwd: request.cwd || `${home}/harbor-api` };
    }
    case 'list_workspace_files': return { nextOffset: null, entries: args.path ? [
      { name: 'rateLimit.ts', path: 'src/http/rateLimit.ts', kind: 'file' },
      { name: 'middleware.ts', path: 'src/http/middleware.ts', kind: 'file' },
    ] : [
      { name: 'src', path: 'src', kind: 'directory' }, { name: 'config', path: 'config', kind: 'directory' },
      ...['README.md', 'package.json', 'tsconfig.json'].map(name => ({ name, path: name, kind: 'file' })),
    ] };
    case 'search_workspace_files': return { paths: ['src/http/rateLimit.ts', 'README.md'], truncated: false };
    case 'inspect_workspace_file': {
      const bytes = fileText(String(args.path));
      return { path: args.path, sizeBytes: bytes.length, version: `showcase:${args.path}`, kind: 'text' };
    }
    case 'read_workspace_file_chunk': {
      const bytes = fileText(String(args.path));
      const offset = Number(args.offset), end = Math.min(bytes.length, offset + Number(args.maxBytes));
      return { bytes: Array.from(bytes.subarray(offset, end)), eof: end === bytes.length };
    }
    case 'git_request': case 'git_hosting': {
      // Optional real Git over a synthetic repo (examples/git_bridge.rs), as in the Git browser specs.
      const bridge = params.get('git');
      if (!bridge) throw new Error('Git is not part of this showcase view');
      return fetch(`${bridge}/${command === 'git_request' ? 'git' : 'hosting'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args.request) })
        .then(response => response.json() as Promise<{ ok?: unknown; error?: string }>)
        .then(result => { if (result.error !== undefined) throw result.error; return result.ok; });
    }
    case 'list_os_trashed_sessions': return [];
    case 'attach_runtime': {
      const target = runtimes.find(r => r.id === args.runtimeId)!;
      const channel = args.onEvent as Channel<TerminalEvent>;
      const data = Array.from(new TextEncoder().encode('\x1b[?2004h' + (paneOutput[target.paneId] ?? '$ ')));
      channel.onmessage({ type: 'snapshot', runtimeId: target.id, sequence: 1, data, cols: 120, rows: 32, truncated: false });
      const status = target.paneId === 'pane-web' ? 'permission' : target.paneId === 'pane-agent' ? 'idle' : null;
      if (status) setTimeout(() => channel.onmessage({ type: 'terminalStatus', runtimeId: target.id, generation: 'showcase', revision: 1, status }), 200);
      return target;
    }
    case 'save_settings': return args.settings;
    case 'resize_runtime': case 'ack_runtime': case 'write_runtime': case 'detach_runtime':
    case 'save_workspace': case 'plugin:webview|set_webview_zoom': return;
    default: throw new Error(`Showcase fixture has no data for ${command}`);
  }
}, { shouldMockEvents: true });
Object.assign(window, { isTauri: true });
void import('../../src/App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<App />);
});
