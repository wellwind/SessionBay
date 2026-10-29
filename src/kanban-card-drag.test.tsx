import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanCardDrag, type CardDrop } from './components/useKanbanCardDrag';

function Harness({ onMove, signature = 'initial' }: { onMove: (id: string, drop: CardDrop) => void; signature?: string }) {
  const root = useRef<HTMLElement>(null);
  const drag = useKanbanCardDrag(root, signature, onMove);
  return <section ref={root} data-testid="root" style={{ overflow: 'hidden' }}>
    <div data-testid="columns" style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div data-kanban-column="a"><div data-testid="list" style={{ overflowY: 'auto' }}>
        <div data-kanban-card="source" {...drag.handlers('source')}>Source</div><p data-testid="hint">Empty hint</p>
      </div></div>
      <div data-kanban-column="b" data-testid="destination">Destination</div>
    </div>
    <output>{drag.preview?.columnId}</output>
  </section>;
}
const pointer = (type: string, x = 295, y = 295) => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true });
  fireEvent(screen.getByText('Source'), event);
};
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const frame = (time = 16) => act(() => {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
});
function geometry(element: HTMLElement, width = 300, height = 300) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: width, bottom: height, width, height } as DOMRect);
  Object.defineProperties(element, { clientWidth: { configurable: true, value: width }, clientHeight: { configurable: true, value: height } });
}
function setup() {
  const onMove = vi.fn(), view = render(<Harness onMove={onMove} />);
  const columns = screen.getByTestId('columns'), list = screen.getByTestId('list');
  for (const id of ['root', 'columns', 'list', 'hint', 'destination']) geometry(screen.getByTestId(id));
  Object.defineProperty(columns, 'scrollWidth', { configurable: true, value: 900 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 900 });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => screen.getByTestId('hint') });
  return { onMove, view, columns, list };
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
});
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(document, 'elementFromPoint'); });

describe('kanban edge auto-scroll', () => {
  it('scrolls horizontal columns and the vertical list at once and recalculates the drop without another pointer move', () => {
    const { columns, list, onMove } = setup();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () =>
      screen.getByTestId(columns.scrollLeft > 0 ? 'destination' : 'hint') });
    pointer('pointerdown', 150, 150); pointer('pointermove');
    expect(screen.getByRole('status')).toHaveTextContent('a');
    frame();
    expect(columns.scrollLeft).toBeGreaterThan(0); expect(list.scrollTop).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('b');
    pointer('pointerup');
    expect(onMove).toHaveBeenCalledExactlyOnceWith('source', expect.objectContaining({ columnId: 'b', targetId: undefined }));
    expect(frames.size).toBe(0);
  });
  it('scales speed with edge proximity, reverses at the opposite edge, and stays idle in the center', () => {
    const { columns, list } = setup();
    pointer('pointerdown', 150, 150); pointer('pointermove', 150, 150); frame();
    expect(columns.scrollLeft).toBe(0); expect(list.scrollTop).toBe(0);
    pointer('pointermove', 270, 270); frame(32);
    const slow = columns.scrollLeft;
    expect(slow).toBeGreaterThan(0);
    columns.scrollLeft = 0; list.scrollTop = 0;
    pointer('pointermove'); frame(48);
    expect(columns.scrollLeft).toBeGreaterThan(slow); expect(list.scrollTop).toBeGreaterThan(slow);
    columns.scrollLeft = 100; list.scrollTop = 100;
    pointer('pointermove', 5, 5); frame(64);
    expect(columns.scrollLeft).toBeLessThan(100); expect(list.scrollTop).toBeLessThan(100);
    pointer('pointerup', 5, 5);
  });
  it('scrolls the activity group list without scrolling a non-scrollable horizontal parent', () => {
    const { columns, list } = setup();
    Object.defineProperty(columns, 'scrollWidth', { configurable: true, value: 300 });
    pointer('pointerdown', 150, 150); pointer('pointermove', 150, 295); frame();
    expect(columns.scrollLeft).toBe(0); expect(list.scrollTop).toBeGreaterThan(0);
    pointer('pointerup', 150, 295);
  });
  it.each(['escape', 'pointercancel', 'lostpointercapture', 'blur', 'resize', 'signature', 'unmount'])('stops the animation loop on %s without saving', reason => {
    const { view, onMove } = setup();
    pointer('pointerdown', 150, 150); pointer('pointermove'); frame();
    expect(frames.size).toBe(1);
    if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'blur') fireEvent.blur(window);
    else if (reason === 'resize') fireEvent.resize(window);
    else if (reason === 'signature') view.rerender(<Harness onMove={onMove} signature="changed" />);
    else if (reason === 'unmount') view.unmount();
    else pointer(reason);
    expect(frames.size).toBe(0); expect(onMove).not.toHaveBeenCalled();
  });
});
