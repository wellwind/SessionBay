import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CloudDownload, LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { PullStrategy, PushPlan, Refs, RepoInfo, RepoStatus } from './types';
import { pullStrategyLabel } from './types';

export function defaultPullStrategy(configured: string | null): PullStrategy {
  if (configured === 'false') return 'merge';
  if (configured && ['true', 'merges', 'interactive', 'i', 'm'].includes(configured)) return 'rebase';
  return 'fastForwardOnly';
}

type Pending = { kind: 'pull' } | { kind: 'push' } | null;

/** Fetch, pull and push stay separate, each with explicit targets. */
export function SyncPanel({ projectId, repo, status, refs, onDone }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; refs: Refs | null;
  onDone: (result: { tone: 'success' | 'error'; text: string }) => void;
}) {
  const [plan, setPlan] = useState<PushPlan | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState('');
  const [fetchRemote, setFetchRemote] = useState('');
  const [prune, setPrune] = useState(false);
  const [strategy, setStrategy] = useState<PullStrategy>('fastForwardOnly');
  const [remote, setRemote] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [setUpstream, setSetUpstream] = useState(false);
  const [force, setForce] = useState(false);
  useEffect(() => {
    let cancelled = false;
    gitApi.pushPlan(projectId, repo.id).then(next => {
      if (cancelled) return;
      setPlan(next);
      setStrategy(defaultPullStrategy(next.pullRebaseConfigured));
    }).catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
    return () => { cancelled = true; };
  }, [projectId, repo.id, status.revision]);

  const run = async (label: string, action: () => Promise<string>) => {
    setRunning(label); setError('');
    try { onDone({ tone: 'success', text: await action() }); setPending(null); }
    catch (failure) { setError(errorMessage(failure)); onDone({ tone: 'error', text: errorMessage(failure) }); }
    finally { setRunning(null); }
  };
  const openPush = () => {
    if (!plan?.branch) return;
    const target = plan.pushRemote ?? plan.upstreamRemote ?? (plan.remotes.includes('origin') ? 'origin' : plan.remotes[0] ?? '');
    setRemote(target);
    setRemoteBranch(plan.upstreamBranch ?? plan.branch);
    setSetUpstream(!plan.upstreamRemote);
    setForce(false);
    setPending({ kind: 'push' });
  };
  const remoteHead = refs?.branches.find(branch => branch.remote && branch.name === `${remote}/${remoteBranch}`);
  const noRemote = plan && !plan.remotes.length;
  const detached = !status.branch.head;
  const cancel = () => void gitApi.cancelOperation(projectId, repo.id);
  return <div className="git-form">
    <div className="git-row git-sync-summary">
      {status.branch.upstream ? <span>upstream <strong>{status.branch.upstream}</strong></span> : <span className="git-muted">尚未設定 upstream</span>}
      <span aria-label={`領先 ${status.branch.ahead}`}><ArrowUp size={12} aria-hidden="true" />{status.branch.ahead}</span>
      <span aria-label={`落後 ${status.branch.behind}`}><ArrowDown size={12} aria-hidden="true" />{status.branch.behind}</span>
      {status.branch.ahead > 0 && status.branch.behind > 0 && <span className="git-warning">已分叉</span>}
    </div>
    {noRemote && <p className="git-muted">此 repository 沒有 remote。</p>}
    {!noRemote && <>
      <div className="git-row">
        <select aria-label="Fetch 來源" value={fetchRemote} onChange={event => setFetchRemote(event.target.value)}>
          <option value="">全部 remote</option>
          {plan?.remotes.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <label className="git-check"><input type="checkbox" checked={prune} onChange={event => setPrune(event.target.checked)} />prune</label>
        <button disabled={!!running} onClick={() => void run('fetch', async () => {
          await gitApi.fetch(projectId, repo.id, fetchRemote || null, prune);
          return `已 fetch ${fetchRemote || '全部 remote'}。`;
        })}><CloudDownload size={14} aria-hidden="true" />Fetch</button>
      </div>
      <div className="git-row">
        <button disabled={!!running || detached || !status.branch.upstream} title={!status.branch.upstream ? '目前 branch 沒有 upstream' : undefined}
          onClick={() => setPending({ kind: 'pull' })}><ArrowDown size={14} aria-hidden="true" />Pull…</button>
        <button disabled={!!running || detached || status.branch.unborn} title={detached ? 'detached HEAD 無法推送 branch' : status.branch.unborn ? '請先建立第一個 commit' : undefined}
          onClick={openPush}><ArrowUp size={14} aria-hidden="true" />Push…</button>
      </div>
    </>}
    {running && !pending && <p className="git-muted" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 正在 {running}…
      <button onClick={cancel}>停止</button></p>}
    {error && !pending && <p className="git-error" role="alert">{error}</p>}

    {pending?.kind === 'pull' && plan && <Dialog title="Pull 遠端變更" onClose={() => { if (!running) setPending(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd>{repo.name}</dd>
        <dt>來源</dt><dd>{plan.upstreamRemote}/{plan.upstreamBranch} → {plan.branch}</dd>
      </dl>
      <fieldset className="git-radio-row"><legend>整合方式</legend>
        {(Object.keys(pullStrategyLabel) as PullStrategy[]).map(value => <label key={value}>
          <input type="radio" name="pull-strategy" checked={strategy === value} onChange={() => setStrategy(value)} />{pullStrategyLabel[value]}</label>)}
      </fieldset>
      {plan.pullRebaseConfigured && <p className="git-muted">Git 設定 pull.rebase = {plan.pullRebaseConfigured}；此處仍以你選擇的方式明確執行。</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <><span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 正在 pull…</span><button onClick={cancel}>停止</button></>
          : <><button onClick={() => setPending(null)}>取消</button>
            <button data-dialog-confirm className="primary" onClick={() => void run('pull', async () => {
              await gitApi.pull(projectId, repo.id, strategy);
              return `已 pull ${plan.upstreamRemote}/${plan.upstreamBranch}。`;
            })}>Pull</button></>}
      </div>
    </Dialog>}

    {pending?.kind === 'push' && plan?.branch && <Dialog title="推送 branch" onClose={() => { if (!running) setPending(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd>{repo.name}</dd>
        <dt>本機 branch</dt><dd>{plan.branch} <span className="git-muted">{plan.head?.slice(0, 7)}</span></dd>
      </dl>
      <label className="git-field">Remote
        <select value={remote} onChange={event => setRemote(event.target.value)}>
          {plan.remotes.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
      <label className="git-field">遠端 branch<input value={remoteBranch} onChange={event => setRemoteBranch(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={setUpstream} onChange={event => setSetUpstream(event.target.checked)} />
        設為 upstream（之後 pull／push 的預設目標）</label>
      <p className="git-muted">目的地：{remote}/{remoteBranch}{remoteHead ? `（目前 ${remoteHead.oid.slice(0, 7)}）` : '（新 branch）'}。
        不會推送任何 tag{plan.followTagsConfigured ? '（已覆寫 push.followTags）' : ''}；tag 請在 Tags 區明確推送。</p>
      {plan.hooks.length > 0 && <p className="git-muted">會執行 hook：{plan.hooks.join('、')}</p>}
      {remoteHead && <label className="git-check git-ack"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
        強制推送（force-with-lease）</label>}
      {force && remoteHead && <p className="git-error">強制推送會讓 {remote}/{remoteBranch} 從 {remoteHead.oid.slice(0, 7)} 改為本機 {plan.head?.slice(0, 7)}，遠端上不在本機的 commit 會從此 branch 消失。
        只有遠端仍是 {remoteHead.oid.slice(0, 7)} 時才會覆寫（lease）；其他人若已推送新內容，推送會被拒絕。此操作沒有 Session Bay 復原點。</p>}
      {plan.behind > 0 && <p className="git-warning">本機落後 upstream {plan.behind} 個 commit，遠端可能拒絕推送。</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <><span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 正在推送…</span><button onClick={cancel}>停止</button></>
          : <><button onClick={() => setPending(null)}>取消</button>
            <button data-dialog-confirm className={force ? 'danger' : 'primary'} disabled={!remote || !remoteBranch.trim()} onClick={() => void run('push', async () => {
              const result = await gitApi.push(projectId, { repoId: repo.id, remote, localBranch: plan.branch!, remoteBranch: remoteBranch.trim(), setUpstream,
                ...(force && remoteHead ? { forceWithLease: remoteHead.oid } : {}) });
              return result.confirmed ? `已推送 ${plan.branch} → ${remote}/${remoteBranch}（${result.pushed.slice(0, 7)}）。`
                : `推送指令已完成，但無法從本機 remote-tracking ref 確認 ${remote}/${remoteBranch}；請 fetch 後確認。`;
            })}>{force ? '強制推送' : '推送'}</button></>}
      </div>
    </Dialog>}
  </div>;
}
