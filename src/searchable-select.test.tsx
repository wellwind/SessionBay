import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from './components/controls';

function Harness({ onChange = vi.fn(), onEscape = vi.fn(), disabled = false }) {
  const [value, setValue] = useState('tool-0');
  const [query, setQuery] = useState('');
  return <div onKeyDown={(event) => { if (event.key === 'Escape') onEscape(); }}>
    <SearchableSelect aria-label="搜尋 Agent" value={value} query={query} onQueryChange={setQuery}
      disabled={disabled} onChange={(next) => { onChange(next); setValue(next); }}
      options={Array.from({ length: 60 }, (_, i) => ({ value: `tool-${i}`, label: `工具 ${i}`, description: '已啟用 · 尚未偵測' }))} />
    <button>下一欄</button>
  </div>;
}

describe('searchable tool combobox', () => {
  it('bounds a searchable 60-item list, associates active options and commits only Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(60);
    await user.type(input, 'tool-5');
    expect(screen.getAllByRole('option')).toHaveLength(11);
    await user.keyboard('{ArrowDown}');
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)).toHaveTextContent('工具 50');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('tool-50');
    expect(input).toHaveValue('工具 50');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
  it('closes with Escape and Tab without selecting and restores the chosen label', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const onChange = vi.fn();
    render(<Harness onEscape={onEscape} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'nothing');
    expect(screen.getByRole('status')).toHaveTextContent('沒有符合');
    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();
    expect(input).toHaveValue('工具 0');
    await user.click(input);
    await user.tab();
    expect(screen.getByRole('button', { name: '下一欄' })).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('does not select, navigate or bubble Escape during IME composition', () => {
    const onChange = vi.fn();
    const onEscape = vi.fn();
    render(<Harness onChange={onChange} onEscape={onEscape} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.compositionStart(input);
    const active = input.getAttribute('aria-activedescendant');
    for (const key of ['ArrowDown', 'Enter', 'Escape']) fireEvent.keyDown(input, { key, isComposing: true });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', active);
    expect(onChange).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
  it('dismisses outside and remains unavailable while locked', async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(screen.getByRole('combobox'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    view.rerender(<Harness disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
