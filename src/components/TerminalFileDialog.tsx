import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { parseTerminalFileTarget, type TerminalFileOpen, type TerminalFileTarget } from '../terminal-file-links';
import type { Pane, TerminalFileCandidate, TerminalFileResolution } from '../types';
import { Dialog } from './Dialog';
import { FileIcon } from './ExplorerTree';
import { t } from '../i18n';

export function TerminalFileDialog({ pane, request, valid, onOpen, onClose }: {
  pane: Pane & { projectId: string; runtimeId: string }; request: TerminalFileOpen;
  valid: () => boolean; onOpen: (file: TerminalFileCandidate, target: TerminalFileTarget) => void; onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(request.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ resolution: TerminalFileResolution; target: TerminalFileTarget }>();
  const generation = useRef(0);
  const settled = useRef(false);
  const open = (candidate: TerminalFileCandidate, target: TerminalFileTarget) => {
    if (settled.current || !valid()) return;
    settled.current = true;
    generation.current++;
    onOpen(candidate, target);
  };
  const resolve = async (value: string, automatic = false) => {
    const token = ++generation.current;
    setError(''); setResult(undefined);
    try {
      const target = parseTerminalFileTarget(value);
      setBusy(true);
      const resolution = await api.resolveTerminalFile(pane.projectId, pane.id, pane.runtimeId, target.path);
      if (token !== generation.current || !valid()) return;
      if (resolution.absolute && resolution.candidates.length === 1 && (!automatic || !request.confirmAbsolute)) open(resolution.candidates[0], target);
      else setResult({ resolution, target });
    } catch (cause) { if (token === generation.current && valid()) setError(errorMessage(cause)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => {
    const tracking = generation;
    if (request.autoResolve) void resolve(request.text, true);
    return () => { tracking.current++; };
    // One mount is one explicit terminal intent; navigation invalidates it upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Dialog title={t('Open a file from terminal output')} onClose={() => { generation.current++; onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) void resolve(text); }}>
      <p className="dialog-description">{pane.title} · {t('Only read-only files inside this terminal\'s project are opened.')}</p>
      <label className="field-label" htmlFor={id}>{t('File path (may include :line:column)')}
        <input id={id} value={text} maxLength={4096} aria-describedby={`${id}-help`} onChange={event => {
          generation.current++; setBusy(false); setResult(undefined); setError(''); setText(event.target.value);
        }} /></label>
      <p id={`${id}-help`} className="small-muted">{t('The shell\'s current directory for relative paths is not verified; check the candidates below. The launch directory is only a hint.')}</p>
      <div className="dialog-actions"><button type="button" onClick={() => { generation.current++; onClose(); }}>{t('Cancel')}</button>
        <button type="submit" data-dialog-confirm className="primary" disabled={busy || !text.trim()}>{busy ? t('Finding…') : t('Find project file')}</button></div>
    </form>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    {result && <>
      {request.confirmAbsolute && result.resolution.absolute && <p className="small-muted">{t('Unquoted output may contain spaces; confirm the full file target.')}</p>}
      <p role="status">{result.resolution.candidates.length ? t('Choose the file to open; the first match is never picked automatically.') : t('No text or image file that can be opened safely was found. Check the full path.')}</p>
      {result.resolution.launchDirectory !== null && <p className="small-muted">{t('Candidates relative to the launch directory: {{dir}} (not the verified shell directory)', { dir: result.resolution.launchDirectory || t('Project root') })}</p>}
      {result.resolution.truncated && <p className="inline-warning">{t('The search is limited and there may be more candidates; enter the full path inside the project.')}</p>}
      <div className="terminal-file-candidates" aria-label={t('Project file candidates')}>
        {result.resolution.candidates.map(candidate => <button key={candidate.path} type="button" title={candidate.path}
          onClick={() => open(candidate, result.target)}><FileIcon path={candidate.path} /><span>{candidate.path}</span>
          {candidate.fromLaunchDirectory && <small>{t('Launch directory candidate')}</small>}</button>)}
      </div>
    </>}
  </Dialog>;
}
