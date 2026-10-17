import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
import type { PaletteOption } from './components/CommandPalette';

const options = (): PaletteOption[] => ['First', 'Disabled', 'Last'].map((label, i) => ({
  id: `${i}`, label, search: label, disabled: i === 1, run: vi.fn(),
}));
const active = () => screen.queryByRole('option', { selected: true });
describe('command palette selection', () => {
  it('wraps enabled rows, keeps input focus and scrolls selected row into view', () => {
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const rows = options();
      render(<CommandPalette options={rows} query="" onQueryChange={vi.fn()} />);
      const input = screen.getByRole('combobox');
      expect(active()).toHaveTextContent('First');
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(active()).toHaveTextContent('Last');
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute('aria-activedescendant', active()?.id);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(active()).toHaveTextContent('First');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(rows[2].run).toHaveBeenCalledOnce();
      expect(rows[1].run).not.toHaveBeenCalled();
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
  it('resolves removed/disabled selections and zero enabled results safely', () => {
    const rows = options();
    const view = render(<CommandPalette options={rows} query="" onQueryChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    view.rerender(<CommandPalette options={rows.slice(0, 2)} query="" onQueryChange={vi.fn()} />);
    expect(active()).toHaveTextContent('First');
    view.rerender(<CommandPalette options={rows} query="Disabled" onQueryChange={vi.fn()} />);
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    view.rerender(<CommandPalette options={rows} query="Absent" onQueryChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('沒有符合');
    fireEvent.keyDown(input, { key: 'Enter' });
    rows.forEach(row => expect(row.run).not.toHaveBeenCalled());
  });
  it('synchronizes hover, ignores disabled hover, and does not take modified arrows', () => {
    const rows = options();
    render(<CommandPalette options={rows} query="" onQueryChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Last' }));
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Disabled' }));
    expect(active()).toHaveTextContent('Last');
    fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
    expect(active()).toHaveTextContent('Last');
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Last' }));
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole('option', { name: 'Last' }));
    expect(rows[2].run).toHaveBeenCalledOnce();
  });
});
