import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ResponsiveControls } from './components/ResponsiveControls';

beforeEach(() => {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(413);
});

function controls() {
  return render(<>
    <ResponsiveControls label="Pane options"><button>Rename pane</button></ResponsiveControls>
    <button>Outside</button>
  </>);
}

function expand() {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(850);
  window.dispatchEvent(new Event('resize'));
}

it('hands off focus acquired after resize measurement but before the trigger is removed', () => {
  controls();
  const trigger = screen.getByRole('button', { name: 'Pane options' });
  act(() => {
    expand();
    trigger.focus();
    expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole('button', { name: 'Pane options' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Rename pane' })).toHaveFocus();
});

it('does not steal focus moved outside after resize measurement', () => {
  controls();
  const trigger = screen.getByRole('button', { name: 'Pane options' });
  const outside = screen.getByRole('button', { name: 'Outside' });
  trigger.focus();
  act(() => {
    expand();
    outside.focus();
  });
  expect(outside).toHaveFocus();
});

it('keeps a focused expanded action reachable when controls collapse', () => {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(850);
  controls();
  const action = screen.getByRole('button', { name: 'Rename pane' });
  action.focus();
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(413);
  fireEvent.resize(window);
  expect(screen.getByRole('button', { name: 'Pane options' })).toHaveAttribute('aria-expanded', 'true');
  expect(action).toBeVisible();
  expect(action).toHaveFocus();
});
