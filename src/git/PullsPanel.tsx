import { useCallback, useEffect, useState } from 'react';
import { GitPullRequest, RefreshCw } from 'lucide-react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { hostingApi } from './hosting-api';
import type { RemoteMapping } from './hosting-api';
import type { PullSummary, RepoInfo, RepoStatus } from './types';

/** PR/MR list for a mapped remote, plus creating one from the current branch. */
export function PullsPanel({ projectId, repo, status, onOpen }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onOpen: (remote: string, pull: PullSummary) => void;
}) {
  const [mappings, setMappings] = useState<RemoteMapping[]>([]);
  const [remote, setRemote] = useState('');
  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState<PullSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', target: 'main', draft: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    hostingApi.mappings(projectId, repo.id).then(list => {
      const mapped = list.filter(item => item.mapping);
      setMappings(mapped);
      setRemote(current => mapped.some(item => item.remote === current) ? current : mapped[0]?.remote ?? '');
    }).catch(failure => setError(errorMessage(failure)));
  }, [projectId, repo.id]);
  const load = useCallback(async (refresh: boolean) => {
    if (!remote) return;
    setError('');
    try { setPulls(await gitApi.pulls(projectId, { repoId: repo.id, remote, state, refresh })); }
    catch (failure) { setError(errorMessage(failure)); setPulls(null); }
  }, [projectId, repo.id, remote, state]);
  useEffect(() => { void load(false); }, [load]);
  if (!mappings.length) return <p className="git-muted">尚無已確認對應主機帳號的 remote；請先在「主機與帳號」新增帳號並確認 remote 對應。</p>;
  const source = status.branch.head;
  return <div className="git-form">
    <div className="git-row">
      <select aria-label="PR／MR 的 remote" value={remote} onChange={event => setRemote(event.target.value)}>
        {mappings.map(item => <option key={item.remote} value={item.remote}>{item.remote} · {item.mapping?.project}</option>)}
      </select>
      <select aria-label="PR／MR 狀態" value={state} onChange={event => setState(event.target.value)}>
        <option value="open">開啟中</option><option value="closed">已關閉</option><option value="all">全部</option>
      </select>
      <button className="git-icon-button" aria-label="重新整理 PR／MR" title="重新整理" onClick={() => void load(true)}><RefreshCw size={14} /></button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
    <ul className="git-file-list" aria-label="PR／MR">{pulls?.map(pull => <li key={pull.number} className="git-change">
      <button className="git-change-open" onClick={() => onOpen(remote, pull)} aria-label={`#${pull.number} ${pull.title}`}>
        <GitPullRequest size={13} aria-hidden="true" /><span className="git-change-name">#{pull.number} {pull.title}</span>
        <span className="git-change-dir">{pull.draft ? '草稿 · ' : ''}{pull.author} · {pull.sourceBranch} → {pull.targetBranch}</span>
      </button>
    </li>)}</ul>
    {pulls && !pulls.length && <p className="git-muted">沒有符合的 PR／MR。</p>}
    {!creating ? <button disabled={!source} title={source ? undefined : 'detached HEAD 無法建立 PR'} onClick={() => setCreating(true)}>從 {source ?? 'HEAD'} 建立 PR／MR…</button>
      : <form className="git-form git-inline-form" onSubmit={event => {
        event.preventDefault();
        if (!source) return;
        setBusy(true); setError('');
        gitApi.pullCreate(projectId, { repoId: repo.id, remote, title: draft.title, body: draft.body, source, target: draft.target.trim(), draft: draft.draft })
          .then(created => { setCreating(false); setDraft({ title: '', body: '', target: draft.target, draft: false }); void load(true); onOpen(remote, created); },
            failure => setError(errorMessage(failure)))
          .finally(() => setBusy(false));
      }}>
        <p className="git-muted">來源 {remote}/{source}（需已推送）</p>
        <label className="git-field">目標 branch<input value={draft.target} required onChange={event => setDraft({ ...draft, target: event.target.value })} /></label>
        <label className="git-field">標題<input value={draft.title} required onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="git-field">說明<textarea rows={3} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <label className="git-check"><input type="checkbox" checked={draft.draft} onChange={event => setDraft({ ...draft, draft: event.target.checked })} />建立為草稿</label>
        <div className="git-row"><button type="button" onClick={() => setCreating(false)}>取消</button><button type="submit" className="primary" disabled={busy}>建立</button></div>
      </form>}
  </div>;
}
