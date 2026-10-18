import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FocusModeButton } from './components/FocusModeButton';

it('uses an icon and accessible state in both modes without a duplicate control', () => {
  const click = vi.fn();
  const view = render(<FocusModeButton active={false} onClick={click} />);
  const button = screen.getByRole('button', { name: '進入專注模式' });
  expect(button).toHaveTextContent('');
  expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
  view.rerender(<FocusModeButton active onClick={click} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '退出專注模式' })).toHaveAttribute('aria-pressed', 'true');
});

it('shows hover and keyboard tooltips, dismisses hover Escape before terminal input, and cleans up', () => {
  const view = render(<FocusModeButton active={false} onClick={vi.fn()} />);
  const button = screen.getByRole('button');
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  const inputKey = vi.fn();
  input.addEventListener('keydown', inputKey);
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('tooltip')).toHaveTextContent('進入專注模式');
  expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
  expect(inputKey).not.toHaveBeenCalled();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(input).toHaveFocus();
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  fireEvent.blur(button);
  fireEvent.mouseLeave(button);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focus(button);
  view.unmount();
  expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
  expect(inputKey).toHaveBeenCalledOnce();
  input.remove();
});
