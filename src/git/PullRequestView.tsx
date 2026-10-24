import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, LoaderCircle, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { hostingApi } from './hosting-api';
import { parsePatch } from './patch-parse';
import type { LinePosition, PullComment, PullDetail, PullFile, ReviewEvent } from './types';
import { ciLabel } from './types';

const stateLabel = { open: '開啟', closed: '已關閉', merged: '已合併' } as const;
const methodLabel: Record<string, string> = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase', rebaseMerge: 'Rebase 後合併', fastForward: 'Fast-forward' };

function FilePatch({ file, comments, canComment, onComment }: {
  file: PullFile; comments: PullComment[]; canComment: boolean; onComment: (position: LinePosition) => void;
}) {
  const hunks = useMemo(() => file.patch ? parsePatch(file.patch) : [], [file.patch]);
  return <section className="git-pr-file" aria-label={file.path}>
    <header><strong>{file.path}</strong>{file.oldPath && <span className="git-muted">（原 {file.oldPath}）</span>}
      <span className="git-muted"> {file.status} · +{file.additions} −{file.deletions}</span></header>
    {!file.patch ? <p className="git-muted git-pad">非文字或過大的變更；不顯示內容差異。</p>
      : <div className="git-diff-body inline">{hunks.map((hunk, h) => <div key={h}>
        <div className="git-hunk-header"><code>{hunk.header}</code></div>
        {hunk.lines.map((line, l) => {
          const side = line.kind === 'delete' ? 'old' : 'new';
          const number = side === 'old' ? line.oldLine : line.newLine;
          const here = comments.filter(comment => comment.path === file.path && comment.line === number && comment.side === side);
          return <div key={`${h}:${l}`}>
            <div className={`git-line ${line.kind}`}>
              <span className="git-gutter">
                {canComment && number !== null ? <button className="git-line-select" aria-label={`在 ${file.path} ${side === 'old' ? '舊版' : '新版'}第 ${number} 行留言`} title="逐行留言"
                  onClick={() => onComment({ path: file.path, oldPath: file.oldPath, side, line: number })}><span className="git-line-no">{number}</span></button>
                  : <span className="git-line-no">{number}</span>}
              </span>
              <span className="git-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '}</span>
              <code className="git-line-text">{line.text}</code>
            </div>
            {here.map(comment => <div key={comment.id} className="git-pr-inline-comment"><strong>{comment.author}</strong> {comment.body}</div>)}
          </div>;
        })}
      </div>)}</div>}
  </section>;
}

/** One PR/MR; every write is bound to the head SHA shown here. */
export function PullRequestView({ projectId, repoId, remote, number }: { projectId: string; repoId: string; remote: string; number: number }) {
  const [detail, setDetail] = useState<PullDetail | null>(null);
  const [files, setFiles] = useState<{ files: PullFile[]; truncated: boolean } | null>(null);
  const [comments, setComments] = useState<PullComment[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const [lineDraft, setLineDraft] = useState<{ position: LinePosition; body: string } | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const request = useMemo(() => ({ repoId, remote, number }), [repoId, remote, number]);
  const load = useCallback(async (keepMessage = false) => {
    if (!keepMessage) setError('');
    try {
      const [nextDetail, nextFiles, nextComments] = await Promise.all([
        gitApi.pullDetail(projectId, request), gitApi.pullFiles(projectId, request), gitApi.pullComments(projectId, request)]);
      setDetail(nextDetail); setFiles(nextFiles); setComments(nextComments);
    } catch (failure) { setError(errorMessage(failure)); }
  }, [projectId, request]);
  useEffect(() => { void load(); }, [load]);
  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(label); await load(true); return true; }
    catch (failure) {
      const text = errorMessage(failure);
      setError(text);
      // A moved head invalidates what was shown: reload for a fresh review.
      if (text.includes('遠端已有新的 commit')) await load(true);
      return false;
    } finally { setBusy(false); }
  };
  if (!detail) return <div className="git-pr">{error ? <p className="git-error" role="alert">{error}</p>
    : <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> 讀取 PR／MR…</p>}</div>;
  const { summary, capabilities } = detail;
  const head = summary.headSha;
  const review = (event: ReviewEvent, label: string) => void act(label, () => gitApi.pullReview(projectId, { ...request, event, body, expectedHead: head })).then(ok => { if (ok) setBody(''); });
  const general = comments.filter(comment => !comment.path);
  return <div className="git-pr">
    <div className="git-doc-toolbar">
      <span className="git-doc-title"><strong>#{summary.number} {summary.title}</strong>
        <span className="git-muted"> · {stateLabel[summary.state]}{summary.draft ? '（草稿）' : ''} · {summary.author} · {summary.sourceBranch} → {summary.targetBranch}</span></span>
      <button className="git-icon-button" aria-label="重新整理 PR" title="重新整理" disabled={busy} onClick={() => void load()}><RefreshCw size={14} /></button>
      <button className="git-icon-button" aria-label="在瀏覽器開啟" title="在原平台開啟" onClick={() => void hostingApi.openExternal(projectId, summary.webUrl).catch(failure => setError(errorMessage(failure)))}><ExternalLink size={14} /></button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
    {notice && <p className="git-success" role="status">{notice}</p>}
    <div className="git-pr-body">
      <dl className="git-facts">
        <dt>帳號</dt><dd>{detail.connection.account}@{detail.connection.host}</dd>
        <dt>Head</dt><dd><code>{head.slice(0, 12)}</code>（review 與合併只套用到這個版本）</dd>
        <dt>CI</dt><dd className={`git-ci ${detail.ci.state}`}>{ciLabel[detail.ci.state]}
          <span className="git-muted">（讀取於 {new Date(detail.ci.fetchedAt * 1000).toLocaleTimeString()}，非即時）</span>
          {detail.ci.checks.map(check => <div key={check.name} className="git-muted">{check.name}：{ciLabel[check.state]}
            {check.url && <button className="git-link" onClick={() => void hostingApi.openExternal(projectId, check.url!).catch(failure => setError(errorMessage(failure)))}>開啟紀錄</button>}</div>)}</dd>
        <dt>核准</dt><dd>{detail.approvedBy.length ? detail.approvedBy.join('、') : '尚無'}</dd>
        <dt>可合併</dt><dd>{detail.mergeable === null ? '平台仍在檢查' : detail.mergeable ? '是' : `否（${detail.mergeStatus}）`}</dd>
      </dl>
      {detail.mergeable === false && <p className="git-warning">PR／MR 有衝突或無法合併。可在本機切換到 {summary.sourceBranch}，於 Branches 合併 {remote}/{summary.targetBranch}，在 Session Bay 解決衝突後推送。</p>}
      {capabilities.notes.map(note => <p key={note} className="git-muted">{note}</p>)}
      {detail.body && <pre className="git-message git-pr-description">{detail.body}</pre>}
      <section aria-label="討論">
        {general.map(comment => <div key={comment.id} className="git-pr-comment"><strong>{comment.author}</strong> <span className="git-muted">{comment.createdAt}</span><p>{comment.body}</p></div>)}
        {summary.state === 'open' && <div className="git-form">
          <label className="git-field">留言或 review 說明<textarea rows={3} value={body} onChange={event => setBody(event.target.value)} /></label>
          <div className="git-row">
            <button disabled={busy || !body.trim()} onClick={() => void act('已留言', () => gitApi.pullComment(projectId, { ...request, body, position: null, expectedHead: head })).then(ok => { if (ok) setBody(''); })}>留言</button>
            {capabilities.canApprove && !detail.viewerApproved && <button className="primary" disabled={busy} onClick={() => review('approve', `已核准 ${head.slice(0, 7)}`)}>核准此版本</button>}
            {detail.viewerApproved && detail.connection.provider === 'gitlab' && <button disabled={busy} onClick={() => review('unapprove', '已撤回核准')}>撤回核准</button>}
            {capabilities.canRequestChanges && <button disabled={busy || !body.trim()} onClick={() => review('requestChanges', '已要求變更')}>要求變更</button>}
          </div>
          {capabilities.canMerge && <div className="git-row">
            {capabilities.mergeMethods.map(method => <button key={method} disabled={busy || detail.mergeable === false} onClick={() => setMerging(method)}>合併：{methodLabel[method] ?? method}…</button>)}
          </div>}
        </div>}
      </section>
      {files?.truncated && <p className="git-notice">檔案過多，只顯示前 {files.files.length} 個；完整內容請在原平台查看。</p>}
      {files?.files.map(file => <FilePatch key={file.path} file={file} comments={comments} canComment={summary.state === 'open'}
        onComment={position => setLineDraft({ position, body: '' })} />)}
    </div>
    {lineDraft && <Dialog title={`留言：${lineDraft.position.path}:${lineDraft.position.line}`} onClose={() => { if (!busy) setLineDraft(null); }}>
      <label className="git-field">留言（綁定 head {head.slice(0, 7)}）<textarea rows={4} value={lineDraft.body} onChange={event => setLineDraft({ ...lineDraft, body: event.target.value })} /></label>
      <div className="dialog-actions">
        <button onClick={() => setLineDraft(null)}>取消</button>
        <button className="primary" data-dialog-confirm disabled={busy || !lineDraft.body.trim()} onClick={() => void act('已新增逐行留言',
          () => gitApi.pullComment(projectId, { ...request, body: lineDraft.body, position: lineDraft.position, expectedHead: head })).then(ok => { if (ok) setLineDraft(null); })}>
          <MessageSquarePlus size={14} aria-hidden="true" />留言</button>
      </div>
    </Dialog>}
    {merging && <Dialog title={`合併 #${summary.number}？`} onClose={() => { if (!busy) setMerging(null); }}>
      <p>以 <strong>{methodLabel[merging] ?? merging}</strong> 將 {summary.sourceBranch} 合併到 {summary.targetBranch}。</p>
      <p>只會合併 head <code>{head.slice(0, 12)}</code>；若遠端已有新 commit，平台與 Session Bay 都會拒絕。</p>
      <p className="git-muted">CI：{ciLabel[detail.ci.state]}{detail.ci.state !== 'success' ? '（未確認通過）' : ''}</p>
      <div className="dialog-actions">
        <button onClick={() => setMerging(null)}>取消</button>
        <button className="primary" data-dialog-confirm disabled={busy} onClick={() => void act('已合併', () => gitApi.pullMerge(projectId, { ...request, method: merging, expectedHead: head })).then(() => setMerging(null))}>合併</button>
      </div>
    </Dialog>}
  </div>;
}
