import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DevBadge } from './components/DevBadge';
import { UpdateNotice } from './components/UpdateNotice';
import { api } from './api';

vi.mock('./app-identity', () => ({ isDevBuild: true, devBranch: 'feature/identity', devCommit: 'abc123def456' }));
vi.mock('./api', () => ({ isDesktop: () => true, api: { checkForUpdate: vi.fn() } }));
afterEach(() => vi.useRealTimers());

it('exposes dev branch and commit beside the logo', () => {
  render(<DevBadge />);
  const badge = screen.getByText('DEV');
  expect(badge).toHaveAttribute('title', '開發版本 · 分支：feature/identity · 提交：abc123def456');
  expect(badge).toHaveAttribute('tabindex', '0');
});

it('never schedules dev update checks even with production settings enabled', async () => {
  vi.useFakeTimers();
  render(<UpdateNotice enabled />);
  await act(() => vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000));
  expect(api.checkForUpdate).not.toHaveBeenCalled();
});
