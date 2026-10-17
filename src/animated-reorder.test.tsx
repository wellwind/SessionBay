import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAnimatedReorder } from './components/useAnimatedReorder';
const rect = (left: number, width: number, top = 0, height = 40) => ({ left, right: left + width, top, bottom: top + height, width, height } as DOMRect);
function Harness({ changed, ids = ['a', 'b', 'c'], groups = ['', '', ''], axis = 'x' }: { axis?: 'x' | 'y'; changed: (id: string, target: string, after: boolean) => void; ids?: string[]; groups?: string[] }) {
  const reorder = useAnimatedReorder(ids.map((id, i) => ({ id, group: groups[i] })), axis, '.strip', changed);
  return <div className="strip" data-testid="strip">{ids.map(id => <div key={id} data-testid={id} ref={el => reorder.ref(id, el)} style={reorder.style(id)} className={reorder.className(id)}><button {...reorder.handlers(id)}>{id}</button></div>)}</div>;
}
function setup(groups?: string[], axis: 'x' | 'y' = 'x') {
  const changed = vi.fn(); const view = render(<Harness changed={changed} groups={groups} axis={axis} />);
  const strip = screen.getByTestId('strip'); vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(axis === 'x' ? rect(0, 500) : rect(0, 40, 0, 500));
  [[0, 100], [104, 160], [268, 80]].forEach(([left, width], i) => vi.spyOn(screen.getByTestId(['a', 'b', 'c'][i]), 'getBoundingClientRect').mockReturnValue(axis === 'x' ? rect(left, width) : rect(0, 40, left, width)));
  const source = screen.getByRole('button', { name: 'a' }); source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
  const pointer = (type: string, x: number, pointerId = 1) => {
    const event = new Event(type, { bubbles: true }); Object.assign(event, { clientX: axis === 'x' ? x : 10, clientY: axis === 'y' ? x : 10, pointerId, button: 0, isPrimary: true }); fireEvent(source, event);
  };
  return { changed, view, strip, pointer };
}
describe('animated reorder geometry', () => {
  it('moves unequal-width siblings into the preview slots without changing DOM order or saving', () => {
    const { pointer, changed } = setup();
    const a = screen.getByTestId('a');
    pointer('pointerdown', 10); pointer('pointermove', 330);
    expect(a).toHaveStyle({ transform: 'translateX(320px)' });
    expect(screen.getByTestId('b')).toHaveStyle({ transform: 'translateX(-104px)' });
    expect(screen.getByTestId('c')).toHaveStyle({ transform: 'translateX(-104px)' });
    expect(screen.getAllByRole('button').map(el => el.textContent)).toEqual(['a', 'b', 'c']);
    expect(changed).not.toHaveBeenCalled();
    pointer('pointermove', 10);
    expect(screen.getByTestId('b')).toHaveStyle({ transform: 'translateX(0px)' });
    pointer('pointerup', 10); expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('a')).toBe(a);
  });
  it('rejects other groups, secondary pointer release, and covered controls', () => {
    const { pointer, changed, strip } = setup(['one', 'two', 'one']);
    pointer('pointerdown', 10); pointer('pointermove', 200); pointer('pointerup', 200);
    expect(changed).not.toHaveBeenCalled();
    pointer('pointerdown', 10); pointer('pointermove', 330); pointer('pointerup', 330, 2);
    expect(changed).not.toHaveBeenCalled();
    const control = document.createElement('button'); strip.append(control);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => control });
    try {
      pointer('pointerup', 330); expect(changed).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(document, 'elementFromPoint'); }
  });
  it('compensates scrolling and cancels when the list changes', () => {
    const { pointer, changed, strip, view } = setup();
    strip.style.overflow = 'auto';
    pointer('pointerdown', 10);
    strip.scrollLeft = 80;
    pointer('pointermove', 250);
    expect(screen.getByTestId('a')).toHaveStyle({ transform: 'translateX(320px)' });
    pointer('pointerup', 250);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
    changed.mockClear(); strip.scrollLeft = 0;
    pointer('pointerdown', 10); pointer('pointermove', 330);
    view.rerender(<Harness changed={changed} ids={['a', 'b']} />);
    pointer('pointerup', 330); expect(changed).not.toHaveBeenCalled();
  });
});

it('measures expanded groups but only accepts their parent headers as targets', () => {
  const changed = vi.fn();
  function Expanded() {
    const reorder = useAnimatedReorder([{ id: 'a' }, { id: 'b' }], 'y', '.strip', changed);
    return <div className="strip" data-testid="strip">{['a', 'b'].map(id => <div key={id} ref={el => reorder.ref(id, el)} data-testid={id} style={reorder.style(id)}>
      <div ref={el => reorder.targetRef(id, el)} data-testid={`header-${id}`}><button {...reorder.handlers(id)}>{id}</button></div>
      <div>Expanded child tabs</div>
    </div>)}</div>;
  }
  render(<Expanded />);
  vi.spyOn(screen.getByTestId('strip'), 'getBoundingClientRect').mockReturnValue(rect(0, 200, 0, 300));
  ['a', 'b'].forEach((id, i) => {
    vi.spyOn(screen.getByTestId(id), 'getBoundingClientRect').mockReturnValue(rect(0, 200, i * 150, 146));
    vi.spyOn(screen.getByTestId(`header-${id}`), 'getBoundingClientRect').mockReturnValue(rect(0, 200, i * 150, 40));
  });
  const source = screen.getByRole('button', { name: 'a' }); source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
  const pointer = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true }); Object.assign(event, { clientX: 10, clientY: y, pointerId: 1, button: 0, isPrimary: true }); fireEvent(source, event);
  };
  pointer('pointerdown', 10); pointer('pointermove', 240); pointer('pointerup', 240);
  expect(changed).not.toHaveBeenCalled();
  pointer('pointerdown', 10); pointer('pointermove', 180);
  expect(screen.getByTestId('b')).toHaveStyle({ transform: 'translateY(-150px)' });
  pointer('pointerup', 180);
  expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'b', true);
});

it('review: pointer-follow preview does not disappear in a normal inter-item gap', () => {
  const { pointer, changed } = setup();
  const a = screen.getByTestId('a');
  pointer('pointerdown', 10); pointer('pointermove', 200);
  expect(a).toHaveClass('reorder-dragging');
  pointer('pointermove', 266); // ordinary 4px gap between b.right=264 and c.left=268
  expect(a).toHaveClass('reorder-dragging');
  expect(a).toHaveStyle({ transform: 'translateX(256px)' });
  expect(changed).not.toHaveBeenCalled();
});

it('review: scrolling while a pointer is held keeps the dragged tab under that pointer', () => {
  const { pointer, changed, strip } = setup();
  strip.style.overflow = 'auto';
  pointer('pointerdown', 10); pointer('pointermove', 200);
  expect(screen.getByTestId('a')).toHaveStyle({ transform: 'translateX(190px)' });
  strip.scrollLeft = 80;
  fireEvent.scroll(strip);
  // Scrolling the strip moves its child -80px. The direct drag transform must
  // compensate even when the pointer stays at clientX=200 during a wheel scroll.
  expect(screen.getByTestId('a')).toHaveStyle({ transform: 'translateX(270px)' });
  expect(changed).not.toHaveBeenCalled();
});

it('review: a dragged preview cannot turn an underlying sticky control into a drop target', () => {
  const { pointer, changed, strip } = setup();
  const source = screen.getByRole('button', { name: 'a' });
  const covered = screen.getByRole('button', { name: 'c' });
  const exit = document.createElement('button'); exit.textContent = 'Exit focus';
  exit.style.position = 'sticky'; exit.style.zIndex = '2'; strip.append(exit);
  // The new source ghost is z-index 5. It paints above the existing sticky Exit (2).
  // A real hit test thus sees the dragged source before the control and covered tab.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => source });
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [source, source.parentElement, exit, covered, covered.parentElement, strip] });
  try {
    pointer('pointerdown', 10); pointer('pointermove', 330); pointer('pointerup', 330);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, 'elementFromPoint');
    Reflect.deleteProperty(document, 'elementsFromPoint');
  }
});


describe.each(['x', 'y'] as const)('continuous %s-axis drag', axis => {
  it('keeps following through gaps and outside, but never commits an invalid release', () => {
    const { pointer, changed } = setup(undefined, axis);
    pointer('pointerdown', 10); pointer('pointermove', 200); pointer('pointermove', 266);
    expect(screen.getByTestId('a')).toHaveStyle({ transform: `translate${axis.toUpperCase()}(256px)` });
    pointer('pointerup', 266);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByTestId('a')).not.toHaveClass('reorder-dragging');
    pointer('pointerdown', 10); pointer('pointermove', 600);
    expect(screen.getByTestId('a')).toHaveStyle({ transform: `translate${axis.toUpperCase()}(590px)` });
    pointer('pointerup', 600); expect(changed).not.toHaveBeenCalled();
  });
  it('updates stationary-pointer scrolling and releases against the same compensated geometry', () => {
    const { pointer, changed, strip } = setup(undefined, axis);
    strip.style.overflow = 'auto';
    const remove = vi.spyOn(strip, 'removeEventListener');
    pointer('pointerdown', 10); pointer('pointermove', 200);
    strip[axis === 'x' ? 'scrollLeft' : 'scrollTop'] = 80;
    fireEvent.scroll(strip);
    expect(screen.getByTestId('a')).toHaveStyle({ transform: `translate${axis.toUpperCase()}(270px)` });
    expect(screen.getByTestId('b')).toHaveStyle({ transform: `translate${axis.toUpperCase()}(-104px)` });
    expect(changed).not.toHaveBeenCalled();
    pointer('pointerup', 200);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'c', false);
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    fireEvent.scroll(strip);
    expect(screen.getByTestId('a')).not.toHaveClass('reorder-dragging');
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('cleans active scroll listeners on Escape and unmount without saving', () => {
    const { pointer, changed, strip, view } = setup(undefined, axis);
    strip.style.overflow = 'auto';
    const add = vi.spyOn(strip, 'addEventListener');
    const remove = vi.spyOn(strip, 'removeEventListener');
    pointer('pointerdown', 10); pointer('pointermove', 200);
    const firstListener = add.mock.calls.find(call => call[0] === 'scroll')![1];
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(remove).toHaveBeenCalledWith('scroll', firstListener);
    strip[axis === 'x' ? 'scrollLeft' : 'scrollTop'] = 80; fireEvent.scroll(strip);
    expect(screen.getByTestId('a')).not.toHaveClass('reorder-dragging');
    pointer('pointerup', 200); expect(changed).not.toHaveBeenCalled();
    pointer('pointerdown', 10); pointer('pointermove', 200);
    const lastListener = add.mock.calls.filter(call => call[0] === 'scroll').at(-1)![1];
    view.unmount();
    expect(remove).toHaveBeenCalledWith('scroll', lastListener);
    fireEvent.scroll(strip); expect(changed).not.toHaveBeenCalled();
  });
});


it('still accepts an unobstructed header beneath the lifted source', () => {
  const { pointer, changed, strip } = setup();
  const source = screen.getByRole('button', { name: 'a' });
  const target = screen.getByRole('button', { name: 'c' });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => source });
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [source, source.parentElement, target, target.parentElement, strip] });
  try {
    pointer('pointerdown', 10); pointer('pointermove', 330);
    expect(changed).not.toHaveBeenCalled();
    pointer('pointerup', 330);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
  } finally {
    Reflect.deleteProperty(document, 'elementFromPoint');
    Reflect.deleteProperty(document, 'elementsFromPoint');
  }
});


it('allows the empty preview slot below the lifted source without accepting controls', () => {
  const { pointer, changed, strip } = setup();
  const source = screen.getByRole('button', { name: 'a' });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => source });
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [source, source.parentElement, strip] });
  try {
    pointer('pointerdown', 10); pointer('pointermove', 330); pointer('pointerup', 330);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
  } finally {
    Reflect.deleteProperty(document, 'elementFromPoint');
    Reflect.deleteProperty(document, 'elementsFromPoint');
  }
});
