import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandThemePicker } from './components/CommandThemePicker';
import type { Appearance } from './themes';

const value: Appearance = { theme: 'dark', themePalette: 'bay', terminalTheme: 'classic', fontSize: 14, fontFamily: 'monospace' };
function props() { return { target: 'ui' as const, value, saving: false, error: '', onPreview: vi.fn(), onCommit: vi.fn(), onBack: vi.fn() }; }

describe('command theme picker field ownership', () => {
  it('preview and commit own only UI theme fields, even after a newer saved font/theme baseline arrives', () => {
    const p = props();
    const view = render(<CommandThemePicker {...p} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Ocean · 海洋 · 淺色' } });
    expect(p.onPreview).toHaveBeenLastCalledWith({ theme: 'light', themePalette: 'ocean' });
    view.rerender(<CommandThemePicker {...p} value={{ ...value, fontSize: 22, fontFamily: 'new font', terminalTheme: 'forest-light', themePalette: 'rose' }} />);
    expect(p.onPreview).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCommit).toHaveBeenCalledWith({ theme: 'light', themePalette: 'ocean' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.onBack).toHaveBeenCalledOnce();
    expect(p.onCommit).toHaveBeenCalledOnce();
  });
  it('terminal hover/arrow preview owns only terminalTheme and retains legacy choices', () => {
    const p = props();
    render(<CommandThemePicker {...p} target="terminal" />);
    fireEvent.mouseEnter(screen.getByRole('option', { name: /Classic/ }));
    expect(p.onPreview).toHaveBeenLastCalledWith({ terminalTheme: 'classic' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '淺色 · Ocean' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(p.onCommit).toHaveBeenLastCalledWith({ terminalTheme: 'ocean-light' });
  });
  it('filtering to zero options clears preview and cannot commit, arrow selection wraps', () => {
    const p = props();
    render(<CommandThemePicker {...p} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(p.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'system' }));
    fireEvent.change(input, { target: { value: 'absent-theme' } });
    expect(p.onPreview).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCommit).not.toHaveBeenCalled();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });
  it('saving prevents changes and repeat commits but allows explicit back', () => {
    const p = props();
    render(<CommandThemePicker {...p} saving />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(p.onPreview).not.toHaveBeenCalled();
    expect(p.onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回命令' }));
    expect(p.onBack).toHaveBeenCalledOnce();
  });
});
