import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveControls } from './ResponsiveControls';

afterEach(() => vi.restoreAllMocks());
describe('ResponsiveControls', () => {
  it('keeps controls mounted, discloses them by keyboard, and returns Escape focus', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(413);
    render(<ResponsiveControls label="選項"><button>重新定位</button></ResponsiveControls>);
    const control = screen.getByText('重新定位');
    expect(control).not.toBeVisible();
    const trigger = screen.getByRole('button', {name:'選項'});
    fireEvent.click(trigger);
    expect(control).toBeVisible();
    control.focus();
    fireEvent.keyDown(control, {key:'Escape'});
    expect(trigger).toHaveFocus();
    expect(control).not.toBeVisible();
    expect(screen.getByText('重新定位')).toBe(control);
  });
  it('dismisses pane actions and returns focus to the trigger after activation', () => {
    const action = vi.fn();
    render(<ResponsiveControls label="面板選項" forceCompact closeOnAction><button onClick={action}>還原</button></ResponsiveControls>);
    const trigger = screen.getByRole('button', {name:'面板選項'});
    fireEvent.click(trigger);
    const control = screen.getByRole('button', {name:'還原'});
    control.focus();
    fireEvent.click(control);
    expect(action).toHaveBeenCalledOnce();
    expect(control).not.toBeVisible();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
  it('preserves a destination focused synchronously by the action', () => {
    render(<><input aria-label="Terminal" /><ResponsiveControls label="面板選項" forceCompact closeOnAction>
      <button onClick={() => screen.getByRole('textbox', {name:'Terminal'}).focus()}>最大化</button>
    </ResponsiveControls></>);
    fireEvent.click(screen.getByRole('button', {name:'面板選項'}));
    const action = screen.getByRole('button', {name:'最大化'});
    action.focus(); fireEvent.click(action);
    expect(screen.getByRole('textbox', {name:'Terminal'})).toHaveFocus();
    expect(action).not.toBeVisible();
  });
  it('does not strand focused controls when the viewport becomes compact', () => {
    let height = 940;
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
    render(<ResponsiveControls label="選項"><button>重新定位</button></ResponsiveControls>);
    const control = screen.getByRole('button', {name:'重新定位'});
    control.focus(); height = 310;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(control).toHaveFocus();
    expect(control).toBeVisible();
    expect(screen.getByRole('button', {name:'選項'})).toHaveAttribute('aria-expanded','true');
    fireEvent.keyDown(control, {key:'Escape'});
    expect(screen.getByRole('button', {name:'選項'})).toHaveFocus();
  });
});
