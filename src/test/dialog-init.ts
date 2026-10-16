import { vi } from 'vitest';
import initScript from './fixtures/tauri-dialog-2.8.3-init.js.txt?raw';

/** Execute the actual pinned plugin initialization, rather than mocking boolean confirm. */
export function installNativeConfirmation(invoke: (command: string, args: unknown) => Promise<unknown>) {
  const nativeWindow = {
    __TAURI_INTERNALS__: { invoke },
    confirm: (): Promise<boolean> => Promise.resolve(false),
    alert: () => {},
  };
  new Function('window', initScript)(nativeWindow);
  vi.spyOn(window, 'confirm').mockImplementation(nativeWindow.confirm as unknown as typeof window.confirm);
}
