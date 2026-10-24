import { useState } from 'react';
import { GitCompare, GitBranchPlus, GitMerge, Trash2 } from 'lucide-react';
import { MergeDialog } from './OperationBar';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Branch, Outcome, Refs, RepoInfo, RepoStatus } from './types';

/** Local and remote branches with repo context on every action. */
export function BranchesPanel({ projectId, repo, status, refs, onOutcome, onCompare }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; refs: Refs | null;
  onOutcome: (outcome: Outcome | { error: string }) => void; onCompare: (base: string, head: string) => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [switchTo, setSwitchTo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Branch | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [force, setForce] = useState(false);
  const [merging, setMerging] = useState<Branch | null>(null);
  const dirty = status.entries.some(entry => !entry.untracked);
  const blocked = status.operation ? '有進行中的操作' : dirty ? '工作目錄有未提交的變更' : '';
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    try { onOutcome(await action()); }
    catch (failure) { onOutcome({ error: errorMessage(failure) }); }
    finally { setBusy(false); }
  };
  const local = refs?.branches.filter(branch => !branch.remote) ?? [];
  const remote = refs?.branches.filter(branch => branch.remote) ?? [];
  const current = local.find(branch => branch.current)?.name ?? 'HEAD';
  const row = (branch: Branch) => {
    const switchReason = branch.current ? '目前 branch' : branch.worktree ? `已在其他 worktree 使用：${branch.worktree}` : blocked;
    return <li key={branch.fullName} className={`git-change${branch.current ? ' selected' : ''}`}>
      <button className="git-change-open" disabled={!!switchReason || busy} title={switchReason || `切換到 ${branch.name}`}
        aria-label={`${branch.remote ? '從遠端建立並切換' : '切換到'} ${branch.name}${branch.current ? '（目前）' : ''}`}
        onClick={() => void run(() => gitApi.switchBranch(projectId, { repoId: repo.id, name: branch.name }))}>
        <span className="git-change-name">{branch.current ? '● ' : ''}{branch.name}</span>
        <span className="git-change-dir">
          {branch.upstreamGone ? 'upstream 已刪除' : branch.upstream ? `${branch.upstream}${branch.ahead ? ` ↑${branch.ahead}` : ''}${branch.behind ? ` ↓${branch.behind}` : ''}` : ''}
          {branch.worktree ? ' · 其他 worktree' : ''}
        </span>
      </button>
      <span className="git-change-actions">
        {!branch.current && <button aria-label={`比較 ${current} 與 ${branch.name}`} title={`比較 ${current}...${branch.name}`}
          onClick={() => onCompare(current, branch.name)}><GitCompare size={14} /></button>}
        {!branch.current && status.branch.head && <button aria-label={`合併 ${branch.name} 到 ${current}`} title={`合併到 ${current}`}
          disabled={!!blocked || busy} onClick={() => setMerging(branch)}><GitMerge size={14} /></button>}
        {!branch.remote && !branch.current && !branch.worktree && <button aria-label={`刪除 branch ${branch.name}`} title="刪除 branch"
          onClick={() => setDeleting(branch)}><Trash2 size={14} /></button>}
      </span>
    </li>;
  };
  return <div className="git-form">
    {blocked && <p className="git-muted">{blocked}，暫不切換 branch。</p>}
    <ul className="git-file-list" aria-label="本機 branches">{local.map(row)}</ul>
    {remote.length > 0 && <button className="git-link" aria-expanded={showRemote} onClick={() => setShowRemote(value => !value)}>
      {showRemote ? '隱藏' : '顯示'}遠端 branches（{remote.length}）</button>}
    {showRemote && <ul className="git-file-list" aria-label="遠端 branches">{remote.map(row)}</ul>}
    <form className="git-form git-inline-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim()) return;
      void run(() => gitApi.createBranch(projectId, { repoId: repo.id, name: name.trim(), start: start.trim() || null, switch: switchTo && !blocked })).then(() => setName(''));
    }}>
      <label className="git-field">新 branch 名稱<input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="git-field">起點（預設 HEAD）<input value={start} placeholder={status.branch.oid?.slice(0, 7) ?? 'HEAD'} onChange={event => setStart(event.target.value)} /></label>
      <label className="git-check"><input type="checkbox" checked={switchTo} disabled={!!blocked} onChange={event => setSwitchTo(event.target.checked)} />建立後切換</label>
      <button type="submit" disabled={busy || !name.trim() || status.branch.unborn}><GitBranchPlus size={14} aria-hidden="true" />建立 branch</button>
    </form>
    {merging && <MergeDialog projectId={projectId} repo={repo} status={status} branch={merging} onClose={() => setMerging(null)}
      onOutcome={result => onOutcome(result)} />}
    {deleting && <DangerDialog title={`刪除 branch ${deleting.name}？`} confirmLabel={force ? '強制刪除 branch' : '刪除 branch'}
      acknowledge={`我了解 ${repo.name} 的 branch ${deleting.name} 會被刪除`}
      impact={<p>Repository <strong>{repo.name}</strong> 的本機 branch <code>{deleting.name}</code>（{deleting.oid.slice(0, 7)}）會被刪除；遠端 branch 不受影響。</p>}
      recovery={`自動建立復原點，保存 branch 指向的 commit ${deleting.oid.slice(0, 7)}，可在「復原點」重新建立此 branch。`}
      onClose={() => { setDeleting(null); setForce(false); }}
      onConfirm={async () => {
        const result = await gitApi.deleteBranch(projectId, { repoId: repo.id, name: deleting.name, expected: deleting.oid, force });
        onOutcome(result);
      }}>
      <label className="git-check"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
        即使尚未合併也刪除（-D）</label>
    </DangerDialog>}
  </div>;
}
