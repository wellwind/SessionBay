import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UpdateNotice } from './components/UpdateNotice';

vi.mock('./api', () => ({ isDesktop: () => true, api: { checkForUpdate: vi.fn(), openReleasePage: vi.fn(() => Promise.resolve()) } }));
const { api } = await import('./api');
const update = { current: '0.1.0', latest: '0.2.0', url: 'https://github.com/wellwind/SessionBay/releases/tag/v0.2.0', prerelease: true, publishedAt: null };

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.checkForUpdate).mockReset(); });
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

it('shows a newer release, opens it, and remembers a dismissed version', async () => {
  vi.mocked(api.checkForUpdate).mockResolvedValue(update);
  const view = render(<UpdateNotice enabled />);
  await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Session Bay 0.2.0 已推出。');
  fireEvent.click(screen.getByRole('button', { name: '查看版本' }));
  expect(api.openReleasePage).toHaveBeenCalledWith(update.url);
  fireEvent.click(screen.getByRole('button', { name: '略過這個版本' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.unmount();
  render(<UpdateNotice enabled />);
  await settle();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('never checks when turned off and stays quiet on errors', async () => {
  render(<UpdateNotice enabled={false} />);
  await settle();
  expect(api.checkForUpdate).not.toHaveBeenCalled();
  vi.mocked(api.checkForUpdate).mockRejectedValue(new Error('offline'));
  render(<UpdateNotice enabled />);
  await settle();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
