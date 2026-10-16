import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPathField } from './components/DirectoryPathField';
import { Dialog } from './components/Dialog';
import { canPickDirectory, pickDirectory } from './directory-picker';

vi.mock('./directory-picker', () => ({ canPickDirectory: vi.fn(() => true), pickDirectory: vi.fn() }));
function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string | null>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Field({ disabled = false, onChange = vi.fn() }: { disabled?: boolean; onChange?: (value: string) => void }) {
  const [value, setValue] = useState('/original');
  return <><DirectoryPathField label="工作目錄" value={value} disabled={disabled}
    onChange={(value) => { setValue(value); onChange(value); }} /><button>Next field</button></>;
}
const browse = () => screen.getByRole('button', { name: '選擇工作目錄' });
const field = () => screen.getByRole('textbox', { name: '工作目錄' });
beforeEach(() => { vi.mocked(canPickDirectory).mockReturnValue(true); vi.mocked(pickDirectory).mockReset(); });

describe('directory path field', () => {
  it('uses a labeled keyboard button without submitting and restores input focus', async () => {
    const user = userEvent.setup();
    vi.mocked(pickDirectory).mockResolvedValue('/a space/繁體中文/.hidden');
    const submit = vi.fn();
    const change = vi.fn();
    render(<form onSubmit={submit}><Field onChange={change} /></form>);
    field().focus();
    await user.tab();
    expect(browse()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(pickDirectory).toHaveBeenCalledExactlyOnceWith('選擇工作目錄', '/original');
    expect(field()).toHaveValue('/a space/繁體中文/.hidden');
    expect(field()).toHaveFocus();
    expect(change).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
  it('shows loading, suppresses repeated clicks and keeps manual input available', async () => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    render(<Field />);
    act(() => { fireEvent.click(browse()); fireEvent.click(browse()); });
    expect(browse()).toBeDisabled();
    expect(browse()).toHaveAttribute('aria-busy', 'true');
    expect(browse()).toHaveTextContent('選擇中…');
    expect(field()).toBeEnabled();
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(null));
    expect(browse()).toBeEnabled();
    expect(browse()).toHaveAttribute('aria-busy', 'false');
    expect(field()).toHaveValue('/original');
  });
  it('cancels without writing or clearing the existing path', async () => {
    const change = vi.fn();
    vi.mocked(pickDirectory).mockResolvedValue(null);
    render(<Field onChange={change} />);
    await act(async () => { fireEvent.click(browse()); });
    expect(field()).toHaveValue('/original');
    expect(change).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('preserves text on rejection, exposes an associated error, and supports retry', async () => {
    vi.mocked(pickDirectory).mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce('/retry');
    render(<Field />);
    await act(async () => { fireEvent.click(browse()); });
    expect(field()).toHaveValue('/original');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Permission denied');
    expect(field()).toHaveAttribute('aria-describedby', alert.id);
    expect(browse()).toBeEnabled();
    await act(async () => { fireEvent.click(browse()); });
    expect(field()).toHaveValue('/retry');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps manual input available and explains browser-preview unavailability', () => {
    vi.mocked(canPickDirectory).mockReturnValue(false);
    render(<Field />);
    expect(browse()).toBeDisabled();
    expect(field()).toHaveAccessibleDescription(/桌面應用程式/);
    fireEvent.change(field(), { target: { value: '/manual/.hidden' } });
    expect(field()).toHaveValue('/manual/.hidden');
    expect(pickDirectory).not.toHaveBeenCalled();
  });
  it.each(['result', 'error'] as const)('discards a late %s after newer manual input, even when changed back', async (outcome) => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    const change = vi.fn();
    render(<Field onChange={change} />);
    fireEvent.click(browse());
    fireEvent.change(field(), { target: { value: '/newer' } });
    fireEvent.change(field(), { target: { value: '/original' } });
    await act(async () => { if (outcome === 'result') pending.resolve('/late'); else pending.reject(new Error('Late error')); });
    expect(field()).toHaveValue('/original');
    expect(change).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('invalidates a pending result when saving locks the field, even if unlocked again', async () => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    const change = vi.fn();
    const view = render(<Field onChange={change} />);
    fireEvent.click(browse());
    view.rerender(<Field onChange={change} disabled />);
    expect(field()).toBeDisabled();
    view.rerender(<Field onChange={change} />);
    await act(async () => pending.resolve('/late'));
    expect(field()).toHaveValue('/original');
    expect(change).not.toHaveBeenCalled();
  });
  it('does not write to a field unmounted by navigation or mutate its replacement', async () => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    const old = vi.fn();
    const view = render(<Field key="old" onChange={old} />);
    fireEvent.click(browse());
    view.rerender(<Field key="new" />);
    await act(async () => pending.resolve('/late'));
    expect(old).not.toHaveBeenCalled();
    expect(field()).toHaveValue('/original');
  });
  it('uses the latest callback and preserves other draft changes while choosing', async () => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    const old = vi.fn();
    const current = vi.fn();
    const view = render(<DirectoryPathField label="工作目錄" value="/original" onChange={old} />);
    fireEvent.click(browse());
    view.rerender(<DirectoryPathField label="工作目錄" value="/original" onChange={current} />);
    await act(async () => pending.resolve('/chosen'));
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith('/chosen');
  });
  it('does not steal focus from a newer field after cancellation', async () => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    render(<Field />);
    fireEvent.click(browse());
    const next = screen.getByRole('button', { name: 'Next field' });
    next.focus();
    await act(async () => pending.resolve(null));
    expect(next).toHaveFocus();
  });
  it.each(['escape', 'close', 'backdrop'] as const)('discards results after dialog dismissal by %s and restores opener focus', async (method) => {
    const pending = deferred();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    const change = vi.fn();
    function Harness() {
      const [shown, setShown] = useState(false);
      return <><button onClick={() => setShown(true)}>Open</button>{shown && <Dialog title="Test" onClose={() => setShown(false)}><Field onChange={change} /></Dialog>}</>;
    }
    const view = render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(field()).toHaveFocus();
    fireEvent.click(browse());
    if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (method === 'close') fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    else fireEvent.mouseDown(view.container.querySelector('.dialog-backdrop')!);
    expect(opener).toHaveFocus();
    await act(async () => pending.resolve('/late'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });
});
