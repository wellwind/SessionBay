import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, PlugZap, Trash2 } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { hostingApi, tokenPage } from './hosting-api';
import type { Connection, Provider, RemoteMapping, TokenSource } from './hosting-api';
import type { RepoInfo } from './types';
import { t } from '../i18n';

const providerName: Record<Provider, string> = { github: 'GitHub', gitlab: t('GitLab (self-hosted)') };
const sourceName: Record<TokenSource, string> = { entered: t('entered token'), gitCredential: t('existing Git credential'), ghCli: t('GitHub CLI login') };

/** Host + account connections; secrets never appear in this UI after entry. */
export function HostsPanel({ projectId, repo, onChanged }: { projectId: string; repo: RepoInfo | null; onChanged?: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [ghAvailable, setGhAvailable] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    hostingApi.connections(projectId).then(result => { setConnections(result.connections); setGhAvailable(result.ghAvailable); })
      .catch(failure => setMessage({ tone: 'error', text: errorMessage(failure) }));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const test = async (connection: Connection) => {
    setBusy(true);
    try {
      const identity = await hostingApi.test(projectId, connection.id);
      setMessage({ tone: 'success', text: t('{{account}} connected', { account: `${connection.account}@${connection.host}` }) + (identity.serverVersion ? t(' ({{mode}})', { mode: identity.serverVersion }) : '') });
      load();
    } catch (failure) { setMessage({ tone: 'error', text: t('{{account}}: {{error}}', { account: `${connection.account}@${connection.host}`, error: errorMessage(failure) }) }); }
    finally { setBusy(false); }
  };
  return <div className="git-form">
    {message && <p className={message.tone === 'success' ? 'git-success' : 'git-error'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    <ul className="git-file-list" aria-label={t('Host connections')}>{connections.map(connection => <li key={connection.id} className="git-change git-host-row">
      <span className="git-change-open">
        <span className="git-change-name">{connection.account}@{connection.host}</span>
        <span className="git-change-dir">{providerName[connection.provider]}{connection.serverVersion ? ` · ${connection.serverVersion}` : ''}
          {' · '}{connection.sessionOnly ? t('this run only') : sourceName[connection.source]}{connection.scopes.length ? ` · ${connection.scopes.join(', ')}` : ''}</span>
      </span>
      <span className="git-change-actions">
        <button disabled={busy} aria-label={t('Test {{account}}', { account: `${connection.account}@${connection.host}` })} title={t('Test connection')} onClick={() => void test(connection)}><PlugZap size={14} /></button>
        <button disabled={busy} aria-label={t('Remove {{account}}', { account: `${connection.account}@${connection.host}` })} title={t('Remove connection')} onClick={() => setRemoving(connection)}><Trash2 size={14} /></button>
      </span>
    </li>)}</ul>
    {!connections.length && <p className="git-muted">{t('No hosts connected yet. Add an account to use PRs / MRs.')}</p>}
    <button onClick={() => setAdding(true)}>{t('Add host account…')}</button>
    {repo && connections.length > 0 && <RemoteMappings projectId={projectId} repo={repo} connections={connections} onChanged={onChanged} />}
    {adding && <AddConnectionDialog projectId={projectId} ghAvailable={ghAvailable} onClose={() => setAdding(false)} onAdded={(text, warnings) => {
      setAdding(false); load(); onChanged?.();
      setMessage({ tone: warnings.length ? 'error' : 'success', text: [text, ...warnings].join(t('; ')) });
    }} />}
    {removing && <RemoveDialog projectId={projectId} connection={removing} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); load(); onChanged?.(); }} />}
  </div>;
}

function RemoveDialog({ projectId, connection, onClose, onRemoved }: { projectId: string; connection: Connection; onClose: () => void; onRemoved: () => void }) {
  const [forget, setForget] = useState(connection.storedByApp);
  const [error, setError] = useState('');
  return <Dialog title={t('Remove {{account}}?', { account: `${connection.account}@${connection.host}` })} onClose={onClose}>
    <p>{t('Removes this connection and its remote mappings; repositories and remote data are not affected.')}</p>
    {connection.storedByApp && <label className="git-check"><input type="checkbox" checked={forget} onChange={event => setForget(event.target.checked)} />
      {t('Also remove the token Session Bay stored in the system credential store')}</label>}
    {!connection.storedByApp && <p className="git-muted">{t('This token comes from {{source}} and is not deleted.', { source: sourceName[connection.source] })}</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button onClick={onClose}>{t('Cancel')}</button>
      <button className="danger" data-dialog-confirm onClick={() => { hostingApi.remove(projectId, connection.id, forget).then(onRemoved, failure => setError(errorMessage(failure))); }}>{t('Remove')}</button>
    </div>
  </Dialog>;
}

function AddConnectionDialog({ projectId, ghAvailable, onClose, onAdded }: {
  projectId: string; ghAvailable: boolean; onClose: () => void; onAdded: (text: string, warnings: string[]) => void;
}) {
  const [provider, setProvider] = useState<Provider>('github');
  const [webUrl, setWebUrl] = useState('https://github.com');
  const [source, setSource] = useState<TokenSource>('entered');
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const page = webUrl.trim() ? tokenPage(provider, webUrl.trim()) : '';
  return <Dialog title={t('Add host account')} onClose={() => { if (!busy) onClose(); }}>
    <form className="git-form" onSubmit={event => {
      event.preventDefault();
      setBusy(true); setError('');
      hostingApi.add(projectId, { provider, webUrl: webUrl.trim(), account: account.trim() || null, token: source === 'entered' ? token : null, source, persist })
        .then(result => onAdded(t('Connected {{account}}', { account: `${result.connection.account}@${result.connection.host}` }), result.warnings),
          failure => { setError(errorMessage(failure)); setBusy(false); });
    }}>
      <label className="git-field">{t('Platform')}
        <select value={provider} onChange={event => { const next = event.target.value as Provider; setProvider(next); setWebUrl(next === 'github' ? 'https://github.com' : ''); if (next !== 'github' && source === 'ghCli') setSource('entered'); }}>
          <option value="github">{t('GitHub (github.com or Enterprise Server)')}</option>
          <option value="gitlab">{t('GitLab (self-hosted instance)')}</option>
        </select></label>
      <label className="git-field">{t('Host URL')}<input value={webUrl} placeholder={provider === 'gitlab' ? 'https://gitlab.example.com' : 'https://github.com'} required onChange={event => setWebUrl(event.target.value)} /></label>
      <fieldset className="git-radio-row"><legend>{t('Sign-in method')}</legend>
        <label><input type="radio" checked={source === 'entered'} onChange={() => setSource('entered')} />{t('Paste a personal access token')}</label>
        <label><input type="radio" checked={source === 'gitCredential'} onChange={() => setSource('gitCredential')} />{t('Use a credential already in your Git credential helper')}</label>
        {provider === 'github' && ghAvailable && <label><input type="radio" checked={source === 'ghCli'} onChange={() => setSource('ghCli')} />{t('Use your GitHub CLI (gh) login')}</label>}
      </fieldset>
      <label className="git-field">{t('Account name')}{source === 'gitCredential' ? t(' (required)') : t(' (optional, used to verify)')}<input value={account} required={source === 'gitCredential'} autoComplete="off" onChange={event => setAccount(event.target.value)} /></label>
      {source === 'entered' && <>
        <label className="git-field">Token<input type="password" value={token} required autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
        <label className="git-check"><input type="checkbox" checked={persist} onChange={event => setPersist(event.target.checked)} />{t('Save to the system credential store (Git credential helper); if it is insecure or not set up, the token is kept for this run only')}</label>
        {page && <p className="git-muted">{t('Create a token: ')}{provider === 'github' && webUrl.trim().replace(/\/$/, '') === 'https://github.com'
          ? <button type="button" className="git-link" onClick={() => void hostingApi.openExternal(projectId, page).catch(failure => setError(errorMessage(failure)))}>{t('Open in browser')} <ExternalLink size={11} aria-hidden="true" /></button>
          : <code className="git-copyable">{page}</code>}{t(' (GitHub needs the repo scope; GitLab needs the api scope). For SSO organizations, authorize the token in the browser.')}</p>}
      </>}
      <p className="git-muted">{t('Tokens are never written to Session Bay settings or logs. Connections use the certificates your OS trusts and never disable TLS verification.')}</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
        <button type="submit" className="primary" data-dialog-confirm disabled={busy}>{busy ? t('Verifying…') : t('Verify and add')}</button>
      </div>
    </form>
  </Dialog>;
}

function RemoteMappings({ projectId, repo, connections, onChanged }: { projectId: string; repo: RepoInfo; connections: Connection[]; onChanged?: () => void }) {
  const [mappings, setMappings] = useState<RemoteMapping[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { connectionId: string; project: string }>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    hostingApi.mappings(projectId, repo.id).then(setMappings).catch(failure => setError(errorMessage(failure)));
  }, [projectId, repo.id, connections]);
  const draft = (item: RemoteMapping) => drafts[item.remote] ?? {
    connectionId: item.mapping?.connectionId ?? item.suggested ?? '', project: item.mapping?.project ?? item.parsed?.path ?? '',
  };
  return <div className="git-form" aria-label={t('Remote mappings')}>
    <strong className="git-subheading">{t('Remote mappings for {{repo}}', { repo: repo.name })}</strong>
    {error && <p className="git-error" role="alert">{error}</p>}
    {mappings.map(item => {
      const value = draft(item);
      const label = (id: string) => { const c = connections.find(connection => connection.id === id); return c ? `${c.account}@${c.host}` : id; };
      return <div key={item.remote} className="git-mapping">
        <div><code>{item.remote}</code> <span className="git-muted">{item.url}</span></div>
        {item.parsed && <div className="git-muted">{t('Host {{host}}', { host: item.parsed.resolvedHost })}{item.parsed.resolvedHost !== item.parsed.host ? t(' (SSH alias {{alias}})', { alias: item.parsed.host }) : ''}{item.parsed.port ? `:${item.parsed.port}` : ''} · {item.parsed.path}</div>}
        {!item.mapping && item.suggested && <div className="git-warning">{t('Suggested: {{account}} (not confirmed)', { account: label(item.suggested) })}</div>}
        <div className="git-row">
          <select aria-label={t('Account used by {{remote}}', { remote: item.remote })} value={value.connectionId} onChange={event => setDrafts({ ...drafts, [item.remote]: { ...value, connectionId: event.target.value } })}>
            <option value="">{t('No mapping')}</option>
            {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.account}@{connection.host}</option>)}
          </select>
          <input aria-label={t('Project path of {{remote}}', { remote: item.remote })} value={value.project} placeholder="group/subgroup/project" onChange={event => setDrafts({ ...drafts, [item.remote]: { ...value, project: event.target.value } })} />
          <button onClick={() => {
            setError('');
            hostingApi.setMapping(projectId, repo.id, item.remote, value.connectionId || null, value.connectionId ? value.project : null)
              .then(next => { setMappings(next); setDrafts(previous => { const copy = { ...previous }; delete copy[item.remote]; return copy; }); onChanged?.(); },
                failure => setError(errorMessage(failure)));
          }}>{item.mapping ? t('Update') : t('Confirm mapping')}</button>
        </div>
        {item.mapping && <div className="git-success">{t('Mapped to {{account}} · {{project}}', { account: label(item.mapping.connectionId), project: item.mapping.project })}</div>}
      </div>;
    })}
    {!mappings.length && <p className="git-muted">{t('This repository has no remotes.')}</p>}
  </div>;
}
