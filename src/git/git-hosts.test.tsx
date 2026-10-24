import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostsPanel } from './HostsPanel';
import { hostingApi, tokenPage } from './hosting-api';
import type { Connection, RemoteMapping } from './hosting-api';

vi.mock('./hosting-api', async importOriginal => ({
  ...(await importOriginal<typeof import('./hosting-api')>()),
  hostingApi: { connections: vi.fn(), add: vi.fn(), test: vi.fn(), remove: vi.fn(), openExternal: vi.fn(), mappings: vi.fn(), setMapping: vi.fn() },
}));

const repo = { id: 'r1', name: 'app', root: '/synthetic/app', relativePath: '', gitDir: '', commonDir: '', linkedWorktree: false, enclosesProject: false };
const connection = (extra: Partial<Connection> = {}): Connection => ({ id: 'c1', provider: 'gitlab', host: 'gitlab.example.test', webUrl: 'https://gitlab.example.test',
  apiUrl: 'https://gitlab.example.test/api/v4', account: 'carol', source: 'entered', scheme: 'privateToken', storedByApp: true, serverVersion: 'GitLab 17.11.2',
  scopes: ['api'], verifiedAt: 0, sessionOnly: false, ...extra });
const mapping: RemoteMapping = { remote: 'origin', url: 'git@gl-work:team/sub/app.git', candidates: [{ id: 'c1', provider: 'gitlab', host: 'gitlab.example.test', account: 'carol' }],
  parsed: { scheme: 'ssh', host: 'gl-work', resolvedHost: 'gitlab.example.test', port: null, path: 'team/sub/app' }, mapping: null, suggested: 'c1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hostingApi.connections).mockResolvedValue({ connections: [connection()], ghAvailable: true });
  vi.mocked(hostingApi.mappings).mockResolvedValue([mapping]);
});

describe('host connections', () => {
  it('adds an account with a masked token and reports session-only storage', async () => {
    vi.mocked(hostingApi.connections).mockResolvedValue({ connections: [], ghAvailable: true });
    vi.mocked(hostingApi.add).mockResolvedValue({ connection: connection({ provider: 'github', host: 'github.com', account: 'alice' }), warnings: ['沒有設定安全的 Git credential helper；token 只在本次執行期間保留'] });
    render(<HostsPanel projectId="p" repo={null} />);
    fireEvent.click(await screen.findByRole('button', { name: '新增主機帳號…' }));
    const dialog = screen.getByRole('dialog', { name: '新增主機帳號' });
    const token = within(dialog).getByLabelText('Token');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.change(token, { target: { value: 'ghp_synthetic' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '驗證並新增' }));
    await waitFor(() => expect(hostingApi.add).toHaveBeenCalledWith('p', { provider: 'github', webUrl: 'https://github.com', account: null, token: 'ghp_synthetic', source: 'entered', persist: true }));
    expect(await screen.findByText(/本次執行期間保留/)).toBeInTheDocument();
  });

  it('requires an account for existing Git credentials and never sends the token field', async () => {
    vi.mocked(hostingApi.add).mockResolvedValue({ connection: connection(), warnings: [] });
    render(<HostsPanel projectId="p" repo={null} />);
    fireEvent.click(await screen.findByRole('button', { name: '新增主機帳號…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('平台'), { target: { value: 'gitlab' } });
    fireEvent.change(within(dialog).getByLabelText('主機網址'), { target: { value: 'https://gitlab.example.test' } });
    fireEvent.click(within(dialog).getByLabelText(/Git credential helper 中已有/));
    expect(within(dialog).queryByLabelText(/GitHub CLI/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/帳號名稱（必填）/)).toBeRequired();
    fireEvent.change(within(dialog).getByLabelText(/帳號名稱/), { target: { value: 'carol' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '驗證並新增' }));
    await waitFor(() => expect(hostingApi.add).toHaveBeenCalledWith('p', expect.objectContaining({ provider: 'gitlab', source: 'gitCredential', account: 'carol', token: null })));
  });

  it('diagnoses failed tests and confirms suggested remote mappings explicitly', async () => {
    vi.mocked(hostingApi.test).mockRejectedValue(new Error('TLS 憑證驗證失敗：主機憑證不受作業系統信任'));
    vi.mocked(hostingApi.setMapping).mockResolvedValue([{ ...mapping, mapping: { repoId: 'r1', remote: 'origin', connectionId: 'c1', project: 'team/sub/app' }, suggested: null }]);
    render(<HostsPanel projectId="p" repo={repo} />);
    fireEvent.click(await screen.findByRole('button', { name: '測試 carol@gitlab.example.test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TLS 憑證驗證失敗');
    expect(await screen.findByText('建議：carol@gitlab.example.test（尚未確認）')).toBeInTheDocument();
    expect(screen.getByText(/SSH 別名 gl-work/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '確認對應' }));
    await waitFor(() => expect(hostingApi.setMapping).toHaveBeenCalledWith('p', 'r1', 'origin', 'c1', 'team/sub/app'));
    expect(await screen.findByText('已對應 carol@gitlab.example.test · team/sub/app')).toBeInTheDocument();
  });

  it('offers to forget only tokens Session Bay stored', async () => {
    vi.mocked(hostingApi.remove).mockResolvedValue(null);
    render(<HostsPanel projectId="p" repo={null} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除 carol@gitlab.example.test' }));
    expect(screen.getByLabelText(/一併從系統安全憑證移除/)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    await waitFor(() => expect(hostingApi.remove).toHaveBeenCalledWith('p', 'c1', true));
  });

  it('builds token pages for each provider', () => {
    expect(tokenPage('github', 'https://github.com/')).toContain('/settings/tokens/new?scopes=repo');
    expect(tokenPage('gitlab', 'https://gitlab.example.test')).toBe('https://gitlab.example.test/-/user_settings/personal_access_tokens?name=Session%20Bay&scopes=api');
  });
});
