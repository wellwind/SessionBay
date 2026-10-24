import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { DangerDialog } from './DangerDialog';
import type { Branch, Outcome, RepoInfo, RepoStatus } from './types';
import { operationLabel } from './types';

const abortEffect: Record<string, string> = {
  merge: '回到合併前的 commit 與檔案；已在此合併中解決的內容會被捨棄。',
  rebase: '回到 rebase 前的 branch 位置；已重放與解決的 commit 會被捨棄。',
  cherryPick: '回到 cherry-pick 前的狀態。', revert: '回到 revert 前的狀態。', am: '回到套用 patch 前的狀態。', bisect: '結束 bisect 並回到開始前的 commit。',
};

/** Continue/abort for an in-progress merge, rebase, cherry-pick or revert. */
export function OperationBar({ projectId, repo, status, onOutcome }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; onOutcome: (outcome: Outcome | { error: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [aborting, setAborting] = useState(false);
  if (!status.operation) return null;
  const conflicts = status.entries.filter(entry => entry.conflict).length;
  return <div className="git-operation" role="region" aria-label={operationLabel[status.operation]}>
    <strong className="git-warning">{operationLabel[status.operation]}</strong>
    <span className="git-muted">{conflicts ? `${conflicts} 個衝突檔案待解決` : '衝突已解決，可以繼續'}</span>
    <div className="git-row">
      {status.operation !== 'bisect' && <button className="primary" disabled={busy || conflicts > 0} title={conflicts ? '請先解決所有衝突' : undefined}
        onClick={() => {
          setBusy(true);
          gitApi.continueOperation(projectId, { repoId: repo.id }).then(onOutcome, failure => onOutcome({ error: errorMessage(failure) })).finally(() => setBusy(false));
        }}>Continue</button>}
      <button className="danger" disabled={busy} onClick={() => setAborting(true)}>Abort…</button>
    </div>
    {aborting && <DangerDialog title={`中止${operationLabel[status.operation].replace('進行中', '')}？`} confirmLabel="Abort"
      acknowledge="我了解操作中的結果會被捨棄"
      impact={<p>{repo.name}：{abortEffect[status.operation]}</p>}
      recovery="中止前自動建立復原點，保存目前工作目錄中已修改檔案的內容（衝突中的 index 狀態無法保存）。"
      onClose={() => setAborting(false)}
      onConfirm={async () => onOutcome(await gitApi.abortOperation(projectId, { repoId: repo.id }))} />}
  </div>;
}

export function MergeDialog({ projectId, repo, status, branch, onOutcome, onClose }: {
  projectId: string; repo: RepoInfo; status: RepoStatus; branch: Branch;
  onOutcome: (outcome: Outcome) => void; onClose: () => void;
}) {
  const [noFf, setNoFf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Dialog title={`合併 ${branch.name}？`} onClose={() => { if (!busy) onClose(); }}>
    <p>把 <code>{branch.name}</code>（{branch.oid.slice(0, 7)}）合併到 <strong>{repo.name}</strong> 的 <code>{status.branch.head ?? 'HEAD'}</code>。</p>
    <label className="git-check"><input type="checkbox" checked={noFf} onChange={event => setNoFf(event.target.checked)} />一律建立合併 commit（--no-ff）</label>
    <p className="git-muted">若有衝突，會停在合併進行中，可在 Git 面板逐檔解決後 Continue，或 Abort 回到合併前。</p>
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={onClose}>取消</button>
      <button className="primary" data-dialog-confirm disabled={busy} onClick={() => {
        setBusy(true); setError('');
        gitApi.merge(projectId, { repoId: repo.id, rev: branch.fullName, noFf, expectedHead: status.branch.oid ?? '' })
          .then(result => { onOutcome(result); onClose(); }, failure => { setError(errorMessage(failure)); setBusy(false); });
      }}>合併</button>
    </div>
  </Dialog>;
}
