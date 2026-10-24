import { call } from '../api';
import { gitRequest } from './git-api';

export type Provider = 'github' | 'gitlab';
export type TokenSource = 'entered' | 'gitCredential' | 'ghCli';
export interface HelperInfo { helpers: string[]; secure: boolean; plaintext: boolean }
export interface Connection {
  id: string; provider: Provider; host: string; webUrl: string; apiUrl: string; account: string; source: TokenSource;
  scheme: 'bearer' | 'privateToken'; storedByApp: boolean; serverVersion: string | null; scopes: string[]; verifiedAt: number;
  sessionOnly?: boolean; helper?: HelperInfo;
}
export interface RemoteMapping {
  remote: string; url: string;
  parsed: { scheme: string; host: string; resolvedHost: string; port: number | null; path: string } | null;
  candidates: { id: string; provider: Provider; host: string; account: string }[];
  mapping: { repoId: string; remote: string; connectionId: string; project: string } | null;
  suggested: string | null;
}
export type HostRequest =
  | { op: 'connections' }
  | { op: 'addConnection'; provider: Provider; webUrl: string; account: string | null; token: string | null; source: TokenSource; persist: boolean }
  | { op: 'testConnection'; id: string }
  | { op: 'removeConnection'; id: string; forget: boolean }
  | { op: 'openExternal'; url: string };

const hostRequest = <T>(projectId: string, request: HostRequest) => call<T>('git_hosting', { projectId, request });

export const hostingApi = {
  connections: (projectId: string) => hostRequest<{ connections: Connection[]; ghAvailable: boolean }>(projectId, { op: 'connections' }),
  add: (projectId: string, body: Omit<Extract<HostRequest, { op: 'addConnection' }>, 'op'>) =>
    hostRequest<{ connection: Connection; warnings: string[] }>(projectId, { op: 'addConnection', ...body }),
  test: (projectId: string, id: string) => hostRequest<{ account: string; serverVersion: string | null; scopes: string[] }>(projectId, { op: 'testConnection', id }),
  remove: (projectId: string, id: string, forget: boolean) => hostRequest<null>(projectId, { op: 'removeConnection', id, forget }),
  openExternal: (projectId: string, url: string) => hostRequest<null>(projectId, { op: 'openExternal', url }),
  mappings: (projectId: string, repoId: string) => gitRequest<RemoteMapping[]>(projectId, { op: 'remoteMappings', repoId }),
  setMapping: (projectId: string, repoId: string, remote: string, connectionId: string | null, project: string | null) =>
    gitRequest<RemoteMapping[]>(projectId, { op: 'setRemoteMapping', repoId, remote, connectionId, project }),
};

export const tokenPage = (provider: Provider, webUrl: string) => provider === 'github'
  ? `${webUrl.replace(/\/$/, '')}/settings/tokens/new?scopes=repo&description=Session%20Bay`
  : `${webUrl.replace(/\/$/, '')}/-/user_settings/personal_access_tokens?name=Session%20Bay&scopes=api`;
