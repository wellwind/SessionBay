import { describe, expect, it, vi } from 'vitest';
import { confirmAction } from './confirmation';
import { installNativeConfirmation } from './test/dialog-init';
import capability from '../src-tauri/capabilities/default.json';

describe('native and browser confirmation contract', () => {
  it.each(['Cancel', 'No', '', undefined])('fails closed for native %s through the actual plugin initializer', async (button) => {
    const invoke = vi.fn().mockResolvedValue(button);
    installNativeConfirmation(invoke);
    expect(await confirmAction('Synthetic confirmation')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|message', { message: 'Synthetic confirmation', buttons: 'OkCancel' }, undefined);
  });
  it('permits explicit native Ok and enables only the required dialog commands', async () => {
    installNativeConfirmation(vi.fn().mockResolvedValue('Ok'));
    expect(await confirmAction('Synthetic confirmation')).toBe(true);
    expect(capability.permissions).toEqual(['core:default', 'dialog:allow-open', 'dialog:allow-message']);
  });
  it('fails closed without an unhandled rejection when the native command is denied', async () => {
    installNativeConfirmation(vi.fn().mockRejectedValue(new Error('plugin:dialog|message is not allowed')));
    await expect(confirmAction('Synthetic confirmation')).resolves.toBe(false);
  });
  it.each([true, false, 1, 'yes', null, undefined])('accepts only literal true from the browser result %s', async (value) => {
    vi.spyOn(window, 'confirm').mockImplementation(() => value as boolean);
    expect(await confirmAction('Synthetic confirmation')).toBe(value === true);
  });
  it('fails closed when the dialog throws synchronously', async () => {
    vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('Unavailable'); });
    await expect(confirmAction('Synthetic confirmation')).resolves.toBe(false);
  });
  it('does not reuse one pending confirmation to authorize another action', async () => {
    let finish!: (value: string) => void;
    const invoke = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    installNativeConfirmation(invoke);
    const first = confirmAction('First action');
    await expect(confirmAction('Different action')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
    finish('Ok');
    await expect(first).resolves.toBe(true);
  });
});
