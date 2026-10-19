import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ProjectNavigation } from './components/ProjectNavigation';
import { readSidebarPreferences, saveSidebarPreferences } from './sidebar-preferences';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}
const pointer = (element: HTMLElement, type: string, x: number, pointerId = 7, isPrimary = true, button = 0) =>
  fireEvent(element, new TestPointerEvent(type, { bubbles: true, clientX: x, pointerId, isPrimary, button }));
function capture(element: HTMLElement) {
  const pointers = new Set<number>();
  element.setPointerCapture = vi.fn(id => { pointers.add(id); });
  element.hasPointerCapture = vi.fn(id => pointers.has(id));
  element.releasePointerCapture = vi.fn(id => { pointers.delete(id); });
}
function resize(width: number) {
  act(() => { vi.stubGlobal('innerWidth', width); window.dispatchEvent(new Event('resize')); });
}
function Harness({ hidden = false }: { hidden?: boolean }) {
  const [preferences, setPreferences] = useState(readSidebarPreferences);
  return <ProjectNavigation hidden={hidden} preferredWidth={preferences.width} onWidthChange={width => {
    const next = { ...preferences, width }; saveSidebarPreferences(next); setPreferences(next);
  }}>content</ProjectNavigation>;
}
let layoutWidth: number | null = null;
let notifyLayoutResize: () => void;
beforeEach(() => {
  layoutWidth = null;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layoutWidth ?? window.innerWidth);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyLayoutResize = callback; }
    observe() {}
    disconnect() {}
  });
  localStorage.clear(); vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('PointerEvent', TestPointerEvent); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project navigation resizing', () => {
  it('measures the layout independently of the viewport and hides an immovable handle', () => {
    vi.stubGlobal('innerWidth', 450); layoutWidth = 700;
    render(<Harness />);
    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-valuemax', '180');
    expect(separator).toHaveAttribute('aria-valuenow', '180');
    capture(separator);
    pointer(separator, 'pointerdown', 180); pointer(separator, 'pointermove', 170);
    expect(separator).toHaveAttribute('aria-valuenow', '170');
    act(() => { layoutWidth = 600; notifyLayoutResize(); });
    expect(separator).not.toBeVisible();
    expect(separator.hasPointerCapture(7)).toBe(false);
    pointer(separator, 'pointerup', 170);
    expect(separator).toHaveAttribute('tabindex', '-1');
    expect(readSidebarPreferences().width).toBe(236);
    act(() => { layoutWidth = 960; notifyLayoutResize(); });
    expect(separator).toBeVisible();
    expect(separator).toHaveAttribute('aria-valuemax', '384');
    expect(separator).toHaveAttribute('aria-valuenow', '236');
  });
  it('measures while initially hidden and permits dragging after becoming visible', () => {
    vi.stubGlobal('innerWidth', 450); layoutWidth = 700;
    const { rerender, container } = render(<Harness hidden />);
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator).not.toBeVisible();
    expect(separator).toHaveAttribute('aria-valuemax', '180');
    rerender(<Harness />);
    expect(separator).toBeVisible();
    capture(separator);
    pointer(separator, 'pointerdown', 180); pointer(separator, 'pointermove', 170); pointer(separator, 'pointerup', 170);
    expect(separator).toHaveAttribute('aria-valuenow', '170');
    expect(readSidebarPreferences().width).toBe(170);
  });
  it('does not save a draft when pointerup beats the layout resize notification', () => {
    render(<Harness />);
    const separator = screen.getByRole('separator'); capture(separator);
    const saved = localStorage.getItem('sessionbay.sidebar.v1');
    pointer(separator, 'pointerdown', 236); pointer(separator, 'pointermove', 300);
    layoutWidth = 600; // Layout has changed, but neither resize callback ran yet.
    pointer(separator, 'pointerup', 300);
    expect(localStorage.getItem('sessionbay.sidebar.v1')).toBe(saved);
    act(() => notifyLayoutResize());
    expect(separator).not.toBeVisible();
    act(() => { layoutWidth = 1440; notifyLayoutResize(); });
    expect(separator).toHaveAttribute('aria-valuenow', '236');
  });
  it('does not cancel a draft when the observer reports the same layout width', () => {
    render(<Harness />);
    const separator = screen.getByRole('separator'); capture(separator);
    pointer(separator, 'pointerdown', 236); pointer(separator, 'pointermove', 300);
    act(() => notifyLayoutResize());
    expect(separator.hasPointerCapture(7)).toBe(true);
    expect(separator).toHaveAttribute('aria-valuenow', '300');
    expect(readSidebarPreferences().width).toBe(236);
    pointer(separator, 'pointerup', 300);
    expect(readSidebarPreferences().width).toBe(300);
  });
  it('retains persisted preference after a clamped click, blocked drag, or return to start', () => {
    const { unmount } = render(<Harness />);
    const separator = screen.getByRole('separator'); capture(separator);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(readSidebarPreferences().width).toBe(480);
    resize(720); expect(separator).toHaveAttribute('aria-valuenow', '200');
    const saved = localStorage.getItem('sessionbay.sidebar.v1');
    pointer(separator, 'pointerdown', 200); pointer(separator, 'pointerup', 200);
    pointer(separator, 'pointerdown', 200); pointer(separator, 'pointermove', 400); pointer(separator, 'pointerup', 400);
    pointer(separator, 'pointerdown', 200); pointer(separator, 'pointermove', 180); pointer(separator, 'pointermove', 200); pointer(separator, 'pointerup', 200);
    expect(localStorage.getItem('sessionbay.sidebar.v1')).toBe(saved);
    resize(600); expect(separator).toHaveAttribute('aria-valuemin', '160'); expect(separator).toHaveAttribute('aria-valuemax', '160');
    pointer(separator, 'pointerdown', 160); pointer(separator, 'pointermove', 300); pointer(separator, 'pointerup', 300);
    expect(localStorage.getItem('sessionbay.sidebar.v1')).toBe(saved);
    resize(1440); expect(separator).toHaveAttribute('aria-valuenow', '480');
    unmount(); render(<Harness />); expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '480');
  });
  it('does not overwrite a clamped preference for ineffective keyboard changes', () => {
    render(<Harness />); const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'End' });
    const saved = localStorage.getItem('sessionbay.sidebar.v1');
    resize(720); expect(separator).toHaveAttribute('aria-valuenow', '200');
    for (const key of ['ArrowRight', 'End']) {
      fireEvent.keyDown(separator, { key });
      expect(localStorage.getItem('sessionbay.sidebar.v1')).toBe(saved);
    }
    resize(600); expect(separator).toHaveAttribute('aria-valuenow', '160');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(separator, { key });
      expect(localStorage.getItem('sessionbay.sidebar.v1')).toBe(saved);
    }
    resize(1440); expect(separator).toHaveAttribute('aria-valuenow', '480');
    expect(readSidebarPreferences().width).toBe(480);
  });
  it('commits one effective changed drag only, ignoring other pointers and secondary input', () => {
    const save = vi.fn(); render(<ProjectNavigation hidden={false} preferredWidth={300} onWidthChange={save}>content</ProjectNavigation>);
    const separator = screen.getByRole('separator'); capture(separator);
    pointer(separator, 'pointerdown', 300, 9, false); pointer(separator, 'pointerdown', 300, 9, true, 2);
    expect(separator.setPointerCapture).not.toHaveBeenCalled();
    pointer(separator, 'pointerdown', 300); pointer(separator, 'pointerdown', 300, 8);
    pointer(separator, 'pointermove', 450, 8); pointer(separator, 'pointerup', 450, 8); pointer(separator, 'pointercancel', 450, 8);
    expect(separator).toHaveAttribute('aria-valuenow', '300'); expect(save).not.toHaveBeenCalled();
    expect(separator.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    pointer(separator, 'pointermove', 380); expect(separator).toHaveAttribute('aria-valuenow', '380'); expect(save).not.toHaveBeenCalled();
    pointer(separator, 'pointerup', 380); expect(save).toHaveBeenCalledExactlyOnceWith(380);
    pointer(separator, 'pointerup', 380); pointer(separator, 'pointermove', 400); expect(save).toHaveBeenCalledTimes(1);
    expect(separator.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });
  it('does not save preview, Escape, pointercancel, lost capture, blur, or resize cancellation', () => {
    const save = vi.fn(); render(<ProjectNavigation hidden={false} preferredWidth={300} onWidthChange={save}>content</ProjectNavigation>);
    const separator = screen.getByRole('separator'); capture(separator);
    const drag = () => { pointer(separator, 'pointerdown', 300); pointer(separator, 'pointermove', 380); expect(separator).toHaveAttribute('aria-valuenow', '380'); expect(save).not.toHaveBeenCalled(); };
    const cancellations = [
      () => fireEvent.keyDown(separator, { key: 'Escape' }),
      () => pointer(separator, 'pointercancel', 380),
      () => pointer(separator, 'lostpointercapture', 380),
      () => fireEvent(window, new Event('blur')),
      () => resize(1200),
    ];
    for (const cancel of cancellations) {
      drag(); cancel(); pointer(separator, 'pointerup', 380); pointer(separator, 'pointermove', 420);
      expect(separator).toHaveAttribute('aria-valuenow', '300'); expect(save).not.toHaveBeenCalled();
      expect(separator.hasPointerCapture(7)).toBe(false);
    }
  });
  it('releases capture without saving when hidden or unmounted', () => {
    const save = vi.fn(); const { rerender, unmount } = render(<ProjectNavigation hidden={false} preferredWidth={236} onWidthChange={save}>content</ProjectNavigation>);
    const separator = screen.getByRole('separator'); capture(separator);
    pointer(separator, 'pointerdown', 236); pointer(separator, 'pointermove', 300);
    rerender(<ProjectNavigation hidden preferredWidth={236} onWidthChange={save}>content</ProjectNavigation>);
    expect(save).not.toHaveBeenCalled(); expect(separator.hasPointerCapture(7)).toBe(false);
    rerender(<ProjectNavigation hidden={false} preferredWidth={236} onWidthChange={save}>content</ProjectNavigation>);
    pointer(separator, 'pointerdown', 236); pointer(separator, 'pointermove', 300); unmount();
    expect(save).not.toHaveBeenCalled(); expect(separator.releasePointerCapture).toHaveBeenCalledTimes(2);
  });
  it('keeps keyboard limits and step size', () => {
    render(<Harness />); const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'End' }); expect(separator).toHaveAttribute('aria-valuenow', '480');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' }); expect(separator).toHaveAttribute('aria-valuenow', '464');
    fireEvent.keyDown(separator, { key: 'Home' }); expect(separator).toHaveAttribute('aria-valuenow', '160');
    fireEvent.keyDown(separator, { key: 'ArrowRight' }); expect(separator).toHaveAttribute('aria-valuenow', '176');
  });
});
