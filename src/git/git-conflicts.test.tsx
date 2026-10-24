import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAll, chooseBlock, parseConflicts } from './conflict-markers';
import { ConflictView } from './ConflictView';
import { OperationBar } from './OperationBar';
import { gitApi } from './git-api';
import type { ConflictFile, RepoStatus } from './types';

vi.mock('./git-api', () => ({ gitApi: { conflictFile: vi.fn(), saveConflict: vi.fn(), markResolved: vi.fn(), resolveWith: vi.fn(), continueOperation: vi.fn(), abortOperation: vi.fn() } }));

const marked = 'a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nb\n';
const side = (label: string, text: string | null, present = true) => ({ label, detail: '', present, oid: present ? 'x' : null, mode: present ? '100644' : null, size: text?.length ?? 4, text });
const file = (extra: Partial<ConflictFile> = {}): ConflictFile => ({ path: { path: 'f.txt' }, operation: 'merge', token: 't1', unmerged: true, textual: true,
  base: side('共同祖先（base）', 'a\nbase\nb\n'), ours: side('目前 branch（main）', 'a\nours\nb\n'), theirs: side('要合併進來的版本', 'a\ntheirs\nb\n'),
  result: side('結果（工作目錄檔案）', marked), ...extra });

describe('conflict markers', () => {
  it('parses standard, diff3 and CRLF blocks and applies choices', () => {
    expect(parseConflicts(marked)).toMatchObject([{ start: 1, end: 5, ours: ['ours'], theirs: ['theirs'], oursLabel: 'HEAD', theirsLabel: 'topic', base: null }]);
    const diff3 = 'x\n<<<<<<< ours\n1\n||||||| base\n0\n=======\n2\n>>>>>>> theirs\n';
    expect(parseConflicts(diff3)[0].base).toEqual(['0']);
    expect(chooseBlock(diff3, 0, 'base')).toBe('x\n0\n');
    const crlf = '<<<<<<< a\r\nl\r\n=======\r\nr\r\n>>>>>>> b\r\n';
    expect(chooseBlock(crlf, 0, 'theirs')).toBe('r\r\n');
    expect(chooseBlock(marked, 0, 'both')).toBe('a\nours\ntheirs\nb\n');
    expect(chooseBlock(marked, 0, 'bothReverse')).toBe('a\ntheirs\nours\nb\n');
    expect(chooseAll(`${marked}${marked}`, 'ours')).toBe('a\nours\nb\na\nours\nb\n');
    expect(parseConflicts('<<<<<<< unclosed\nx\n')).toEqual([]);
  });
});

describe('conflict view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitApi.conflictFile).mockResolvedValue(file());
    vi.mocked(gitApi.saveConflict).mockResolvedValue({ token: 't2' });
    vi.mocked(gitApi.markResolved).mockResolvedValue({ message: '已將 f.txt 標記為已解決', recovery: null, conflicts: false });
  });

  it('separates saving from marking resolved', async () => {
    const onChanged = vi.fn();
    render(<ConflictView projectId="p" repoId="r1" repoName="app" path={{ path: 'f.txt' }} revision="r" onChanged={onChanged} />);
    expect(await screen.findByText('剩 1 個衝突區塊')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '目前 branch（main）' })).toHaveTextContent('ours');
    const resolve = screen.getByRole('button', { name: '標記為已解決' });
    expect(resolve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '採用「目前 branch（main）」' }));
    expect(screen.getByLabelText('合併結果內容')).toHaveValue('a\nours\nb\n');
    expect(screen.getByText(/未儲存/)).toBeInTheDocument();
    expect(resolve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '儲存結果' }));
    await waitFor(() => expect(gitApi.saveConflict).toHaveBeenCalledWith('p', { repoId: 'r1', path: { path: 'f.txt' }, token: 't1', content: 'a\nours\nb\n' }));
    await waitFor(() => expect(resolve).toBeEnabled());
    fireEvent.click(resolve);
    await waitFor(() => expect(gitApi.markResolved).toHaveBeenCalledWith('p', { repoId: 'r1', path: { path: 'f.txt' }, token: 't2', allowMarkers: false }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('requires explicit confirmation to keep markers', async () => {
    render(<ConflictView projectId="p" repoId="r1" repoName="app" path={{ path: 'f.txt' }} revision="r" onChanged={vi.fn()} />);
    const resolve = await screen.findByRole('button', { name: '標記為已解決' });
    expect(resolve).toBeDisabled();
    fireEvent.click(screen.getByLabelText('我確定要保留衝突標記'));
    fireEvent.click(resolve);
    await waitFor(() => expect(gitApi.markResolved).toHaveBeenCalledWith('p', expect.objectContaining({ allowMarkers: true, token: 't1' })));
  });

  it('offers whole-file decisions for binary and delete conflicts', async () => {
    vi.mocked(gitApi.conflictFile).mockResolvedValue(file({ textual: false, theirs: side('要合併進來的版本', null, false), ours: side('目前 branch（main）', null), result: side('結果', null) }));
    vi.mocked(gitApi.resolveWith).mockResolvedValue({ message: 'ok', recovery: null, conflicts: false });
    render(<ConflictView projectId="p" repoId="r1" repoName="app" path={{ path: 'f.txt' }} revision="r" onChanged={vi.fn()} />);
    expect(await screen.findByText(/此側沒有這個檔案/)).toBeInTheDocument();
    expect(screen.queryByLabelText('合併結果內容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '採用「要合併進來的版本」' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '採用「目前 branch（main）」' }));
    fireEvent.change(screen.getByLabelText(/改用新路徑保存/), { target: { value: 'kept.bin' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await waitFor(() => expect(gitApi.resolveWith).toHaveBeenCalledWith('p', { repoId: 'r1', path: { path: 'f.txt' }, token: 't1', choice: 'ours', newPath: { path: 'kept.bin' } }));
  });
});

describe('operation bar', () => {
  const status = (conflict: boolean): RepoStatus => ({ repoId: 'r1', revision: 'x', operation: 'merge', stashCount: 0, truncated: false,
    branch: { oid: 'a', head: 'main', upstream: null, ahead: 0, behind: 0, unborn: false },
    entries: conflict ? [{ path: { path: 'f.txt' }, staged: null, unstaged: null, untracked: false, conflict: 'bothModified', submodule: false, modes: ['100644', '100644', '100644'] }] : [] });
  const repo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false };
  it('continues only without conflicts and aborts with a recovery note', async () => {
    vi.mocked(gitApi.abortOperation).mockResolvedValue({ message: 'aborted', recovery: null, conflicts: false });
    const view = render(<OperationBar projectId="p" repo={repo} status={status(true)} onOutcome={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    view.rerender(<OperationBar projectId="p" repo={repo} status={status(false)} onOutcome={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Abort…' }));
    expect(screen.getByText(/中止前自動建立復原點/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/操作中的結果會被捨棄/));
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(gitApi.abortOperation).toHaveBeenCalledWith('p', { repoId: 'r1' }));
  });
});
