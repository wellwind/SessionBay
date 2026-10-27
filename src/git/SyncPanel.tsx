import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CloudDownload, LoaderCircle } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { PullStrategy, PushPlan, Refs, RepoInfo, RepoStatus } from './types';
import { pullStrategyLabel } from './types';
import { t } from '../i18n';

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
      {status.branch.upstream ? <span>upstream <strong>{status.branch.upstream}</strong></span> : <span className="git-muted">{t('No upstream set')}</span>}
      <span aria-label={t('Ahead {{count}}', { count: status.branch.ahead })}><ArrowUp size={12} aria-hidden="true" />{status.branch.ahead}</span>
      <span aria-label={t('Behind {{count}}', { count: status.branch.behind })}><ArrowDown size={12} aria-hidden="true" />{status.branch.behind}</span>
      {status.branch.ahead > 0 && status.branch.behind > 0 && <span className="git-warning">{t('Diverged')}</span>}
    </div>
    {noRemote && <p className="git-muted">{t('This repository has no remotes.')}</p>}
    {!noRemote && <>
      <div className="git-row">
        <select aria-label={t('Fetch source')} value={fetchRemote} onChange={event => setFetchRemote(event.target.value)}>
          <option value="">{t('All remotes')}</option>
          {plan?.remotes.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <label className="git-check"><input type="checkbox" checked={prune} onChange={event => setPrune(event.target.checked)} />prune</label>
        <button disabled={!!running} onClick={() => void run('fetch', async () => {
          await gitApi.fetch(projectId, repo.id, fetchRemote || null, prune);
          return t('Fetched {{remote}}.', { remote: fetchRemote || t('All remotes') });
        })}><CloudDownload size={14} aria-hidden="true" />Fetch</button>
      </div>
      <div className="git-row">
        <button disabled={!!running || detached || !status.branch.upstream} title={!status.branch.upstream ? t('The current branch has no upstream') : undefined}
          onClick={() => setPending({ kind: 'pull' })}><ArrowDown size={14} aria-hidden="true" />Pull…</button>
        <button disabled={!!running || detached || status.branch.unborn} title={detached ? t('Cannot push a branch from a detached HEAD') : status.branch.unborn ? t('Create the first commit first') : undefined}
          onClick={openPush}><ArrowUp size={14} aria-hidden="true" />Push…</button>
      </div>
    </>}
    {running && !pending && <p className="git-muted" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Running {{action}}…', { action: running })}
      <button onClick={cancel}>{t('Stop')}</button></p>}
    {error && !pending && <p className="git-error" role="alert">{error}</p>}

    {pending?.kind === 'pull' && plan && <Dialog title={t('Pull remote changes')} onClose={() => { if (!running) setPending(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd>{repo.name}</dd>
        <dt>{t('Source')}</dt><dd>{plan.upstreamRemote}/{plan.upstreamBranch} → {plan.branch}</dd>
      </dl>
      <fieldset className="git-radio-row"><legend>{t('Integration')}</legend>
        {(Object.keys(pullStrategyLabel) as PullStrategy[]).map(value => <label key={value}>
          <input type="radio" name="pull-strategy" checked={strategy === value} onChange={() => setStrategy(value)} />{pullStrategyLabel[value]}</label>)}
      </fieldset>
      {plan.pullRebaseConfigured && <p className="git-muted">{t('Your Git config sets pull.rebase = {{value}}; the method you choose here is still used explicitly.', { value: String(plan.pullRebaseConfigured) })}</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <><span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Pulling…')}</span><button onClick={cancel}>{t('Stop')}</button></>
          : <><button onClick={() => setPending(null)}>取消</button>
            <button data-dialog-confirm className="primary" onClick={() => void run('pull', async () => {
              await gitApi.pull(projectId, repo.id, strategy);
              return t('Pulled {{remote}}/{{branch}}.', { remote: plan.upstreamRemote ?? '', branch: plan.upstreamBranch ?? '' });
            })}>Pull</button></>}
      </div>
    </Dialog>}

    {pending?.kind === 'push' && plan?.branch && <Dialog title={t('Push branch')} onClose={() => { if (!running) setPending(null); }}>
      <dl className="git-facts">
        <dt>Repository</dt><dd>{repo.name}</dd>
        <dt>{t('Local branch')}</dt><dd>{plan.branch} <span className="git-muted">{plan.head?.slice(0, 7)}</span></dd>
      </dl>
      <label className="git-field">Remote
        <select value={remote} onChange={event => setRemote(event.target.value)}>
          {plan.remotes.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
      <label className="git-field">{t('Remote branch')}<input value={remoteBranch} onChange={event => setRemoteBranch(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={setUpstream} onChange={event => setSetUpstream(event.target.checked)} />
        {t('Set as upstream (the default target for later pulls and pushes)')}</label>
      <p className="git-muted">{t('Destination: {{target}}', { target: `${remote}/${remoteBranch}` })}{remoteHead ? t(' (currently {{commit}})', { commit: remoteHead.oid.slice(0, 7) }) : t(' (new branch)')}{t('.')}
        {t('No tags are pushed')}{plan.followTagsConfigured ? t(' (push.followTags is overridden)') : ''}{t('; push tags explicitly from the Tags section.')}</p>
      {plan.hooks.length > 0 && <p className="git-muted">{t('Hooks that will run: {{hooks}}', { hooks: plan.hooks.join(t(', ')) })}</p>}
      {remoteHead && <label className="git-check git-ack"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
        {t('Force push (force-with-lease)')}</label>}
      {force && remoteHead && <p className="git-error">{t('Force pushing moves {{target}} from {{from}} to your local {{to}}; remote commits that are not local disappear from this branch.', { target: `${remote}/${remoteBranch}`, from: remoteHead.oid.slice(0, 7), to: plan.head?.slice(0, 7) ?? '' })}
        {t('It only overwrites while the remote is still {{commit}} (lease); if someone else pushed, the push is rejected. Session Bay has no recovery point for this.', { commit: remoteHead.oid.slice(0, 7) })}</p>}
      {plan.behind > 0 && <p className="git-warning">{t('Your branch is {{count}} commits behind upstream; the remote may reject the push.', { count: plan.behind })}</p>}
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running ? <><span className="git-muted"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Pushing…')}</span><button onClick={cancel}>{t('Stop')}</button></>
          : <><button onClick={() => setPending(null)}>取消</button>
            <button data-dialog-confirm className={force ? 'danger' : 'primary'} disabled={!remote || !remoteBranch.trim()} onClick={() => void run('push', async () => {
              const result = await gitApi.push(projectId, { repoId: repo.id, remote, localBranch: plan.branch!, remoteBranch: remoteBranch.trim(), setUpstream,
                ...(force && remoteHead ? { forceWithLease: remoteHead.oid } : {}) });
              return result.confirmed ? t('Pushed {{branch}} → {{target}} ({{commit}}).', { branch: plan.branch ?? '', target: `${remote}/${remoteBranch}`, commit: result.pushed.slice(0, 7) })
                : t('The push finished, but {{target}} could not be confirmed from the local remote-tracking ref; fetch to check.', { target: `${remote}/${remoteBranch}` });
            })}>{force ? t('Force push') : t('Push')}</button></>}
      </div>
    </Dialog>}
  </div>;
}
