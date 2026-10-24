import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from './DiffView';
import type { DiffPreferences } from './DiffView';
import { gitApi } from './git-api';
import { documentKey, documentsReducer, emptyDocuments } from './git-documents';
import { wordDiff } from './word-diff';
import { buildRows } from './diff-rows';
import type { FileDiff } from './types';

vi.mock('./git-api', () => ({ gitApi: { diff: vi.fn(), stageSelection: vi.fn(), unstageSelection: vi.fn(), stagePaths: vi.fn(), unstagePaths: vi.fn() } }));
vi.mock('./diff-syntax', () => ({ highlight: vi.fn().mockResolvedValue(null) }));

const fileDiff = (extra: Partial<FileDiff> = {}): FileDiff => ({
  repoId: 'r1', path: { path: 'src/a.ts' }, oldPath: null, source: { kind: 'unstaged' }, ignoreWhitespace: false,
  binary: false, newFile: false, deletedFile: false, renamed: false, submodule: false, oldMode: '100644', newMode: '100644',
  tooLarge: false, truncated: false, unsupportedEncoding: false, snapshot: 'snap-1', partialBlocked: null,
  hunks: [{ header: '@@ -1,4 +1,4 @@', oldStart: 1, oldCount: 4, newStart: 1, newCount: 4, lines: [
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1, noNewline: false, crlf: false, clipped: false },
    { kind: 'delete', text: 'b', oldLine: 2, newLine: null, noNewline: false, crlf: false, clipped: false },
    { kind: 'add', text: 'B', oldLine: null, newLine: 2, noNewline: false, crlf: false, clipped: false },
    { kind: 'context', text: 'c', oldLine: 3, newLine: 3, noNewline: false, crlf: false, clipped: false },
    { kind: 'delete', text: 'd', oldLine: 4, newLine: null, noNewline: false, crlf: true, clipped: false },
    { kind: 'add', text: 'D', oldLine: null, newLine: 4, noNewline: true, crlf: false, clipped: false },
  ] }],
  ...extra,
});

function Host({ revision = 'rev-1', source = { kind: 'unstaged' } as const, onChanged = vi.fn() }: { revision?: string; source?: { kind: 'unstaged' } | { kind: 'staged' }; onChanged?: () => void }) {
  const [preferences, setPreferences] = useState<DiffPreferences>({ mode: 'inline', ignoreWhitespace: false });
  return <DiffView projectId="p" repoId="r1" repoName="app" path={{ path: 'src/a.ts' }} oldPath={null} source={source} untracked={false}
    revision={revision} preferences={preferences} onPreferences={setPreferences} onChanged={onChanged} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitApi.diff).mockResolvedValue(fileDiff());
  vi.mocked(gitApi.stageSelection).mockResolvedValue(null);
  vi.mocked(gitApi.unstageSelection).mockResolvedValue(null);
});

describe('word diff and rows', () => {
  it('marks only changed tokens and gives up on huge lines', () => {
    expect(wordDiff('const value = 1;', 'const value = 2;')).toEqual({ removed: [[14, 15]], added: [[14, 15]] });
    expect(wordDiff('中文 測試', '中文 驗證')?.added).toEqual([[3, 5]]);
    expect(wordDiff('x '.repeat(400), 'y '.repeat(400))).toBeNull();
  });
  it('pairs deletions with additions in split mode', () => {
    const rows = buildRows(fileDiff().hunks, 'split');
    const split = rows.filter(row => row.type === 'split');
    expect(split).toHaveLength(4);
    expect(split[1]).toMatchObject({ left: { data: { text: 'b' } }, right: { data: { text: 'B' } }, blockStart: true });
  });
});

describe('Git document identity', () => {
  it('separates same file names across repositories and sources', () => {
    const path = { path: 'README.md' };
    const unstaged = { kind: 'diff' as const, path, oldPath: null, untracked: false, source: { kind: 'unstaged' as const } };
    expect(documentKey('r1', unstaged)).not.toBe(documentKey('r2', unstaged));
    expect(documentKey('r1', unstaged)).not.toBe(documentKey('r1', { ...unstaged, source: { kind: 'staged' } }));
    let state = documentsReducer(emptyDocuments, { type: 'open', repoId: 'r1', repoName: 'app', spec: unstaged });
    state = documentsReducer(state, { type: 'open', repoId: 'r2', repoName: 'app', spec: unstaged });
    expect(state.documents).toHaveLength(2);
    state = documentsReducer(state, { type: 'open', repoId: 'r1', repoName: 'app', spec: unstaged });
    expect(state.documents).toHaveLength(2);
    expect(state.active).toBe(documentKey('r1', unstaged));
  });
});

describe('DiffView partial staging', () => {
  it('stages exactly the selected lines from the shown snapshot', async () => {
    const onChanged = vi.fn();
    render(<Host onChanged={onChanged} />);
    const deleteD = await screen.findByRole('checkbox', { name: '選取刪除第 4 行' });
    fireEvent.click(deleteD);
    fireEvent.click(screen.getByRole('checkbox', { name: '選取新增第 4 行' }));
    expect(screen.getByTitle('CRLF 行尾')).toBeInTheDocument();
    expect(screen.getByTitle('檔案結尾沒有換行')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暫存所選 2 行' }));
    await waitFor(() => expect(gitApi.stageSelection).toHaveBeenCalledWith('p', {
      repoId: 'r1', path: { path: 'src/a.ts' }, untracked: false, snapshot: 'snap-1',
      selection: { kind: 'lines', lines: [{ hunk: 0, line: 4 }, { hunk: 0, line: 5 }] },
    }));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText('已暫存所選 2 行。')).toBeInTheDocument();
  });

  it('selects a range with shift-click and unstages a hunk from the staged source', async () => {
    render(<Host source={{ kind: 'staged' }} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '選取刪除第 2 行' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '選取刪除第 4 行' }), { shiftKey: true });
    expect(screen.getByRole('button', { name: '取消暫存所選 3 行' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /取消暫存此區塊/ }));
    await waitFor(() => expect(gitApi.unstageSelection).toHaveBeenCalledWith('p', expect.objectContaining({ selection: { kind: 'hunks', hunks: [0] } })));
  });

  it('clears selections when an external change produces a new snapshot', async () => {
    const view = render(<Host />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '選取新增第 2 行' }));
    vi.mocked(gitApi.diff).mockResolvedValue(fileDiff({ snapshot: 'snap-2' }));
    view.rerender(<Host revision="rev-2" />);
    expect(await screen.findByText(/已在外部變更/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '選取新增第 2 行' })).toHaveAttribute('aria-checked', 'false');
  });

  it('offers whole-file actions only when partial operations are blocked', async () => {
    vi.mocked(gitApi.diff).mockResolvedValue(fileDiff({ binary: true, hunks: [], partialBlocked: '非文字檔不提供部分行操作；請整檔暫存或取消暫存' }));
    vi.mocked(gitApi.stagePaths).mockResolvedValue(null);
    render(<Host />);
    expect(await screen.findByText(/非文字檔案已變更/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^選取/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暫存整個檔案' }));
    await waitFor(() => expect(gitApi.stagePaths).toHaveBeenCalledWith('p', 'r1', [{ path: 'src/a.ts' }]));
  });

  it('requests a whitespace-insensitive view without staging from it', async () => {
    render(<Host />);
    await screen.findByRole('checkbox', { name: '選取新增第 2 行' });
    vi.mocked(gitApi.diff).mockResolvedValue(fileDiff({ ignoreWhitespace: true, partialBlocked: '「忽略空白」只影響檢視' }));
    await act(async () => { fireEvent.click(screen.getByLabelText('忽略空白')); });
    await waitFor(() => expect(gitApi.diff).toHaveBeenLastCalledWith('p', expect.objectContaining({ ignoreWhitespace: true })));
    expect(await screen.findByText('「忽略空白」只影響檢視')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^選取/ })).not.toBeInTheDocument();
  });
});
