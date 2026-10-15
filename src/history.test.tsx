import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { api } from './api';
import { agentName, HistoryView } from './components/History';
import type { Project, Session, SessionPage, TranscriptPage } from './types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, api: { ...original.api, sessions: vi.fn(), transcript: vi.fn() } };
});

const project: Project = {
  id: 'project-a',
  name: 'Synthetic project',
  path: '/synthetic/project',
  launchPath: null,
  exists: true,
  pinned: false,
  curated: true,
  sessionCount: 2,
  updatedAt: '2026-10-15T01:00:00Z',
  agents: ['codex'],
};
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    sourceId: 'synthetic-source',
    kind: 'codex',
    externalId: `external-${id}`,
    projectId: project.id,
    title: `Session ${id}`,
    cwd: '/synthetic/project',
    updatedAt: '2026-10-15T01:00:00Z',
    timeSource: 'event',
    archived: false,
    parentId: null,
    partial: false,
    snippet: `Snippet ${id}`,
    ...patch,
  };
}
function transcript(text: string, patch: Partial<TranscriptPage> = {}): TranscriptPage {
  return {
    messages: [{ role: 'assistant', text, timestamp: null, line: 100 }],
    hasMore: false,
    beforeLine: null,
    stale: false,
    warning: null,
    ...patch,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
function setup(overrides: Partial<Parameters<typeof HistoryView>[0]> = {}) {
  const props = {
    projects: [project],
    refreshToken: 0,
    onResume: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };
  return { ...render(<HistoryView {...props} />), props };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.sessions)
    .mockReset()
    .mockResolvedValue({ items: [session('alpha')], total: 1 });
  vi.mocked(api.transcript).mockReset().mockResolvedValue(transcript('Synthetic transcript'));
  vi.mocked(isTauri).mockReturnValue(false);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('HistoryView read-only rendering', () => {
  it('renders script and HTML-looking transcript, title and snippets as literal text', async () => {
    const unsafe = '<script>window.sessionBayInjected=true</script><img src=x onerror="alert(1)">';
    vi.mocked(api.sessions).mockResolvedValue({
      items: [session('literal', { title: unsafe, snippet: '<b>not markup</b>' })],
      total: 1,
    });
    vi.mocked(api.transcript).mockResolvedValue(transcript(unsafe));
    const { container, props } = setup();
    await tick();
    expect(screen.getAllByText(unsafe)).toHaveLength(3);
    expect(screen.getByText('<b>not markup</b>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(
      (window as Window & { sessionBayInjected?: boolean }).sessionBayInjected,
    ).toBeUndefined();
    expect(props.onResume).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('starts no Agent while browsing and forwards a session only after explicit resume', async () => {
    const { props } = setup();
    await tick();
    expect(props.onResume).not.toHaveBeenCalled();
    expect(api.transcript).toHaveBeenCalledWith('alpha');
    fireEvent.click(screen.getByRole('button', { name: '接續工作' }));
    expect(props.onResume).toHaveBeenCalledExactlyOnceWith(session('alpha'));
    expect(invoke).not.toHaveBeenCalled();
  });
  it('shows backend errors without presenting fabricated rows', async () => {
    vi.mocked(api.sessions).mockRejectedValue(new Error('索引尚未建立'));
    setup();
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('索引尚未建立');
    expect(screen.queryByRole('button', { name: /Session alpha/ })).not.toBeInTheDocument();
    expect(api.transcript).not.toHaveBeenCalled();
  });
  it('shows unsupported/nontext content as an explicit empty preview', async () => {
    vi.mocked(api.transcript).mockResolvedValue(transcript('', { messages: [] }));
    setup();
    await tick();
    expect(screen.getByText(/目前沒有可預覽的文字內容/)).toBeInTheDocument();
  });
});

describe('HistoryView project selection', () => {
  it('shows the full original cwd and only curates after an explicit click', async () => {
    const cwd = '/synthetic/projects/full/original/worktree';
    const selected = session('alpha', { cwd });
    vi.mocked(api.sessions).mockResolvedValue({ items: [selected], total: 1 });
    const onCurate = vi.fn();
    const { props, rerender } = setup({ projects: [{ ...project, curated: false, launchPath: '/synthetic/relocated' }], onCurate });
    await tick();
    expect(screen.getByRole('region', { name: '對話預覽' })).toHaveTextContent(cwd);
    expect(onCurate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '將此目錄加入專案' }));
    expect(onCurate).toHaveBeenCalledExactlyOnceWith(selected);
    expect(props.onResume).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    rerender(<HistoryView {...props} projects={[project]} />);
    expect(screen.getByText('已加入專案：Synthetic project')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '將此目錄加入專案' })).not.toBeInTheDocument();
  });
  it('offers an explicit directory choice for a session without a recorded cwd', async () => {
    const selected = session('alpha', { cwd: null });
    vi.mocked(api.sessions).mockResolvedValue({ items: [selected], total: 1 });
    const onCurate = vi.fn();
    setup({ projects: [{ ...project, curated: false, path: null, launchPath: null }], onCurate });
    await tick();
    expect(screen.getByRole('region', { name: '對話預覽' })).toHaveTextContent('未記錄工作目錄');
    fireEvent.click(screen.getByRole('button', { name: '選擇目錄並加入專案' }));
    expect(onCurate).toHaveBeenCalledExactlyOnceWith(selected);
  });
  it('disables project selection while a membership mutation is pending', async () => {
    const onCurate = vi.fn();
    setup({ projects: [{ ...project, curated: false }], onCurate, curating: true });
    await tick();
    const button = screen.getByRole('button', { name: '將此目錄加入專案' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCurate).not.toHaveBeenCalled();
  });
});

describe('HistoryView asynchronous race protection', () => {
  it('ignores a previous session transcript that resolves after a new selection', async () => {
    const old = deferred<TranscriptPage>();
    vi.mocked(api.sessions).mockResolvedValue({
      items: [session('alpha'), session('beta')],
      total: 2,
    });
    vi.mocked(api.transcript).mockImplementation((id) =>
      id === 'alpha' ? old.promise : Promise.resolve(transcript('Latest beta transcript')),
    );
    setup();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: /Session beta/ }));
    await tick();
    expect(screen.getByText('Latest beta transcript')).toBeInTheDocument();
    await act(async () => {
      old.resolve(transcript('Old alpha transcript'));
    });
    expect(screen.queryByText('Old alpha transcript')).not.toBeInTheDocument();
    expect(screen.getByText('Latest beta transcript')).toBeInTheDocument();
  });
  it('ignores a previous query result that resolves after the latest query', async () => {
    const old = deferred<SessionPage>();
    vi.mocked(api.sessions)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ items: [session('new-result')], total: 1 });
    setup();
    await tick();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋 Session' }), {
      target: { value: 'new search' },
    });
    await tick(220);
    expect(screen.getByRole('button', { name: /Session new-result/ })).toBeInTheDocument();
    await act(async () => {
      old.resolve({ items: [session('obsolete-result')], total: 1 });
    });
    expect(
      screen.queryByRole('button', { name: /Session obsolete-result/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Session new-result/ })).toBeInTheDocument();
  });
  it('ignores late load-earlier results after switching sessions', async () => {
    const oldEarlier = deferred<TranscriptPage>();
    vi.mocked(api.sessions).mockResolvedValue({
      items: [session('alpha'), session('beta')],
      total: 2,
    });
    vi.mocked(api.transcript).mockImplementation((id, beforeLine) => {
      if (beforeLine !== undefined) return oldEarlier.promise;
      return Promise.resolve(
        transcript(id === 'alpha' ? 'Recent alpha' : 'Current beta', {
          hasMore: id === 'alpha',
          beforeLine: id === 'alpha' ? 90 : null,
        }),
      );
    });
    setup();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
    fireEvent.click(screen.getByRole('button', { name: /Session beta/ }));
    await tick();
    await act(async () => {
      oldEarlier.resolve(transcript('Earlier alpha'));
    });
    expect(screen.getByText('Current beta')).toBeInTheDocument();
    expect(screen.queryByText('Earlier alpha')).not.toBeInTheDocument();
  });
  it('ignores a late query failure after a newer query succeeded', async () => {
    const old = deferred<SessionPage>();
    vi.mocked(api.sessions)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ items: [session('latest')], total: 1 });
    setup();
    await tick();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋 Session' }), {
      target: { value: 'latest' },
    });
    await tick(220);
    await act(async () => {
      old.reject(new Error('Old query failed'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Session latest/ })).toBeInTheDocument();
  });
});

describe('HistoryView transcript paging and reload', () => {
  it('loads earlier messages using the cursor and prepends them in chronological order', async () => {
    vi.mocked(api.transcript)
      .mockResolvedValueOnce(transcript('Recent message', { hasMore: true, beforeLine: 90 }))
      .mockResolvedValueOnce(
        transcript('Earlier message', {
          messages: [{ role: 'user', text: 'Earlier message', timestamp: null, line: 10 }],
        }),
      );
    const { container } = setup();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
    await tick();
    expect(api.transcript).toHaveBeenNthCalledWith(2, 'alpha', 90);
    expect(
      [...container.querySelectorAll('.message-text')].map((element) => element.textContent),
    ).toEqual(['Earlier message', 'Recent message']);
    expect(screen.queryByRole('button', { name: '載入更早的對話' })).not.toBeInTheDocument();
  });
  it('reloads a stale transcript from the latest page and clears the stale warning', async () => {
    vi.mocked(api.transcript)
      .mockResolvedValueOnce(transcript('Old preview', { stale: true }))
      .mockResolvedValueOnce(transcript('Updated preview'));
    setup();
    await tick();
    expect(screen.getByText(/來源已變更，索引可能尚未更新/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新讀取' }));
    await tick();
    expect(api.transcript).toHaveBeenNthCalledWith(2, 'alpha');
    expect(screen.getByText('Updated preview')).toBeInTheDocument();
    expect(screen.queryByText('Old preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新讀取' })).not.toBeInTheDocument();
  });
  it('can retry a failed transcript without launching a runtime', async () => {
    vi.mocked(api.transcript)
      .mockRejectedValueOnce(new Error('來源暫時無法讀取'))
      .mockResolvedValueOnce(transcript('Recovered transcript'));
    setup();
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('來源暫時無法讀取');
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    await tick();
    expect(screen.getByText('Recovered transcript')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('prevents duplicate earlier-page loads while a request is pending', async () => {
    const earlier = deferred<TranscriptPage>();
    vi.mocked(api.transcript)
      .mockResolvedValueOnce(transcript('Recent', { hasMore: true, beforeLine: 90 }))
      .mockReturnValueOnce(earlier.promise);
    setup();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
    const pending = screen.getByRole('button', { name: '讀取中…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(api.transcript).toHaveBeenCalledTimes(2);
    await act(async () => {
      earlier.resolve(transcript('Earlier'));
    });
  });
});

describe('HistoryView search and filters', () => {
  it('debounces search and uses trimmed query text', async () => {
    setup();
    await tick();
    const search = screen.getByRole('textbox', { name: '搜尋 Session' });
    fireEvent.change(search, { target: { value: 'n' } });
    await tick(100);
    fireEvent.change(search, { target: { value: '  needle  ' } });
    await tick(219);
    expect(api.sessions).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(api.sessions).toHaveBeenCalledTimes(2);
    expect(api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'needle', offset: 0, limit: 40 }),
    );
  });
  it('converts date filters to local day boundaries and includes agent/archive/child filters', async () => {
    setup({ projectId: project.id });
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '篩選' }));
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('結束日期'), { target: { value: '2026-10-15' } });
    fireEvent.click(screen.getByRole('combobox', { name: '篩選 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('combobox', { name: '封存狀態' }));
    fireEvent.click(screen.getByRole('option', { name: '包含封存' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '包含子代理與分支' }));
    await tick();
    expect(api.sessions).toHaveBeenLastCalledWith({
      projectId: project.id,
      kind: 'claude',
      query: undefined,
      archived: undefined,
      includeChildren: true,
      after: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(),
      before: new Date(2026, 9, 15, 23, 59, 59, 999).toISOString(),
      offset: 0,
      limit: 40,
    });
  });
  it('pages by 40 and resets to the first page after a search change', async () => {
    const items = Array.from({ length: 40 }, (_, i) => session(`row-${i}`));
    vi.mocked(api.sessions).mockResolvedValue({ items, total: 85 });
    setup();
    await tick();
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一頁' }));
    await tick();
    expect(api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 40, limit: 40 }),
    );
    expect(screen.getByText('41–80 / 85')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋 Session' }), {
      target: { value: 'new' },
    });
    await tick(220);
    expect(api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'new', offset: 0 }),
    );
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();
  });
  it('keeps project-specific search filters when switching projects', async () => {
    const { props, rerender } = setup({ projectId: project.id });
    await tick();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋 Session' }), {
      target: { value: 'alpha search' },
    });
    await tick(220);
    rerender(<HistoryView {...props} projectId="project-b" />);
    await tick();
    expect(screen.getByRole('textbox', { name: '搜尋 Session' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋 Session' }), {
      target: { value: 'beta search' },
    });
    await tick(220);
    rerender(<HistoryView {...props} projectId={project.id} />);
    await tick(220);
    expect(screen.getByRole('textbox', { name: '搜尋 Session' })).toHaveValue('alpha search');
    expect(api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: project.id, query: 'alpha search' }),
    );
  });
  it('collapses and reopens the preview without restarting the transcript request', async () => {
    setup();
    await tick();
    fireEvent.click(screen.getByRole('button', { name: '收合預覽' }));
    expect(screen.queryByRole('region', { name: '對話預覽' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '顯示預覽' }));
    expect(
      within(screen.getByRole('region', { name: '對話預覽' })).getByText('Synthetic transcript'),
    ).toBeInTheDocument();
    expect(api.transcript).toHaveBeenCalledTimes(1);
  });
});

describe('browser-only safety', () => {
  it('makes no history API requests when disabled in the disconnected browser shell', async () => {
    const { props } = setup({ disabled: true });
    await tick(1000);
    expect(api.sessions).not.toHaveBeenCalled();
    expect(api.transcript).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '開始新工作' })).toBeDisabled();
    expect(props.onNew).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects direct real API calls before invoking Tauri in a regular browser', async () => {
    const realApi = await vi.importActual<typeof import('./api')>('./api');
    await expect(realApi.api.sessions({ query: 'anything' })).rejects.toThrow('桌面執行環境未連線');
    await expect(realApi.api.transcript('synthetic-session')).rejects.toThrow('桌面執行環境未連線');
    await expect(
      realApi.api.launch({ paneId: 'synthetic-pane', kind: 'shell', cols: 80, rows: 24 }, () => {}),
    ).rejects.toThrow('桌面執行環境未連線');
    expect(invoke).not.toHaveBeenCalled();
  });
});


describe('additional agent history capabilities', () => {
  it('labels all four tools without implying Antigravity has an indexed history filter', async () => {
    expect(agentName('grok')).toBe('Grok Build');
    expect(agentName('antigravity')).toBe('Antigravity CLI');
    setup();
    await tick();
    const filter = screen.getByRole('combobox', { name: '篩選 Agent' });
    fireEvent.click(filter);
    expect(screen.getAllByRole('option').map((option) => option.textContent))
      .toEqual(['所有 Agent', 'CCodex', '✳Claude Code', 'GGrok Build']);
    expect(screen.queryByRole('option', { name: 'Antigravity CLI' })).not.toBeInTheDocument();
  });
  it('queries Grok history and forwards its catalog session only on explicit resume', async () => {
    const grokSession = session('grok-session', { kind: 'grok', externalId: 'grok-external', title: 'Synthetic Grok conversation' });
    vi.mocked(api.sessions).mockResolvedValue({ items: [grokSession], total: 1 });
    const { props } = setup();
    await tick();
    fireEvent.click(screen.getByRole('combobox', { name: '篩選 Agent' }));
    fireEvent.click(screen.getByRole('option', { name: 'Grok Build' }));
    await tick(300);
    expect(api.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'grok' }));
    expect(screen.getAllByText('Grok Build').length).toBeGreaterThan(1);
    expect(props.onResume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '接續工作' }));
    expect(props.onResume).toHaveBeenCalledExactlyOnceWith(grokSession);
    expect(invoke).not.toHaveBeenCalled();
  });
});


it('cannot resume or curate stale project results while the next directory is loading', async () => {
  const next = deferred<SessionPage>();
  vi.mocked(api.sessions).mockResolvedValueOnce({ items: [session('project-a-session')], total: 1 }).mockReturnValueOnce(next.promise);
  const onResume = vi.fn();
  const onCurate = vi.fn();
  const { props, rerender } = setup({ projectId: project.id, onResume, onCurate, projects: [{ ...project, curated: false }] });
  await tick();
  expect(screen.getByRole('button', { name: '接續工作' })).toBeEnabled();
  rerender(<HistoryView {...props} projectId="project-b" />);
  expect(screen.queryByRole('button', { name: '接續工作' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '將此目錄加入專案' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Session project-a-session/ })).not.toBeInTheDocument();
  await tick();
  await act(async () => next.resolve({ items: [session('project-b-session', { projectId: 'project-b', cwd: '/synthetic/b' })], total: 1 }));
  fireEvent.click(screen.getByRole('button', { name: '接續工作' }));
  expect(onResume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: 'project-b' }));
  expect(onCurate).not.toHaveBeenCalled();
});
