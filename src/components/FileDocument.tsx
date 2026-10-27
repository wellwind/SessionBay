import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { FileReference, WorkspaceFileInfo } from '../types';
import { ExplorerEditor, type ScrollPosition } from './ExplorerEditor';
import { ImageViewer } from './ImageViewer';
import { parseWorkspaceImage, type ImagePreview } from './image-reader';
import { FilePreviewBoundary } from './FilePreviewBoundary';
import { FULL_FILE_BYTES, NORMAL_FILE_BYTES, RangeRequired, readWorkspaceText, type ReadText } from './file-reader';
import { t } from '../i18n';

interface Props {
  projectId: string; path: string; searchRequest: number;
  reference?: FileReference; onReferenceHandled?: (nonce: number) => void;
  position: ScrollPosition; onScroll: (position: ScrollPosition) => void;
}
type State = { phase: 'loading'; bytes: number } | { phase: 'confirm'; info: WorkspaceFileInfo }
  | { phase: 'range'; info: WorkspaceFileInfo } | { phase: 'ready'; info: WorkspaceFileInfo; value: ReadText }
  | { phase: 'image'; info: WorkspaceFileInfo; image: ImagePreview }
  | { phase: 'error'; error: string } | { phase: 'cancelled' };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The active document owns its request/model; switching away cancels and releases it. */
export function FileDocument({ projectId, path, searchRequest, position, onScroll, reference, onReferenceHandled }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading', bytes: 0 });
  const [request, setRequest] = useState<{ generation: number; confirmed?: boolean; start?: number; expectedVersion?: string }>({ generation: 0, expectedVersion: reference?.version });
  const cancellation = useRef<AbortController | undefined>(undefined);
  const pageStarts = useRef<number[]>([0]);
  const [navigationNote, setNavigationNote] = useState('');
  const documentState = useRef({ state, request }); documentState.current = { state, request };
  useEffect(() => {
    if (!reference) return;
    const current = documentState.current;
    const loaded = 'info' in current.state ? current.state.info.version : undefined;
    if (loaded === reference.version) return;
    if (current.request.expectedVersion !== reference.version || ['error', 'cancelled'].includes(current.state.phase))
      setRequest(value => ({ generation: value.generation + 1, expectedVersion: reference.version }));
  }, [reference]);
  // Only the original read intent is version-bound; explicit retry authorizes a fresh inspection.
  useEffect(() => {
    if (!reference) return;
    if ('info' in state && state.info.version !== reference.version) return;
    if (state.phase === 'image' || state.phase === 'range' || state.phase === 'ready' && (state.value.partial || reference.line === undefined)) {
      if (reference.line !== undefined && (state.phase !== 'ready' || state.value.partial))
        setNavigationNote(state.phase === 'image' ? t('Images do not support line and column positions.') : t('Section reading does not support whole-file line and column positions; search within the current section.'));
      onReferenceHandled?.(reference.nonce);
    }
  }, [reference, state, onReferenceHandled]);
  useEffect(() => {
    const controller = new AbortController(); cancellation.current = controller;
    setState({ phase: 'loading', bytes: 0 });
    void (async () => {
      const info = await api.inspectWorkspaceFile(projectId, path);
      controller.signal.throwIfAborted();
      if (info.path !== path || !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0 || !info.version) throw new Error(t('Invalid file information. Refresh and try again'));
      if (request.expectedVersion && info.version !== request.expectedVersion) throw new Error(t('The file changed after the link was resolved. Reload it or choose the path again.'));
      if (info.kind === 'image') {
        const response = await api.readWorkspaceImage(projectId, path, info.version);
        controller.signal.throwIfAborted();
        setState({ phase: 'image', info, image: parseWorkspaceImage(response) }); return;
      }
      if (info.kind !== 'text') throw new Error(t('This file is not supported UTF-8 text'));
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
    const fresh = state.phase === 'error' || state.phase === 'cancelled';
    if (fresh && reference) {
      onReferenceHandled?.(reference.nonce);
      if (reference.line !== undefined) setNavigationNote(t('Reloaded the current version; the old link\'s line and column were not applied.'));
    }
    setRequest(value => ({ generation: value.generation + 1, expectedVersion: fresh ? undefined : value.expectedVersion, ...options }));
  };
  const cancel = () => { cancellation.current?.abort(); if (reference) onReferenceHandled?.(reference.nonce); setState({ phase: 'cancelled' }); };
  if (state.phase === 'loading') return <div className="explorer-empty"><p role="status">{t('Reading file…')}{state.bytes > 0 && ` ${size(state.bytes)}`}</p><button onClick={cancel}>{t('Cancel reading')}</button></div>;
  if (state.phase === 'cancelled') return <div className="explorer-empty"><p>{t('Reading cancelled')}</p><button onClick={() => retry()}>{t('Read the file again')}</button></div>;
  if (state.phase === 'error') return <div className="explorer-empty"><p role="alert">{state.error}</p><button onClick={() => retry()}>{t('Read the file again')}</button></div>;
  if (state.phase === 'confirm' || state.phase === 'range') return <div className="explorer-empty">
    {navigationNote && <p role="status" className="explorer-notice">{navigationNote}</p>}
    <strong>{state.phase === 'confirm' ? t('Open large text file') : t('Read large text file in sections')}</strong><p>{size(state.info.sizeBytes)} · {path}</p>
    <p>{state.phase === 'confirm' ? t('Reads it as plain text without syntax highlighting or folding to save memory.') : t('Reads about 1 MiB at a time. Search and copy only cover the current section.')}</p>
    {state.phase === 'confirm' && <button onClick={() => retry({ confirmed: true })}>{t('Open anyway')}</button>}
    <button onClick={() => retry({ start: 0 })}>{t('Read in sections')}</button><button onClick={cancel}>{t('Cancel')}</button>
  </div>;
  if (state.phase === 'image') return <>{navigationNote && <p role="status" className="explorer-notice">{navigationNote}</p>}<FilePreviewBoundary key={`${path}:${state.info.version}`} path={path}>
    <ImageViewer path={path} {...state.image} format={state.image.sourceFormat} sizeBytes={state.info.sizeBytes} />
  </FilePreviewBoundary></>;
  const { value, info } = state;
  return <div className="file-document-content">
    {navigationNote && <p role="status" className="explorer-notice">{navigationNote}</p>}
    {value.longestLine > 10000 && value.lightweight && <p className="explorer-notice" role="status">{t('Very long lines only draw their first 10,000 characters; selecting and copying still keep the full content.')}</p>}
    {value.partial && <div className="file-range-bar" role="group" aria-label={t('File reading section')}>
      <button disabled={pageStarts.current.length <= 1} onClick={() => { pageStarts.current.pop(); retry({ start: pageStarts.current.at(-1) ?? 0 }); }}>{t('Previous section')}</button>
      <span>bytes {value.start.toLocaleString()}–{value.end.toLocaleString()} / {info.sizeBytes.toLocaleString()}</span>
      <button disabled={value.end >= info.sizeBytes} onClick={() => { pageStarts.current.push(value.end); retry({ start: value.end }); }}>{t('Next section')}</button>
    </div>}
    <FilePreviewBoundary key={`${path}:${info.version}:${value.start}`} path={path}>
      <ExplorerEditor path={path} text={value.text} sizeBytes={info.sizeBytes} searchRequest={searchRequest}
        revealRequest={!value.partial && (!reference || info.version === reference.version) ? reference : undefined} onRevealHandled={onReferenceHandled}
        lightweight={value.lightweight} partial={value.partial} lineCount={value.lines}
        position={value.partial ? { top: 0, left: 0 } : position} onScroll={value.partial ? () => {} : onScroll} />
    </FilePreviewBoundary>
  </div>;
}
