import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { parseTerminalFileTarget, type TerminalFileOpen, type TerminalFileTarget } from '../terminal-file-links';
import type { Pane, TerminalFileCandidate, TerminalFileResolution } from '../types';
import { Dialog } from './Dialog';
import { FileIcon } from './ExplorerTree';

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
  return <Dialog title="開啟終端輸出的檔案" onClose={() => { generation.current++; onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) void resolve(text); }}>
      <p className="dialog-description">{pane.title} · 僅開啟此終端所屬專案內的唯讀檔案。</p>
      <label className="field-label" htmlFor={id}>檔案路徑（可含 :行:欄）
        <input id={id} value={text} maxLength={4096} aria-describedby={`${id}-help`} onChange={event => {
          generation.current++; setBusy(false); setResult(undefined); setError(''); setText(event.target.value);
        }} /></label>
      <p id={`${id}-help`} className="small-muted">相對路徑的 shell 當前目錄尚未驗證，請確認下方候選；啟動目錄只作提示。</p>
      <div className="dialog-actions"><button type="button" onClick={() => { generation.current++; onClose(); }}>取消</button>
        <button type="submit" data-dialog-confirm className="primary" disabled={busy || !text.trim()}>{busy ? '尋找中…' : '尋找專案檔案'}</button></div>
    </form>
    {error && <p role="alert" className="inline-warning">{error}</p>}
    {result && <>
      {request.confirmAbsolute && result.resolution.absolute && <p className="small-muted">未加引號的輸出可能含有空白，請確認完整檔案目標。</p>}
      <p role="status">{result.resolution.candidates.length ? '請選擇要開啟的檔案；不會自動採用第一筆。' : '找不到可安全開啟的文字或圖片，請檢查完整路徑。'}</p>
      {result.resolution.launchDirectory !== null && <p className="small-muted">啟動目錄候選基準：{result.resolution.launchDirectory || '專案根目錄'}（不是已驗證的 shell 當前目錄）</p>}
      {result.resolution.truncated && <p className="inline-warning">搜尋範圍有限，可能還有其他候選；可輸入完整專案內路徑。</p>}
      <div className="terminal-file-candidates" aria-label="專案檔案候選">
        {result.resolution.candidates.map(candidate => <button key={candidate.path} type="button" title={candidate.path}
          onClick={() => open(candidate, result.target)}><FileIcon path={candidate.path} /><span>{candidate.path}</span>
          {candidate.fromLaunchDirectory && <small>啟動目錄候選</small>}</button>)}
      </div>
    </>}
  </Dialog>;
}
