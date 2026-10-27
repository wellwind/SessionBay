import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, LoaderCircle, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import { hostingApi } from './hosting-api';
import { parsePatch } from './patch-parse';
import type { LinePosition, PullComment, PullDetail, PullFile, ReviewEvent } from './types';
import { ciLabel } from './types';
import { locale, t } from '../i18n';

const stateLabel = { open: t('Open (PR)'), closed: t('Closed'), merged: t('Merged') } as const;
const methodLabel: Record<string, string> = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase', rebaseMerge: t('Rebase and merge'), fastForward: 'Fast-forward' };

function FilePatch({ file, comments, canComment, onComment }: {
  file: PullFile; comments: PullComment[]; canComment: boolean; onComment: (position: LinePosition) => void;
}) {
  const hunks = useMemo(() => file.patch ? parsePatch(file.patch) : [], [file.patch]);
  return <section className="git-pr-file" aria-label={file.path}>
    <header><strong>{file.path}</strong>{file.oldPath && <span className="git-muted">{t(' (was {{path}})', { path: file.oldPath })}</span>}
      <span className="git-muted"> {file.status} · +{file.additions} −{file.deletions}</span></header>
    {!file.patch ? <p className="git-muted git-pad">{t('Non-text or oversized change; no content diff is shown.')}</p>
      : <div className="git-diff-body inline">{hunks.map((hunk, h) => <div key={h}>
        <div className="git-hunk-header"><code>{hunk.header}</code></div>
        {hunk.lines.map((line, l) => {
          const side = line.kind === 'delete' ? 'old' : 'new';
          const number = side === 'old' ? line.oldLine : line.newLine;
          const here = comments.filter(comment => comment.path === file.path && comment.line === number && comment.side === side);
          return <div key={`${h}:${l}`}>
            <div className={`git-line ${line.kind}`}>
              <span className="git-gutter">
                {canComment && number !== null ? <button className="git-line-select" aria-label={side === 'old' ? t('Comment on old line {{line}} of {{path}}', { path: file.path, line: number }) : t('Comment on new line {{line}} of {{path}}', { path: file.path, line: number })} title={t('Line comment')}
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
      if (text.includes(t('A new commit is on the remote'))) await load(true);
      return false;
    } finally { setBusy(false); }
  };
  if (!detail) return <div className="git-pr">{error ? <p className="git-error" role="alert">{error}</p>
    : <p className="git-muted git-pad" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> {t('Loading PR / MR…')}</p>}</div>;
  const { summary, capabilities } = detail;
  const head = summary.headSha;
  const review = (event: ReviewEvent, label: string) => void act(label, () => gitApi.pullReview(projectId, { ...request, event, body, expectedHead: head })).then(ok => { if (ok) setBody(''); });
  const general = comments.filter(comment => !comment.path);
  return <div className="git-pr">
    <div className="git-doc-toolbar">
      <span className="git-doc-title"><strong>#{summary.number} {summary.title}</strong>
        <span className="git-muted"> · {stateLabel[summary.state]}{summary.draft ? t(' (draft)') : ''} · {summary.author} · {summary.sourceBranch} → {summary.targetBranch}</span></span>
      <button className="git-icon-button" aria-label={t('Refresh PR')} title={t('Refresh')} disabled={busy} onClick={() => void load()}><RefreshCw size={14} /></button>
      <button className="git-icon-button" aria-label={t('Open in browser')} title={t('Open on the hosting site')} onClick={() => void hostingApi.openExternal(projectId, summary.webUrl).catch(failure => setError(errorMessage(failure)))}><ExternalLink size={14} /></button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
    {notice && <p className="git-success" role="status">{notice}</p>}
    <div className="git-pr-body">
      <dl className="git-facts">
        <dt>{t('Account')}</dt><dd>{detail.connection.account}@{detail.connection.host}</dd>
        <dt>Head</dt><dd><code>{head.slice(0, 12)}</code>{t(' (reviews and merges apply only to this version)')}</dd>
        <dt>CI</dt><dd className={`git-ci ${detail.ci.state}`}>{ciLabel[detail.ci.state]}
          <span className="git-muted">{t(' (fetched at {{time}}, not live)', { time: new Date(detail.ci.fetchedAt * 1000).toLocaleTimeString(locale()) })}</span>
          {detail.ci.checks.map(check => <div key={check.name} className="git-muted">{t('{{name}}: {{state}}', { name: check.name, state: ciLabel[check.state] })}
            {check.url && <button className="git-link" onClick={() => void hostingApi.openExternal(projectId, check.url!).catch(failure => setError(errorMessage(failure)))}>{t('Open log')}</button>}</div>)}</dd>
        <dt>{t('Approvals')}</dt><dd>{detail.approvedBy.length ? detail.approvedBy.join(t(', ')) : t('None yet')}</dd>
        <dt>{t('Mergeable')}</dt><dd>{detail.mergeable === null ? t('Still being checked by the host') : detail.mergeable ? t('Yes') : t('No ({{status}})', { status: detail.mergeStatus })}</dd>
      </dl>
      {detail.mergeable === false && <p className="git-warning">{t('The PR / MR has conflicts or cannot be merged. Switch to {{source}} locally, merge {{target}} from Branches, resolve the conflicts in Session Bay and push.', { source: summary.sourceBranch, target: `${remote}/${summary.targetBranch}` })}</p>}
      {capabilities.notes.map(note => <p key={note} className="git-muted">{note}</p>)}
      {detail.body && <pre className="git-message git-pr-description">{detail.body}</pre>}
      <section aria-label={t('Discussion')}>
        {general.map(comment => <div key={comment.id} className="git-pr-comment"><strong>{comment.author}</strong> <span className="git-muted">{comment.createdAt}</span><p>{comment.body}</p></div>)}
        {summary.state === 'open' && <div className="git-form">
          <label className="git-field">{t('Comment or review note')}<textarea rows={3} value={body} onChange={event => setBody(event.target.value)} /></label>
          <div className="git-row">
            <button disabled={busy || !body.trim()} onClick={() => void act(t('Comment posted'), () => gitApi.pullComment(projectId, { ...request, body, position: null, expectedHead: head })).then(ok => { if (ok) setBody(''); })}>{t('Comment')}</button>
            {capabilities.canApprove && !detail.viewerApproved && <button className="primary" disabled={busy} onClick={() => review('approve', t('Approved {{commit}}', { commit: head.slice(0, 7) }))}>{t('Approve this version')}</button>}
            {detail.viewerApproved && detail.connection.provider === 'gitlab' && <button disabled={busy} onClick={() => review('unapprove', t('Approval withdrawn'))}>{t('Withdraw approval')}</button>}
            {capabilities.canRequestChanges && <button disabled={busy || !body.trim()} onClick={() => review('requestChanges', t('Changes requested'))}>{t('Request changes')}</button>}
          </div>
          {capabilities.canMerge && <div className="git-row">
            {capabilities.mergeMethods.map(method => <button key={method} disabled={busy || detail.mergeable === false} onClick={() => setMerging(method)}>{t('Merge: {{method}}…', { method: methodLabel[method] ?? method })}</button>)}
          </div>}
        </div>}
      </section>
      {files?.truncated && <p className="git-notice">{t('Too many files; showing the first {{count}}. See the full change on the hosting site.', { count: files.files.length })}</p>}
      {files?.files.map(file => <FilePatch key={file.path} file={file} comments={comments} canComment={summary.state === 'open'}
        onComment={position => setLineDraft({ position, body: '' })} />)}
    </div>
    {lineDraft && <Dialog title={t('Comment: {{location}}', { location: `${lineDraft.position.path}:${lineDraft.position.line}` })} onClose={() => { if (!busy) setLineDraft(null); }}>
      <label className="git-field">{t('Comment (tied to head {{commit}})', { commit: head.slice(0, 7) })}<textarea rows={4} value={lineDraft.body} onChange={event => setLineDraft({ ...lineDraft, body: event.target.value })} /></label>
      <div className="dialog-actions">
        <button onClick={() => setLineDraft(null)}>{t('Cancel')}</button>
        <button className="primary" data-dialog-confirm disabled={busy || !lineDraft.body.trim()} onClick={() => void act(t('Line comment added'),
          () => gitApi.pullComment(projectId, { ...request, body: lineDraft.body, position: lineDraft.position, expectedHead: head })).then(ok => { if (ok) setLineDraft(null); })}>
          <MessageSquarePlus size={14} aria-hidden="true" />{t('Comment')}</button>
      </div>
    </Dialog>}
    {merging && <Dialog title={t('Merge #{{number}}?', { number: summary.number })} onClose={() => { if (!busy) setMerging(null); }}>
      <p>{t('Merges {{source}} into {{target}} with {{method}}.', { method: methodLabel[merging] ?? merging, source: summary.sourceBranch, target: summary.targetBranch })}</p>
      <p>{t('Only head {{commit}} is merged; if the remote has newer commits, both the host and Session Bay refuse.', { commit: head.slice(0, 12) })}</p>
      <p className="git-muted">{t('CI: {{state}}', { state: ciLabel[detail.ci.state] })}{detail.ci.state !== 'success' ? t(' (not confirmed passing)') : ''}</p>
      <div className="dialog-actions">
        <button onClick={() => setMerging(null)}>{t('Cancel')}</button>
        <button className="primary" data-dialog-confirm disabled={busy} onClick={() => void act(t('Merged'), () => gitApi.pullMerge(projectId, { ...request, method: merging, expectedHead: head })).then(() => setMerging(null))}>{t('Merge')}</button>
      </div>
    </Dialog>}
  </div>;
}
