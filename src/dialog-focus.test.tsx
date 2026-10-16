import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './components/Dialog';
import { RenameDialog } from './components/RenameDialog';
import { hasBlockingDialog } from './dialog-focus';

describe('modal focus and composition arbitration', () => {
  it('captures the opener before descendant autofocus and restores it after keyboard dismissal', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>{open && <Dialog title="Other dialog" onClose={() => setOpen(false)}><input aria-label="Auto focus field" autoFocus /></Dialog>}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' }); opener.focus();
    fireEvent.click(opener);
    expect(screen.getByLabelText('Auto focus field')).toHaveFocus(); expect(hasBlockingDialog()).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(opener).toHaveFocus(); expect(hasBlockingDialog()).toBe(false);
  });
  it('keeps the rename draft through composition Escape and closes only after composition ends', () => {
    const close = vi.fn();
    render(<RenameDialog title="Rename" name="Old" description="Label only" onSave={vi.fn()} onClose={close} />);
    const input = screen.getByLabelText('顯示名稱');
    fireEvent.change(input, { target: { value: '尚未完成' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Escape' }); // Some WebViews omit isComposing on this event.
    expect(close).not.toHaveBeenCalled(); expect(input).toHaveValue('尚未完成'); expect(input).toHaveFocus();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  });
  it('keeps keyboard tabbing inside the dialog and resets interrupted composition on blur', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
    const close = vi.fn();
    render(<RenameDialog title="Rename" name="Old" description="Label only" onSave={vi.fn()} onClose={close} />);
    const first = screen.getByRole('button', { name: '關閉對話框' });
    const last = screen.getByRole('button', { name: '儲存名稱' });
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    fireEvent.compositionStart(screen.getByLabelText('顯示名稱'));
    fireEvent.blur(window);
    fireEvent.keyDown(first, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  });
  it('recognizes alert dialogs and leaves non-modal popovers unblocked', () => {
    const { rerender } = render(<div role="dialog" aria-modal="false" />);
    expect(hasBlockingDialog()).toBe(false);
    rerender(<div role="alertdialog" aria-modal="true" />); expect(hasBlockingDialog()).toBe(true);
  });
});
