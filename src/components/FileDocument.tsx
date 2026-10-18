import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { WorkspaceFileInfo } from '../types';
import { ExplorerEditor, type ScrollPosition } from './ExplorerEditor';
import { FilePreviewBoundary } from './FilePreviewBoundary';
import { FULL_FILE_BYTES, NORMAL_FILE_BYTES, RangeRequired, readWorkspaceText, type ReadText } from './file-reader';

interface Props {
  projectId: string; path: string; searchRequest: number;
  position: ScrollPosition; onScroll: (position: ScrollPosition) => void;
}
type State = { phase: 'loading'; bytes: number } | { phase: 'confirm'; info: WorkspaceFileInfo }
  | { phase: 'range'; info: WorkspaceFileInfo } | { phase: 'ready'; info: WorkspaceFileInfo; value: ReadText }
  | { phase: 'error'; error: string } | { phase: 'cancelled' };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The active document owns its request/model; switching away cancels and releases it. */
export function FileDocument({ projectId, path, searchRequest, position, onScroll }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading', bytes: 0 });
  const [request, setRequest] = useState<{ generation: number; confirmed?: boolean; start?: number }>({ generation: 0 });
  const cancellation = useRef<AbortController | undefined>(undefined);
  const pageStarts = useRef<number[]>([0]);
  useEffect(() => {
    const controller = new AbortController(); cancellation.current = controller;
    setState({ phase: 'loading', bytes: 0 });
    void (async () => {
      const info = await api.inspectWorkspaceFile(projectId, path);
      controller.signal.throwIfAborted();
      if (info.path !== path || !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0 || !info.version) throw new Error('無效檔案資訊，請重新整理');
      if (info.kind !== 'text') throw new Error('此檔案不是支援的 UTF-8 文字');
      if (request.start === undefined && info.sizeBytes > FULL_FILE_BYTES) { setState({ phase: 'range', info }); return; }
      if (request.start === undefined && info.sizeBytes > NORMAL_FILE_BYTES && !request.confirmed) { setState({ phase: 'confirm', info }); return; }
      try {
        const value = await readWorkspaceText(projectId, info, controller.signal,
          bytes => setState({ phase: 'loading', bytes }), request.start);
        controller.signal.throwIfAborted(); setState({ phase: 'ready', info, value });
      } catch (error) {
        if (error instanceof RangeRequired && !controller.signal.aborted) setState({ phase: 'range', info });
        else throw error;
      }
    })().catch(error => { if (!controller.signal.aborted) setState({ phase: 'error', error: errorMessage(error) }); });
    return () => { controller.abort(); if (cancellation.current === controller) cancellation.current = undefined; };
  }, [projectId, path, request]);
  const retry = (options: { confirmed?: boolean; start?: number } = {}) => {
    if (options.start === undefined || options.start === 0) pageStarts.current = [0];
    setRequest(value => ({ generation: value.generation + 1, ...options }));
  };
  const cancel = () => { cancellation.current?.abort(); setState({ phase: 'cancelled' }); };
  if (state.phase === 'loading') return <div className="explorer-empty"><p role="status">讀取檔案中…{state.bytes > 0 && ` ${size(state.bytes)}`}</p><button onClick={cancel}>取消讀取</button></div>;
  if (state.phase === 'cancelled') return <div className="explorer-empty"><p>已取消讀取</p><button onClick={() => retry()}>重新讀取檔案</button></div>;
  if (state.phase === 'error') return <div className="explorer-empty"><p role="alert">{state.error}</p><button onClick={() => retry()}>重新讀取檔案</button></div>;
  if (state.phase === 'confirm' || state.phase === 'range') return <div className="explorer-empty">
    <strong>{state.phase === 'confirm' ? '開啟大型文字檔' : '分段閱讀大型文字檔'}</strong><p>{size(state.info.sizeBytes)} · {path}</p>
    <p>{state.phase === 'confirm' ? '以純文字模式閱讀，暫停語法高亮與折疊，降低記憶體使用。' : '每次讀取約 1 MiB。搜尋與複製僅包含目前區段。'}</p>
    {state.phase === 'confirm' && <button onClick={() => retry({ confirmed: true })}>繼續開啟</button>}
    <button onClick={() => retry({ start: 0 })}>分段閱讀</button><button onClick={cancel}>取消</button>
  </div>;
  const { value, info } = state;
  return <div className="file-document-content">
    {value.longestLine > 10000 && value.lightweight && <p className="explorer-notice" role="status">超長行僅繪製前 10,000 字元；選取與複製仍保留目前內容。</p>}
    {value.partial && <div className="file-range-bar" role="group" aria-label="檔案閱讀區段">
      <button disabled={pageStarts.current.length <= 1} onClick={() => { pageStarts.current.pop(); retry({ start: pageStarts.current.at(-1) ?? 0 }); }}>上一段</button>
      <span>bytes {value.start.toLocaleString()}–{value.end.toLocaleString()} / {info.sizeBytes.toLocaleString()}</span>
      <button disabled={value.end >= info.sizeBytes} onClick={() => { pageStarts.current.push(value.end); retry({ start: value.end }); }}>下一段</button>
    </div>}
    <FilePreviewBoundary key={`${path}:${info.version}:${value.start}`} path={path}>
      <ExplorerEditor path={path} text={value.text} sizeBytes={info.sizeBytes} searchRequest={searchRequest}
        lightweight={value.lightweight} partial={value.partial} lineCount={value.lines}
        position={value.partial ? { top: 0, left: 0 } : position} onScroll={value.partial ? () => {} : onScroll} />
    </FilePreviewBoundary>
  </div>;
}
