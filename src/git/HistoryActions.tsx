import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { CommitDetail, Outcome, RepoInfo, RepoStatus, ResetMode } from './types';
import { resetModeLabel } from './types';

/** Reset moves a branch; it is never presented as a generic "undo". */
export function ResetDialog({ projectId, repo, status, commit, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; commit: CommitDetail;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<ResetMode>('mixed');
  const dirty = status.entries.filter(entry => !entry.untracked).length;
  const head = status.branch.oid ?? '';
  return <DangerDialog title={`Reset ${status.branch.head ?? 'HEAD'} 到 ${commit.oid.slice(0, 7)}？`} confirmLabel={`Reset --${mode}`}
    acknowledge={`我了解 ${status.branch.head ?? 'HEAD'} 會移到 ${commit.oid.slice(0, 7)}`}
    impact={<>
      <p>Repository <strong>{repo.name}</strong> 的 <strong>{status.branch.head ?? 'detached HEAD'}</strong> 從 {head.slice(0, 7)} 移到「{commit.message.split('\n')[0]}」（{commit.oid.slice(0, 7)}）。之後的 commit 不再屬於此 branch。</p>
      <p>{resetModeLabel[mode].detail}</p>
      {mode === 'hard' && dirty > 0 && <p className="git-warning">目前有 {dirty} 個 tracked 檔案的未提交變更會被覆蓋。</p>}
    </>}
    recovery="自動建立復原點：保存 HEAD／branch 位置、index 與 tracked 工作檔的未提交變更；untracked 與 ignored 檔案不受 reset 影響也不在其中。"
    onClose={onClose}
    onConfirm={async () => onOutcome(await gitApi.reset(projectId, { repoId: repo.id, target: commit.oid, mode, expectedHead: head }))}>
    <fieldset className="git-radio-row"><legend>模式</legend>
      {(Object.keys(resetModeLabel) as ResetMode[]).map(value => <label key={value}>
        <input type="radio" name="reset-mode" checked={mode === value} onChange={() => setMode(value)} />{resetModeLabel[value].title}</label>)}
    </fieldset>
  </DangerDialog>;
}

/** Revert adds a new commit that applies the reverse change. */
export function RevertDialog({ projectId, repo, status, commit, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; commit: CommitDetail;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [parent, setParent] = useState<number | null>(commit.parents.length > 1 ? null : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const merge = commit.parents.length > 1;
  return <Dialog title={`Revert ${commit.oid.slice(0, 7)}？`} onClose={() => { if (!busy) onClose(); }}>
    <p>在 <strong>{repo.name}</strong> 的 {status.branch.head ?? 'detached HEAD'} 建立一個<strong>新的 commit</strong>，反向套用「{commit.message.split('\n')[0]}」。原本的 commit 與歷史保持不變。</p>
    {merge && <label className="git-field">Merge commit 的主線 parent
      <select value={parent ?? ''} onChange={event => setParent(event.target.value ? Number(event.target.value) : null)}>
        <option value="">請選擇</option>
        {commit.parents.map((oid, index) => <option key={oid} value={index + 1}>parent {index + 1} · {oid.slice(0, 7)}</option>)}
      </select></label>}
    <p className="git-muted">若反向套用產生衝突，會停在 revert 進行中，可在應用內解決後 continue 或 abort。</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" data-dialog-confirm disabled={busy || (merge && !parent)} onClick={() => {
        setBusy(true); setError('');
        gitApi.revert(projectId, { repoId: repo.id, commit: commit.oid, parent, expectedHead: status.branch.oid ?? '' })
          .then(result => { onOutcome(result); onClose(); }, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>建立 revert commit</button>
    </div>
  </Dialog>;
}
