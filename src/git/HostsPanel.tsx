import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, PlugZap, Trash2 } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { hostingApi, tokenPage } from './hosting-api';
import type { Connection, Provider, RemoteMapping, TokenSource } from './hosting-api';
import type { RepoInfo } from './types';

const providerName: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab（自架）' };
const sourceName: Record<TokenSource, string> = { entered: '輸入的 token', gitCredential: '既有 Git 憑證', ghCli: 'GitHub CLI 登入' };

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
      setMessage({ tone: 'success', text: `${connection.account}@${connection.host} 連線正常${identity.serverVersion ? `（${identity.serverVersion}）` : ''}` });
      load();
    } catch (failure) { setMessage({ tone: 'error', text: `${connection.account}@${connection.host}：${errorMessage(failure)}` }); }
    finally { setBusy(false); }
  };
  return <div className="git-form">
    {message && <p className={message.tone === 'success' ? 'git-success' : 'git-error'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    <ul className="git-file-list" aria-label="主機連線">{connections.map(connection => <li key={connection.id} className="git-change git-host-row">
      <span className="git-change-open">
        <span className="git-change-name">{connection.account}@{connection.host}</span>
        <span className="git-change-dir">{providerName[connection.provider]}{connection.serverVersion ? ` · ${connection.serverVersion}` : ''}
          {' · '}{connection.sessionOnly ? '僅本次執行' : sourceName[connection.source]}{connection.scopes.length ? ` · ${connection.scopes.join(', ')}` : ''}</span>
      </span>
      <span className="git-change-actions">
        <button disabled={busy} aria-label={`測試 ${connection.account}@${connection.host}`} title="測試連線" onClick={() => void test(connection)}><PlugZap size={14} /></button>
        <button disabled={busy} aria-label={`移除 ${connection.account}@${connection.host}`} title="移除連線" onClick={() => setRemoving(connection)}><Trash2 size={14} /></button>
      </span>
    </li>)}</ul>
    {!connections.length && <p className="git-muted">尚未連線任何主機。PR／MR 功能需要先新增帳號。</p>}
    <button onClick={() => setAdding(true)}>新增主機帳號…</button>
    {repo && connections.length > 0 && <RemoteMappings projectId={projectId} repo={repo} connections={connections} onChanged={onChanged} />}
    {adding && <AddConnectionDialog projectId={projectId} ghAvailable={ghAvailable} onClose={() => setAdding(false)} onAdded={(text, warnings) => {
      setAdding(false); load(); onChanged?.();
      setMessage({ tone: warnings.length ? 'error' : 'success', text: [text, ...warnings].join('；') });
    }} />}
    {removing && <RemoveDialog projectId={projectId} connection={removing} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); load(); onChanged?.(); }} />}
  </div>;
}

function RemoveDialog({ projectId, connection, onClose, onRemoved }: { projectId: string; connection: Connection; onClose: () => void; onRemoved: () => void }) {
  const [forget, setForget] = useState(connection.storedByApp);
  const [error, setError] = useState('');
  return <Dialog title={`移除 ${connection.account}@${connection.host}？`} onClose={onClose}>
    <p>移除此連線與相關 remote 對應；不影響 repository 或遠端資料。</p>
    {connection.storedByApp && <label className="git-check"><input type="checkbox" checked={forget} onChange={event => setForget(event.target.checked)} />
      一併從系統安全憑證移除 Session Bay 儲存的 token</label>}
    {!connection.storedByApp && <p className="git-muted">此 token 來自{sourceName[connection.source]}，不會被刪除。</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button onClick={onClose}>取消</button>
      <button className="danger" data-dialog-confirm onClick={() => { hostingApi.remove(projectId, connection.id, forget).then(onRemoved, failure => setError(errorMessage(failure))); }}>移除</button>
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
  return <Dialog title="新增主機帳號" onClose={() => { if (!busy) onClose(); }}>
    <form className="git-form" onSubmit={event => {
      event.preventDefault();
      setBusy(true); setError('');
      hostingApi.add(projectId, { provider, webUrl: webUrl.trim(), account: account.trim() || null, token: source === 'entered' ? token : null, source, persist })
        .then(result => onAdded(`已連線 ${result.connection.account}@${result.connection.host}`, result.warnings),
          failure => { setError(errorMessage(failure)); setBusy(false); });
    }}>
      <label className="git-field">平台
        <select value={provider} onChange={event => { const next = event.target.value as Provider; setProvider(next); setWebUrl(next === 'github' ? 'https://github.com' : ''); if (next !== 'github' && source === 'ghCli') setSource('entered'); }}>
          <option value="github">GitHub（github.com 或 Enterprise Server）</option>
          <option value="gitlab">GitLab（自架 instance）</option>
        </select></label>
      <label className="git-field">主機網址<input value={webUrl} placeholder={provider === 'gitlab' ? 'https://gitlab.example.com' : 'https://github.com'} required onChange={event => setWebUrl(event.target.value)} /></label>
      <fieldset className="git-radio-row"><legend>登入方式</legend>
        <label><input type="radio" checked={source === 'entered'} onChange={() => setSource('entered')} />貼上 personal access token</label>
        <label><input type="radio" checked={source === 'gitCredential'} onChange={() => setSource('gitCredential')} />使用 Git credential helper 中已有的憑證</label>
        {provider === 'github' && ghAvailable && <label><input type="radio" checked={source === 'ghCli'} onChange={() => setSource('ghCli')} />使用 GitHub CLI（gh）的登入</label>}
      </fieldset>
      <label className="git-field">帳號名稱{source === 'gitCredential' ? '（必填）' : '（選填，用來核對）'}<input value={account} required={source === 'gitCredential'} autoComplete="off" onChange={event => setAccount(event.target.value)} /></label>
      {source === 'entered' && <>
        <label className="git-field">Token<input type="password" value={token} required autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
        <label className="git-check"><input type="checkbox" checked={persist} onChange={event => setPersist(event.target.checked)} />存入系統安全憑證（Git credential helper）；不安全或未設定時只保留在本次執行</label>
        {page && <p className="git-muted">建立 token：{provider === 'github' && webUrl.trim().replace(/\/$/, '') === 'https://github.com'
          ? <button type="button" className="git-link" onClick={() => void hostingApi.openExternal(projectId, page).catch(failure => setError(errorMessage(failure)))}>在瀏覽器開啟 <ExternalLink size={11} aria-hidden="true" /></button>
          : <code className="git-copyable">{page}</code>}（GitHub 需 repo 權限；GitLab 需 api 權限）。SSO 組織需在瀏覽器授權 token。</p>}
      </>}
      <p className="git-muted">Token 不會寫入 Session Bay 設定或紀錄。連線使用作業系統信任的憑證，不會停用 TLS 驗證。</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary" data-dialog-confirm disabled={busy}>{busy ? '驗證中…' : '驗證並新增'}</button>
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
  return <div className="git-form" aria-label="Remote 對應">
    <strong className="git-subheading">{repo.name} 的 remote 對應</strong>
    {error && <p className="git-error" role="alert">{error}</p>}
    {mappings.map(item => {
      const value = draft(item);
      const label = (id: string) => { const c = connections.find(connection => connection.id === id); return c ? `${c.account}@${c.host}` : id; };
      return <div key={item.remote} className="git-mapping">
        <div><code>{item.remote}</code> <span className="git-muted">{item.url}</span></div>
        {item.parsed && <div className="git-muted">主機 {item.parsed.resolvedHost}{item.parsed.resolvedHost !== item.parsed.host ? `（SSH 別名 ${item.parsed.host}）` : ''}{item.parsed.port ? `:${item.parsed.port}` : ''} · {item.parsed.path}</div>}
        {!item.mapping && item.suggested && <div className="git-warning">建議：{label(item.suggested)}（尚未確認）</div>}
        <div className="git-row">
          <select aria-label={`${item.remote} 使用的帳號`} value={value.connectionId} onChange={event => setDrafts({ ...drafts, [item.remote]: { ...value, connectionId: event.target.value } })}>
            <option value="">不對應</option>
            {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.account}@{connection.host}</option>)}
          </select>
          <input aria-label={`${item.remote} 的 project 路徑`} value={value.project} placeholder="group/subgroup/project" onChange={event => setDrafts({ ...drafts, [item.remote]: { ...value, project: event.target.value } })} />
          <button onClick={() => {
            setError('');
            hostingApi.setMapping(projectId, repo.id, item.remote, value.connectionId || null, value.connectionId ? value.project : null)
              .then(next => { setMappings(next); setDrafts(previous => { const copy = { ...previous }; delete copy[item.remote]; return copy; }); onChanged?.(); },
                failure => setError(errorMessage(failure)));
          }}>{item.mapping ? '更新' : '確認對應'}</button>
        </div>
        {item.mapping && <div className="git-success">已對應 {label(item.mapping.connectionId)} · {item.mapping.project}</div>}
      </div>;
    })}
    {!mappings.length && <p className="git-muted">此 repository 沒有 remote。</p>}
  </div>;
}
