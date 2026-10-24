import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLanes, layout } from './graph-lanes';
import { GraphView } from './GraphView';
import { BlameView } from './BlameView';
import { gitApi } from './git-api';
import type { LogCommit } from './types';

vi.mock('./git-api', () => ({ gitApi: { log: vi.fn(), commitDetail: vi.fn(), changedFiles: vi.fn(), diff: vi.fn(), blame: vi.fn() } }));
vi.mock('./diff-syntax', () => ({ highlight: vi.fn().mockResolvedValue(null) }));

const commit = (oid: string, parents: string[], extra: Partial<LogCommit> = {}): LogCommit => ({
  oid: oid.padEnd(40, '0'), parents: parents.map(p => p.padEnd(40, '0')), author: 'Synthetic', email: 's@example.invalid',
  authoredAt: 1_700_000_000, committedAt: 1_700_000_000, subject: `commit ${oid}`, refs: [], ...extra,
});
// merge(m) <- main(b), topic(t) <- base(a)
const history = [commit('m', ['b', 't']), commit('b', ['a']), commit('t', ['a']), commit('a', [])];

describe('graph lanes', () => {
  it('draws a branch and its merge on separate lanes', () => {
    const { rows, state } = layout(history, emptyLanes());
    expect(rows.map(row => row.column)).toEqual([0, 0, 1, 0]);
    expect(rows[0].below).toEqual([{ lane: 0, continues: false, fromCommit: true }, { lane: 1, continues: false, fromCommit: true }]);
    // The topic lane passes beside main, then joins the base commit.
    expect(rows[1].above).toEqual([{ lane: 0, intoCommit: true }, { lane: 1, intoCommit: false }]);
    // Topic joins main's lane right below its own commit.
    expect(rows[2].below).toEqual([{ lane: 0, continues: true, fromCommit: true }]);
    expect(rows[3].above).toEqual([{ lane: 0, intoCommit: true }]);
    expect(rows[3].below).toEqual([]);
    expect(state.lanes).toEqual([]);
  });
  it('produces the same rows when laid out page by page', () => {
    const whole = layout(history, emptyLanes()).rows;
    const first = layout(history.slice(0, 2), emptyLanes());
    const second = layout(history.slice(2), first.state);
    expect([...first.rows, ...second.rows]).toEqual(whole);
  });
});

describe('graph view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitApi.log).mockResolvedValue({ commits: history.map((c, i) => i === 0 ? { ...c, refs: [{ name: 'main', kind: 'branch', current: true }, { name: 'v1', kind: 'tag', current: false }] } : c), hasMore: true, filtered: false });
    vi.mocked(gitApi.commitDetail).mockResolvedValue({ oid: history[0].oid, parents: history[0].parents, author: 'Synthetic', email: 's@example.invalid',
      authoredAt: 1, committer: 'Synthetic', committerEmail: 's@example.invalid', committedAt: 1, message: 'commit m\n\nbody', refs: [] });
    vi.mocked(gitApi.changedFiles).mockResolvedValue({ files: [], truncated: false });
  });
  it('shows labels, pages more, filters as a list and opens merge parents explicitly', async () => {
    render(<GraphView projectId="p" repoId="r1" repoName="app" headOid="x" preferences={{ mode: 'split', ignoreWhitespace: false }} onPreferences={vi.fn()} onOpenComparison={vi.fn()} />);
    expect(await screen.findByText('commit m')).toBeInTheDocument();
    expect(screen.getByTitle('本機 branch（目前 HEAD）')).toHaveTextContent('main');
    expect(document.querySelectorAll('.git-graph-cell')).toHaveLength(4);
    vi.mocked(gitApi.log).mockResolvedValueOnce({ commits: [commit('z', [])], hasMore: false, filtered: false });
    fireEvent.click(screen.getByRole('button', { name: '載入更多 commit' }));
    expect(await screen.findByText('commit z')).toBeInTheDocument();
    await waitFor(() => expect(gitApi.log).toHaveBeenLastCalledWith('p', 'r1', {}, 4, 200));

    fireEvent.click(screen.getAllByRole('option')[0]);
    await waitFor(() => expect(gitApi.changedFiles).toHaveBeenCalledWith('p', 'r1', { kind: 'commit', commit: history[0].oid, parent: 1 }));
    expect(await screen.findByLabelText('比較 parent')).toHaveValue('1');

    vi.mocked(gitApi.log).mockResolvedValue({ commits: [history[1]], hasMore: false, filtered: true });
    fireEvent.change(screen.getByLabelText('作者篩選'), { target: { value: 'syn' } });
    fireEvent.click(screen.getByRole('button', { name: '篩選' }));
    expect(await screen.findByText(/不繪製分支線/)).toBeInTheDocument();
    expect(gitApi.log).toHaveBeenLastCalledWith('p', 'r1', { text: undefined, author: 'syn', path: null }, 0, 200);
    expect(document.querySelectorAll('.git-graph-cell')).toHaveLength(0);
  });
});

describe('blame view', () => {
  it('links groups to commits and to the previous version', async () => {
    const oid = 'c'.repeat(40);
    vi.mocked(gitApi.blame).mockResolvedValue({ path: { path: 'a.txt' }, rev: null, truncated: false,
      lines: [{ oid, originalLine: 1, line: 1, text: 'one' }, { oid, originalLine: 2, line: 2, text: 'two' }, { oid: '0'.repeat(40), originalLine: 3, line: 3, text: 'local' }],
      commits: { [oid]: { author: 'Synthetic', authoredAt: 1, summary: 'First', previous: ['d'.repeat(40), { path: 'old.txt' }], path: { path: 'a.txt' }, uncommitted: false },
        ['0'.repeat(40)]: { author: 'Not Committed Yet', authoredAt: 0, summary: '', previous: null, path: { path: 'a.txt' }, uncommitted: true } } });
    const onOpenCommit = vi.fn(), onBlame = vi.fn();
    render(<BlameView projectId="p" repoId="r1" repoName="app" path={{ path: 'a.txt' }} rev={null} onOpenCommit={onOpenCommit} onBlame={onBlame} onHistory={vi.fn()} />);
    expect(await screen.findByText('尚未 commit')).toBeInTheDocument();
    expect(screen.getAllByText('Synthetic')).toHaveLength(1);
    fireEvent.click(screen.getByText('cccccccc'.slice(0, 7)).closest('button')!);
    expect(onOpenCommit).toHaveBeenCalledWith(oid);
    fireEvent.click(screen.getByRole('button', { name: /前一版 blame/ }));
    expect(onBlame).toHaveBeenCalledWith({ path: 'old.txt' }, 'd'.repeat(40));
  });
});
