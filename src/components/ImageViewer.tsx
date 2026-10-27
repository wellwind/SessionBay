import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import './image-viewer.css';
import { t } from '../i18n';

export interface ImageViewerProps {
  path: string; blob: Blob; width: number; height: number; sizeBytes: number;
  format: string; firstFrameOnly: boolean;
}
interface ImageResource { blob: Blob; url?: string; loaded: boolean; failed: boolean; release: () => void }
interface Pan { pointerId: number; x: number; y: number; left: number; top: number }
const MIN_ZOOM = 0.1, MAX_ZOOM = 8, GUTTER = 32;
const clampZoom = (scale: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
const readableSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} bytes`;

/** A validated image is always rendered in image context, never as a document. */
export function ImageViewer({ path, blob, width, height, sizeBytes, format, firstFrameOnly }: ImageViewerProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const latestBlob = useRef(blob); latestBlob.current = blob;
  const pan = useRef<Pan | undefined>(undefined);
  const anchor = useRef<{ x: number; y: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [resource, setResource] = useState<ImageResource>();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState({ fit: true, scale: 1 });
  const validDimensions = Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
  const current = resource?.blob === blob ? resource : undefined;
  const failed = !validDimensions || current?.failed;
  const fitScale = validDimensions && bounds.width > GUTTER && bounds.height > GUTTER
    ? Math.min(1, (bounds.width - GUTTER) / width, (bounds.height - GUTTER) / height) : 1;
  // Fit may be below 10% so a large image still fits a narrow viewport. Only
  // explicit zoom controls use the 10–800% bounds; fit never enlarges a small image.
  const scale = zoom.fit ? fitScale : zoom.scale;
  const imageWidth = validDimensions ? width * scale : 0;
  const imageHeight = validDimensions ? height * scale : 0;
  const stageWidth = Math.max(bounds.width, imageWidth + GUTTER);
  const stageHeight = Math.max(bounds.height, imageHeight + GUTTER);

  useEffect(() => {
    let released = false;
    let url: string | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (url) {
        if (image.current?.getAttribute('src') === url) image.current.removeAttribute('src');
        URL.revokeObjectURL(url);
      }
    };
    try {
      if (!validDimensions) throw new Error('Invalid image dimensions');
      url = URL.createObjectURL(blob);
      setResource({ blob, url, loaded: false, failed: false, release });
    } catch {
      release(); setResource({ blob, loaded: false, failed: true, release });
    }
    return release;
  }, [blob, validDimensions]);
  useEffect(() => {
    pan.current = undefined; anchor.current = undefined;
    setDragging(false); setZoom({ fit: true, scale: 1 });
  }, [blob, width, height]);
  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host) return;
    const measure = () => setBounds(previous => previous.width === host.clientWidth && previous.height === host.clientHeight
      ? previous : { width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host) return;
    if (zoom.fit) { host.scrollLeft = 0; host.scrollTop = 0; }
    else if (anchor.current) {
      host.scrollLeft = Math.max(0, Math.min(stageWidth - bounds.width, (stageWidth - imageWidth) / 2 + anchor.current.x * scale - bounds.width / 2));
      host.scrollTop = Math.max(0, Math.min(stageHeight - bounds.height, (stageHeight - imageHeight) / 2 + anchor.current.y * scale - bounds.height / 2));
    }
    anchor.current = undefined;
  }, [zoom, scale, bounds, stageWidth, stageHeight, imageWidth, imageHeight]);

  const setManualZoom = (next: number, center = false) => {
    const host = viewport.current;
    anchor.current = center || !host ? { x: width / 2, y: height / 2 } : {
      x: (host.scrollLeft + bounds.width / 2 - (stageWidth - imageWidth) / 2) / scale,
      y: (host.scrollTop + bounds.height / 2 - (stageHeight - imageHeight) / 2) / scale,
    };
    setZoom({ fit: false, scale: clampZoom(next) });
  };
  const fit = () => { anchor.current = undefined; setZoom({ fit: true, scale: 1 }); };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.defaultPrevented || failed || !current?.loaded
      || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229
      || (event.shiftKey && event.key !== '+')) return;
    if (!['+', '=', '-', '0', '1'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === '0') fit();
    else if (event.key === '1') setManualZoom(1, true);
    else if (event.key !== '-' || scale > MIN_ZOOM) setManualZoom(event.key === '-' ? scale / 1.25 : scale * 1.25);
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId !== event.pointerId) return;
    pan.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const unavailable = failed || !current?.loaded;
  const percentage = `${Number((scale * 100).toFixed(1))}%`;
  return <div className="image-viewer" aria-label={t('Image: {{path}}', { path })}>
    <div className="image-viewer-toolbar" role="toolbar" aria-label={t('Image viewer tools')}>
      <span className="image-viewer-path" title={path}>{path}</span>
      <button type="button" aria-label={t('Zoom out')} title={t('Zoom out (-)')} disabled={unavailable || scale <= MIN_ZOOM} onClick={() => setManualZoom(scale / 1.25)}><Minus size={15} /></button>
      <output className="image-viewer-zoom" aria-label={t('Image zoom')}>{percentage}</output>
      <button type="button" aria-label={t('Zoom in')} title={t('Zoom in (+)')} disabled={unavailable || scale >= MAX_ZOOM} onClick={() => setManualZoom(scale * 1.25)}><Plus size={15} /></button>
      <button type="button" aria-label={t('Fit to window')} title={t('Fit to window (0)')} aria-pressed={zoom.fit} disabled={unavailable} onClick={fit}><Maximize size={15} /></button>
      <button type="button" aria-label={t('Actual size 1:1')} title={t('Actual size (1 image pixel = 1 CSS pixel)')} aria-pressed={!zoom.fit && scale === 1} disabled={unavailable} onClick={() => setManualZoom(1, true)}>1:1</button>
    </div>
    <div ref={viewport} className="image-viewer-viewport" role="region" aria-label={t('Image preview: {{path}}', { path })} tabIndex={0}
      data-panning={dragging || undefined} onKeyDown={keys} onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (unavailable || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const host = event.currentTarget, box = host.getBoundingClientRect();
        // Leave native scrollbar gestures alone.
        if (event.clientX >= box.left + host.clientWidth || event.clientY >= box.top + host.clientHeight) return;
        event.preventDefault(); event.stopPropagation(); host.focus({ preventScroll: true });
        pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: host.scrollLeft, top: host.scrollTop };
        host.setPointerCapture(event.pointerId); setDragging(true);
      }} onPointerMove={event => {
        const start = pan.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
        event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
      }} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
      {failed ? <p className="image-viewer-message" role="alert">{t('Cannot display the image.')}</p> : <>
        {!current?.loaded && <p className="image-viewer-message" role="status">{t('Loading image…')}</p>}
        {current?.url && <div className="image-viewer-stage" style={{ width: stageWidth, height: stageHeight }}>
          <img ref={image} src={current.url} alt={path} width={width} height={height} draggable={false} decoding="async"
            style={{ width: imageWidth, height: imageHeight, visibility: current.loaded ? 'visible' : 'hidden' }}
            onLoad={() => {
              if (latestBlob.current === blob) setResource(value => value && value.url === current.url && !value.failed ? { ...value, loaded: true } : value);
            }} onError={() => {
              current.release();
              if (latestBlob.current === blob) setResource(value => value && value.url === current.url ? { ...value, failed: true, loaded: false } : value);
            }} />
        </div>}
      </>}
    </div>
    <div className="image-viewer-status"><span>{width.toLocaleString()} × {height.toLocaleString()} px · {format.toUpperCase()}</span>
      <span title={`${sizeBytes.toLocaleString()} bytes`}>{readableSize(sizeBytes)}</span>
      {firstFrameOnly && <span>{t('Showing the first frame only')}</span>}
    </div>
  </div>;
}
