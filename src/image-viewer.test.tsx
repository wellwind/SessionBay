import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageViewer, type ImageViewerProps } from './components/ImageViewer';

let viewportWidth = 432, viewportHeight = 332;
let resize: (() => void) | undefined;
const disconnect = vi.fn();
const createURL = vi.fn<(blob: Blob) => string>();
const revokeURL = vi.fn<(url: string) => void>();
const capture = vi.fn();
const release = vi.fn();
const fixture = (changes: Partial<ImageViewerProps> = {}): ImageViewerProps => ({
  path: 'synthetic.png', blob: new Blob(['synthetic image'], { type: 'image/png' }),
  width: 800, height: 600, sizeBytes: 2048, format: 'png', firstFrameOnly: false, ...changes,
});
beforeEach(() => {
  viewportWidth = 432; viewportHeight = 332;
  resize = undefined; vi.clearAllMocks();
  createURL.mockImplementation(() => `blob:synthetic-${createURL.mock.calls.length}`);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createURL; static revokeObjectURL = revokeURL; });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number; isPrimary: boolean;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options); this.pointerId = options.pointerId ?? 1; this.isPrimary = options.isPrimary ?? true;
    }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('image-viewer-viewport') ? viewportWidth : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('image-viewer-viewport') ? viewportHeight : 0; });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: capture },
    hasPointerCapture: { configurable: true, value: () => true },
    releasePointerCapture: { configurable: true, value: release },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
const ratio = () => screen.getByLabelText('圖片縮放比例');
const viewport = () => screen.getByRole('region', { name: /圖片預覽/ });
function load() { const image = screen.getByRole('img', { hidden: true }); fireEvent.load(image); return image; }

describe('readonly image viewer', () => {
  it('renders only an image with dimensions, size and first-frame notice', () => {
    const props = fixture({ path: 'safe.svg', format: 'svg', firstFrameOnly: true });
    const view = render(<ImageViewer {...props} />);
    const image = load();
    expect(image).toHaveAttribute('src', 'blob:synthetic-1');
    expect(image).toHaveAttribute('alt', 'safe.svg');
    expect(image).toHaveAttribute('draggable', 'false');
    expect(screen.getByText('800 × 600 px · SVG')).toBeVisible();
    expect(screen.getByText('2.0 KiB')).toHaveAttribute('title', '2,048 bytes');
    expect(screen.getByText('僅顯示第一幀')).toBeVisible();
    expect(view.container.querySelector('object, iframe, embed, .image-viewer-viewport svg')).toBeNull();
    expect(fireEvent.dragStart(image)).toBe(false);
  });
  it('owns exactly one object URL per blob and resets zoom on replacement', () => {
    const props = fixture();
    const view = render(<ImageViewer {...props} />);
    load(); fireEvent.click(screen.getByRole('button', { name: '原始大小 1:1' }));
    expect(ratio()).toHaveTextContent('100%');
    view.rerender(<ImageViewer {...props} path="renamed.png" />);
    expect(createURL).toHaveBeenCalledOnce(); expect(revokeURL).not.toHaveBeenCalled();
    view.rerender(<ImageViewer {...props} blob={new Blob(['replacement'])} />);
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-1');
    expect(createURL).toHaveBeenCalledTimes(2);
    expect(ratio()).toHaveTextContent('50%');
    expect(screen.getByRole('button', { name: '符合視窗' })).toHaveAttribute('aria-pressed', 'true');
    view.unmount();
    expect(revokeURL.mock.calls).toEqual([['blob:synthetic-1'], ['blob:synthetic-2']]);
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it('fits on viewport resize, allows tiny fit scales and keeps manual 1:1 stable', () => {
    render(<ImageViewer {...fixture()} />);
    const image = load();
    expect(ratio()).toHaveTextContent('50%');
    expect(image).toHaveStyle({ width: '400px', height: '300px' });
    act(() => { viewportWidth = 232; viewportHeight = 182; resize?.(); });
    expect(ratio()).toHaveTextContent('25%');
    fireEvent.click(screen.getByRole('button', { name: '原始大小 1:1' }));
    act(() => { viewportWidth = 72; viewportHeight = 62; resize?.(); });
    expect(ratio()).toHaveTextContent('100%');
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    fireEvent.click(screen.getByRole('button', { name: '符合視窗' }));
    expect(ratio()).toHaveTextContent('5%');
    expect(image).toHaveStyle({ width: '40px', height: '30px' });
    expect(screen.getByRole('button', { name: '縮小圖片' })).toBeDisabled();
    fireEvent.keyDown(viewport(), { key: '-' }); expect(ratio()).toHaveTextContent('5%');
  });
  it('bounds explicit zoom to 10–800% and resets fit scroll position', () => {
    render(<ImageViewer {...fixture()} />); load();
    const plus = screen.getByRole('button', { name: '放大圖片' });
    const minus = screen.getByRole('button', { name: '縮小圖片' });
    for (let index = 0; index < 30; index++) fireEvent.click(plus);
    expect(ratio()).toHaveTextContent('800%'); expect(plus).toBeDisabled();
    for (let index = 0; index < 30; index++) fireEvent.click(minus);
    expect(ratio()).toHaveTextContent('10%'); expect(minus).toBeDisabled();
    viewport().scrollLeft = 120; viewport().scrollTop = 80;
    fireEvent.click(screen.getByRole('button', { name: '符合視窗' }));
    expect(ratio()).toHaveTextContent('50%');
    expect(viewport().scrollLeft).toBe(0); expect(viewport().scrollTop).toBe(0);
  });
  it('handles unmodified viewer keys without intercepting global or composing shortcuts', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><ImageViewer {...fixture()} /><input aria-label="outside" /></div>); load();
    const host = viewport(); host.focus();
    expect(fireEvent.keyDown(host, { key: '+', shiftKey: true })).toBe(false);
    expect(ratio()).toHaveTextContent('62.5%'); expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(host, { key: '1' }); expect(ratio()).toHaveTextContent('100%');
    fireEvent.keyDown(host, { key: '0' }); expect(ratio()).toHaveTextContent('50%');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])
      expect(fireEvent.keyDown(host, { key: '=', ...options })).toBe(true);
    expect(fireEvent.keyDown(host, { key: '0', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: '放大圖片' }), { key: '+' })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'outside' }), { key: '+' })).toBe(true);
    expect(ratio()).toHaveTextContent('50%');
  });
  it('pans with primary pointer capture without starting ancestor tab gestures', () => {
    const outer = vi.fn();
    render(<div onPointerDown={outer}><ImageViewer {...fixture()} /></div>); load();
    fireEvent.click(screen.getByRole('button', { name: '原始大小 1:1' }));
    const host = viewport(); host.scrollLeft = 100; host.scrollTop = 80;
    fireEvent.pointerDown(host, { pointerId: 4, button: 0, clientX: 100, clientY: 100 });
    expect(host).toHaveFocus(); expect(capture).toHaveBeenCalledWith(4); expect(outer).not.toHaveBeenCalled();
    fireEvent.pointerMove(host, { pointerId: 5, clientX: 90, clientY: 70 });
    expect(host.scrollLeft).toBe(100);
    fireEvent.pointerMove(host, { pointerId: 4, clientX: 70, clientY: 60 });
    expect(host.scrollLeft).toBe(130); expect(host.scrollTop).toBe(120);
    fireEvent.pointerCancel(host, { pointerId: 4 });
    expect(release).toHaveBeenCalledWith(4); expect(host).not.toHaveAttribute('data-panning');
    fireEvent.pointerMove(host, { pointerId: 4, clientX: 10, clientY: 10 });
    expect(host.scrollLeft).toBe(130);
  });
  it('contains image decode errors, releases the URL, and recovers for a new blob', () => {
    const props = fixture(); const view = render(<ImageViewer {...props} />);
    fireEvent.error(screen.getByRole('img', { hidden: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('無法顯示圖片');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-1');
    expect(screen.getByRole('button', { name: '放大圖片' })).toBeDisabled();
    view.rerender(<ImageViewer {...props} blob={new Blob(['valid replacement'])} />);
    load(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.unmount(); expect(revokeURL).toHaveBeenCalledTimes(2);
  });
  it('contains object URL creation failures without crashing siblings', () => {
    createURL.mockImplementationOnce(() => { throw new Error('Blob URLs unavailable'); });
    render(<><button>other tab</button><ImageViewer {...fixture()} /></>);
    expect(screen.getByRole('alert')).toBeVisible(); expect(screen.getByRole('button', { name: 'other tab' })).toBeEnabled();
    expect(revokeURL).not.toHaveBeenCalled();
  });
  it('releases every StrictMode resource exactly once', () => {
    const view = render(<StrictMode><ImageViewer {...fixture()} /></StrictMode>);
    load();
    expect(createURL).toHaveBeenCalledTimes(2);
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-1');
    view.unmount();
    expect(revokeURL.mock.calls).toEqual([['blob:synthetic-1'], ['blob:synthetic-2']]);
  });
  it('ignores load and error events from a replaced image', () => {
    const props = fixture(); const view = render(<ImageViewer {...props} />);
    const previous = screen.getByRole('img', { hidden: true });
    view.rerender(<ImageViewer {...props} blob={new Blob(['new image'])} />);
    fireEvent.error(previous); fireEvent.load(previous);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '放大圖片' })).toBeDisabled();
    expect(load()).toHaveAttribute('src', 'blob:synthetic-2');
    expect(screen.getByRole('button', { name: '放大圖片' })).toBeEnabled();
  });
  it('rejects invalid dimensions before creating an image resource', () => {
    render(<ImageViewer {...fixture({ width: Infinity })} />);
    expect(screen.getByRole('alert')).toBeVisible(); expect(createURL).not.toHaveBeenCalled();
  });
});
