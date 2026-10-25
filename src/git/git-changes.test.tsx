import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CHANGE_PAGE, GitChanges } from './GitChanges';
import type { RepoStatus, StatusEntry } from './types';

const entry = (index: number): StatusEntry => ({
  path: { path: `untracked-${index}.txt` }, staged: null, unstaged: null, untracked: true,
  conflict: null, submodule: false, modes: ['000000', '000000', '100644'],
});
const status = (count: number, repoId = 'repo'): RepoStatus => ({
  repoId, revision: 'r', branch: { oid: null, head: 'main', upstream: null, ahead: 0, behind: 0, unborn: false },
  operation: null, stashCount: 0, entries: Array.from({ length: count }, (_, index) => entry(index)), truncated: false,
});

describe('large change lists', () => {
  it('renders a window per group, grows it on request and keeps group actions on every entry', () => {
    const onStage = vi.fn();
    const actions = { busy: false, onOpen: vi.fn(), onStage, onUnstage: vi.fn() };
    const view = render(<GitChanges status={status(450)} actions={actions} />);
    const group = screen.getByRole('region', { name: '未追蹤' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(CHANGE_PAGE);
    fireEvent.click(within(group).getByRole('button', { name: '全部暫存未追蹤' }));
    expect(onStage.mock.calls[0][0]).toHaveLength(450);
    fireEvent.click(within(group).getByRole('button', { name: /^再顯示 250 項/ }));
    expect(within(group).getAllByRole('listitem')).toHaveLength(450);
    expect(within(group).queryByRole('button', { name: /^再顯示/ })).toBeNull();
    // A different repository starts from the first window again.
    view.rerender(<GitChanges status={status(450, 'other')} actions={actions} />);
    expect(within(screen.getByRole('region', { name: '未追蹤' })).getAllByRole('listitem')).toHaveLength(CHANGE_PAGE);
  });

  it('always shows the selected entry even beyond the window', () => {
    const actions = { busy: false, onOpen: vi.fn(), onStage: vi.fn(), onUnstage: vi.fn(), activeKey: 'untracked:untracked-320.txt' };
    render(<GitChanges status={status(450)} actions={actions} />);
    expect(screen.getByRole('button', { name: /^untracked-320\.txt，未追蹤/ })).toHaveAttribute('aria-current', 'true');
    expect(within(screen.getByRole('region', { name: '未追蹤' })).getAllByRole('listitem')).toHaveLength(321);
  });
});
