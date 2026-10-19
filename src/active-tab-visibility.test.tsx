import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useActiveTabVisibility } from './components/useActiveTabVisibility';

function Fixture({ active, output = '' }: { active?: string; output?: string }) {
  const ref = useActiveTabVisibility(active);
  return <div className="workspace-tabs"><div ref={ref}>{active}{output}</div></div>;
}
it('reveals a changed selection in the strip only, handles zoom, and leaves output/manual scroll alone', () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains('workspace-tabs') ? { left: 100, right: 400, width: 300 } : { left: 440, right: 560, width: 120 }) as DOMRect;
  });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const { container, rerender } = render(<Fixture active="a" />);
  const strip = container.firstElementChild!;
  expect(strip.scrollLeft).toBeCloseTo(160 / 1.5);
  strip.scrollLeft = 12;
  rerender(<Fixture active="a" output="new terminal output" />);
  expect(strip.scrollLeft).toBe(12);
  rerender(<Fixture active="b" />);
  expect(strip.scrollLeft).toBeCloseTo(12 + 160 / 1.5);
  expect(document.documentElement.scrollLeft).toBe(0);
  expect(document.documentElement.scrollTop).toBe(0);
  rect.mockRestore(); offset.mockRestore(); client.mockRestore();
});
it('does not scroll an already visible selection or inactive file group', () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains('workspace-tabs') ? { left: 0, right: 300, width: 300 } : { left: 20, right: 120, width: 100 }) as DOMRect;
  });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  const { container, rerender } = render(<Fixture active="a" />);
  const strip = container.firstElementChild!;
  expect(strip.scrollLeft).toBe(0);
  strip.scrollLeft = 30;
  rerender(<Fixture />);
  expect(strip.scrollLeft).toBe(30);
  rect.mockRestore(); offset.mockRestore(); client.mockRestore();
});

it('reveals selection after the viewport narrows, without reacting to unchanged measurements', () => {
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  let width = 300;
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains('workspace-tabs') ? { left: 0, right: width, width } : { left: 180, right: 260, width: 80 }) as DOMRect;
  });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const { container, unmount } = render(<Fixture active="a" />);
  const strip = container.firstElementChild!;
  resize(); expect(strip.scrollLeft).toBe(0);
  width = 200; resize(); expect(strip.scrollLeft).toBe(60);
  strip.scrollLeft = 10; resize(); expect(strip.scrollLeft).toBe(10);
  unmount(); rect.mockRestore(); offset.mockRestore(); client.mockRestore(); vi.unstubAllGlobals();
});
