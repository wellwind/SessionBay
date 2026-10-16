import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import { runSmokeInteraction } from './smoke';
import { smokeSnapshot } from './startup';
import { defaultAgentOptions } from './agents';
import { emptyWorkspace } from './workspace';
import type { Bootstrap, Project, Session } from './types';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('./components/WorkspaceCanvas', () => ({ WorkspaceCanvas: () => null }));
vi.mock('./startup', async (original) => ({
  ...await original<typeof import('./startup')>(), smokeSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./api', () => ({
  isDesktop: () => true, call: vi.fn(),
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  api: Object.fromEntries(['bootstrap', 'scan', 'index', 'projects', 'saveWorkspace', 'close', 'stop', 'forget', 'settleLaunches', 'runtimes',
    'launch', 'detect', 'detectShells', 'cancelScan', 'clearIndex', 'saveSettings', 'updateProject', 'addProject',
    'createProject', 'preview', 'sessions', 'transcript', 'detectHistorySources'].map((name) => [name, vi.fn()])),
}));

const root = '/synthetic/isolated-home/sessionbay-smoke-fixture';
function seed(theme: 'dark' | 'light'): Bootstrap {
  return {
    runtimes: [],
    settings: {
      version: 1, theme, terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
      defaultAgent: 'codex', defaultProfileId: 'smoke-shell',
      profiles: [{ id: 'smoke-shell', name: 'POSIX Shell', executable: '/bin/sh', args: [], env: {} }],
      sources: [{ id: 'sessionbay-smoke-codex', kind: 'codex', root: `${root}/codex`, enabled: true },
        { id: 'sessionbay-smoke-antigravity', kind: 'antigravity', root: '/synthetic/isolated-home/.gemini/antigravity-cli', enabled: true }],
      executables: { codex: '/missing/codex', claude: '/missing/claude', grok: '/missing/grok', antigravity: '/missing/agy', opencode: '/missing/opencode' },
      agentOptions: defaultAgentOptions(), shortcuts: {}, onboardingComplete: false,
    },
    installations: ['codex', 'claude', 'grok', 'antigravity', 'opencode'].map((kind) => ({
      kind: kind as 'codex' | 'claude' | 'grok' | 'antigravity' | 'opencode', available: false,
      executable: null, version: null, error: null,
    })),
    projects: [], workspace: emptyWorkspace(), warnings: [],
    index: { revision: 0, running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 40, top: 0, bottom: 40, left: 0, right: 400 } as DOMRect);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(api.runtimes).mockResolvedValue([]);
  vi.mocked(api.forget).mockResolvedValue(undefined);
  vi.mocked(api.settleLaunches).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function drive(probe: Promise<void>) {
  let settled = false;
  let failure: unknown;
  void probe.then(() => { settled = true; }, (error) => { failure = error; settled = true; });
  for (let i = 0; i < 450 && !settled; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  }
  if (failure) throw failure;
  expect(settled, 'smoke interaction should settle within its bounded wait').toBe(true);
}

describe('native visual smoke scenario against real React UI', () => {
  it.each(['dark', 'light'] as const)('reaches all five %s states using only synthetic curation and indexing', async (theme) => {
    const boot = seed(theme);
    let projects: Project[] = [];
    let indexed = false;
    vi.mocked(api.bootstrap).mockResolvedValue(boot);
    vi.mocked(api.projects).mockImplementation(async () => projects.map((project) => ({ ...project })));
    vi.mocked(api.addProject).mockImplementation(async (path, name) => {
      expect([`${root}/workspaces/harbor`, `${root}/workspaces/notes`]).toContain(path);
      const project: Project = { id: path.split('/').at(-1)!, name: name!, path, launchPath: null,
        exists: true, curated: true, pinned: false, sessionCount: 0, updatedAt: null, agents: [] };
      projects = [...projects, project];
      return project;
    });
    vi.mocked(api.scan).mockImplementation(async () => {
      indexed = true;
      projects = [...projects.map((project) => ({ ...project, sessionCount: 1, agents: ['codex'] as const as ['codex'] })),
        { id: 'missing', name: 'missing-worktree', path: `${root}/workspaces/missing`, launchPath: null,
          exists: false, curated: false, pinned: false, sessionCount: 1, updatedAt: null, agents: ['codex'] },
        { id: 'unknown', name: '未分類', path: null, launchPath: null, exists: false, curated: false,
          pinned: false, sessionCount: 1, updatedAt: null, agents: ['codex'] }];
      return { ...boot.index, running: true };
    });
    vi.mocked(api.index).mockImplementation(async () => indexed
      ? { ...boot.index, revision: 1, processed: 4, total: 4 } : boot.index);
    vi.mocked(api.sessions).mockImplementation(async ({ projectId, kind }) => ({ total: 1, items: [{
      id: kind === 'antigravity' ? 'smoke-antigravity-session' : 'smoke-session', externalId: 'smoke-native-session',
      sourceId: kind === 'antigravity' ? 'sessionbay-smoke-antigravity' : 'sessionbay-smoke-codex', kind: kind ?? 'codex',
      projectId: projectId ?? 'harbor', cwd: `${root}/workspaces/harbor`, title: '合成歷史預覽',
      updatedAt: '2026-01-15T09:00:00Z', timeSource: 'event', archived: false, parentId: null, partial: false, snippet: '合成內容',
    } satisfies Session] }));
    vi.mocked(api.transcript).mockImplementation(async (id) => ({ messages: id === 'smoke-antigravity-session' ? [
      { role: 'user', text: 'SESSIONBAY_SYNTHETIC_AG_USER：檢查唯讀歷史預覽。', timestamp: null, line: 1 },
      { role: 'assistant', text: 'SESSIONBAY_SYNTHETIC_AG_ASSISTANT：合成回覆已顯示，沒有啟動 Agent。', timestamp: null, line: 2 },
    ] : [{ role: 'user', text: '合成對話內容', timestamp: null, line: 1 }],
    hasMore: false, beforeLine: null, stale: false, warning: null }));
    vi.mocked(api.preview).mockResolvedValue({ executable: '/bin/sh', args: [], cwd: `${root}/workspaces/harbor` });
    vi.mocked(api.detectHistorySources).mockImplementation(async (kind) => kind === 'antigravity' ? {
      kind, supported: true, message: null, candidates: [
        { kind, root: '/synthetic/isolated-home/.gemini/antigravity-cli', status: 'found', configured: true,
          configuredSourceIds: ['sessionbay-smoke-antigravity'], message: null },
      ],
    } : { kind: 'grok', supported: true, message: null, candidates: [
      { kind: 'grok', root: '/synthetic/isolated-grok', status: 'found', configured: false, configuredSourceIds: [],
        message: 'The root is readable, but the sessions history directory does not exist yet. You can still add this root.' },
      { kind: 'grok', root: '/synthetic/isolated-home/.grok', status: 'missing', configured: false, configuredSourceIds: [], message: 'The history root does not exist.' },
    ] });
    vi.mocked(smokeSnapshot).mockImplementation(async (name) => {
      if (name.startsWith('projects')) expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('專案');
      if (name.startsWith('directories')) expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('所有目錄');
      if (name.startsWith('providers')) {
        expect(document.querySelectorAll('.settings-history-provider')).toHaveLength(5);
        expect(api.detectHistorySources).not.toHaveBeenCalled();
      }
      if (name.startsWith('launcher')) {
        expect(screen.getByRole('dialog', { name: '開始新的工作' })).toContainElement(screen.getByRole('listbox'));
        expect(screen.getAllByRole('option')).toHaveLength(5);
      }
      if (name.startsWith('calendar')) expect(screen.getByRole('grid')).toBeInTheDocument();
    });
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await drive(runSmokeInteraction());
    expect(vi.mocked(smokeSnapshot).mock.calls.map(([name]) => name)).toEqual(
      ['projects', 'directories', 'providers', 'launcher', 'calendar'].map((state) => `${state}-${theme}`),
    );
    expect(api.addProject).toHaveBeenCalledTimes(2);
    expect(api.scan).toHaveBeenCalledOnce();
    expect(vi.mocked(api.detectHistorySources).mock.calls).toEqual([['grok'], ['antigravity']]);
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'antigravity', projectId: 'harbor' }));
    expect(api.transcript).toHaveBeenLastCalledWith('smoke-antigravity-session');
    expect(screen.getByText(/SESSIONBAY_SYNTHETIC_AG_ASSISTANT/)).toBeInTheDocument();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.saveWorkspace).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.preview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'shell', cwd: `${root}/workspaces/harbor` }));
    expect((screen.getByRole('textbox', { name: '開始日期' }) as HTMLInputElement).value).toContain('2026');
  });

  it('rejects a reserved fixture ID with a non-fixture path before any write', async () => {
    const boot = seed('dark');
    boot.settings.sources[0].root = '/unrelated/source';
    vi.mocked(api.bootstrap).mockResolvedValue(boot);
    vi.mocked(api.index).mockResolvedValue(boot.index);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await expect(drive(runSmokeInteraction())).rejects.toThrow('invalid synthetic fixture source');
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
    expect(smokeSnapshot).not.toHaveBeenCalled();
  });
});
