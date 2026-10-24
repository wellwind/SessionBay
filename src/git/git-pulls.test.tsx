import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PullRequestView } from './PullRequestView';
import { PullsPanel } from './PullsPanel';
import { parsePatch } from './patch-parse';
import { gitApi } from './git-api';
import { hostingApi } from './hosting-api';
import type { PullDetail } from './types';

vi.mock('./git-api', () => ({ gitApi: { pulls: vi.fn(), pullDetail: vi.fn(), pullFiles: vi.fn(), pullComments: vi.fn(), pullComment: vi.fn(), pullReview: vi.fn(), pullMerge: vi.fn(), pullCreate: vi.fn() } }));
vi.mock('./hosting-api', () => ({ hostingApi: { mappings: vi.fn(), openExternal: vi.fn() } }));

const summary = { number: 7, title: 'Add feature', state: 'open' as const, draft: false, author: 'bob', sourceBranch: 'feature', targetBranch: 'main',
  headSha: 'a'.repeat(40), updatedAt: '', webUrl: 'https://github.com/team/app/pull/7' };
const detail = (extra: Partial<PullDetail> = {}): PullDetail => ({ summary, body: 'Body', baseSha: 'b'.repeat(40), startSha: 'b'.repeat(40), mergeable: true, mergeStatus: 'clean',
  approvedBy: [], viewerApproved: false, ci: { state: 'unknown', checks: [], fetchedAt: 0, webUrl: null, sha: summary.headSha },
  capabilities: { canComment: true, canApprove: true, canRequestChanges: true, canMerge: true, mergeMethods: ['merge', 'squash'], notes: [] },
  connection: { id: 'c1', account: 'alice', host: 'github.com', provider: 'github' }, ...extra });
const request = { repoId: 'r1', remote: 'origin', number: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitApi.pullDetail).mockResolvedValue(detail());
  vi.mocked(gitApi.pullFiles).mockResolvedValue({ files: [{ path: 'src/a.rs', oldPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n ctx\n-a\n+b' }], truncated: false });
  vi.mocked(gitApi.pullComments).mockResolvedValue([{ id: '1', author: 'carol', body: 'nit', createdAt: '', path: 'src/a.rs', line: 2, side: 'new', outdated: false }]);
  vi.mocked(gitApi.pullReview).mockResolvedValue(null);
  vi.mocked(gitApi.pullMerge).mockResolvedValue(null);
  vi.mocked(gitApi.pullComment).mockResolvedValue(null);
});

describe('patch parsing', () => {
  it('numbers old and new lines', () => {
    const [hunk] = parsePatch('@@ -3,2 +3,3 @@ fn\n ctx\n-old\n+new\n+more\n');
    expect(hunk.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([['context', 3, 3], ['delete', 4, null], ['add', null, 4], ['add', null, 5]]);
  });
});

describe('pull request view', () => {
  it('shows unknown CI honestly and binds review and merge to the shown head', async () => {
    render(<PullRequestView projectId="p" repoId="r1" remote="origin" number={7} />);
    expect(await screen.findByText('狀態未知')).toBeInTheDocument();
    expect(screen.getByText(/非即時/)).toBeInTheDocument();
    expect(screen.getByText('nit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '核准此版本' }));
    await waitFor(() => expect(gitApi.pullReview).toHaveBeenCalledWith('p', { ...request, event: 'approve', body: '', expectedHead: 'a'.repeat(40) }));
    fireEvent.click(screen.getByRole('button', { name: '合併：Squash…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/未確認通過/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '合併' }));
    await waitFor(() => expect(gitApi.pullMerge).toHaveBeenCalledWith('p', { ...request, method: 'squash', expectedHead: 'a'.repeat(40) }));
  });

  it('reloads when the remote head moved and anchors line comments', async () => {
    vi.mocked(gitApi.pullReview).mockRejectedValueOnce(new Error('遠端已有新的 commit（aaaaaaa → ccccccc）；先前的檢視已失效'));
    render(<PullRequestView projectId="p" repoId="r1" remote="origin" number={7} />);
    fireEvent.change(await screen.findByLabelText('留言或 review 說明'), { target: { value: 'Please fix' } });
    vi.mocked(gitApi.pullDetail).mockResolvedValue(detail({ summary: { ...summary, headSha: 'c'.repeat(40) } }));
    fireEvent.click(screen.getByRole('button', { name: '要求變更' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('遠端已有新的 commit');
    await waitFor(() => expect(screen.getByText('cccccccccccc')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '在 src/a.rs 新版第 2 行留言' }));
    fireEvent.change(screen.getByLabelText(/留言（綁定 head cccccc/), { target: { value: 'line note' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '留言' }));
    await waitFor(() => expect(gitApi.pullComment).toHaveBeenCalledWith('p', { ...request, body: 'line note', expectedHead: 'c'.repeat(40),
      position: { path: 'src/a.rs', oldPath: null, side: 'new', line: 2 } }));
  });

  it('hides actions the platform or permissions do not allow', async () => {
    vi.mocked(gitApi.pullDetail).mockResolvedValue(detail({ mergeable: false, mergeStatus: 'dirty',
      capabilities: { canComment: true, canApprove: false, canRequestChanges: false, canMerge: false, mergeMethods: [], notes: ['GitHub 不允許核准或要求變更自己的 PR'] } }));
    render(<PullRequestView projectId="p" repoId="r1" remote="origin" number={7} />);
    expect(await screen.findByText('GitHub 不允許核准或要求變更自己的 PR')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '核准此版本' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /合併：/ })).not.toBeInTheDocument();
    expect(screen.getByText(/在 Session Bay 解決衝突後推送/)).toBeInTheDocument();
  });
});

describe('pulls panel', () => {
  const repo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false };
  const status = { repoId: 'r1', revision: 'x', operation: null, stashCount: 0, truncated: false, entries: [],
    branch: { oid: 'a', head: 'feature', upstream: 'origin/feature', ahead: 0, behind: 0, unborn: false } };
  it('requires a confirmed mapping and creates from the current branch', async () => {
    vi.mocked(hostingApi.mappings).mockResolvedValue([{ remote: 'origin', url: '', parsed: null, candidates: [], suggested: null,
      mapping: { repoId: 'r1', remote: 'origin', connectionId: 'c1', project: 'team/app' } }]);
    vi.mocked(gitApi.pulls).mockResolvedValue([summary]);
    vi.mocked(gitApi.pullCreate).mockResolvedValue({ ...summary, number: 8 });
    const onOpen = vi.fn();
    render(<PullsPanel projectId="p" repo={repo} status={status} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: '#7 Add feature' }));
    expect(onOpen).toHaveBeenCalledWith('origin', summary);
    fireEvent.click(screen.getByRole('button', { name: '從 feature 建立 PR／MR…' }));
    fireEvent.change(screen.getByLabelText('標題'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: '建立' }));
    await waitFor(() => expect(gitApi.pullCreate).toHaveBeenCalledWith('p', { repoId: 'r1', remote: 'origin', title: 'New', body: '', source: 'feature', target: 'main', draft: false }));
  });
  it('explains when no remote is mapped', async () => {
    vi.mocked(hostingApi.mappings).mockResolvedValue([]);
    render(<PullsPanel projectId="p" repo={repo} status={status} onOpen={vi.fn()} />);
    expect(await screen.findByText(/尚無已確認對應主機帳號的 remote/)).toBeInTheDocument();
  });
});
