import { api, call } from './api';

/** Explicit native smoke only; the runner supplies an isolated PowerShell profile. */
export async function runTerminalSmoke(): Promise<void> {
  const waitFor = async (condition: () => boolean | Promise<boolean>, description: string) => {
    const deadline = performance.now() + 15000;
    while (!await condition()) {
      if (performance.now() >= deadline) throw new Error(`Terminal smoke: ${description}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  };
  const click = (button: HTMLButtonElement | null) => {
    if (!button || button.disabled || button.getBoundingClientRect().width <= 0)
      throw new Error('Terminal smoke: missing enabled control');
    button.click();
  };
  if ((await api.runtimes()).length !== 0) throw new Error('Terminal smoke: expected an empty isolated broker');
  click(document.querySelector<HTMLButtonElement>('.temporary-terminal-button'));
  await waitFor(() => !!document.querySelector('.xterm-helper-textarea') &&
    !!document.querySelector('.runtime-dot.running'), 'shell did not start');
  const running = await api.runtimes();
  if (running.length !== 1 || running[0].kind !== 'shell' || running[0].state !== 'running')
    throw new Error('Terminal smoke: expected exactly one running synthetic shell');
  const input = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
  input.focus();
  // Exercise xterm's input handler and the real IPC/PTY path, without clipboard access.
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true, inputType: 'insertText',
    data: "[IO.File]::WriteAllText($env:SESSIONBAY_SMOKE_INPUT_MARKER, 'received'); exit 0\r",
  }));
  // Successful shell exit (code zero, no pane error) automatically forgets the
  // broker record and closes the pane. Failed/nonzero exits must remain visible.
  await waitFor(async () => !document.querySelector('.xterm-host') &&
    (await api.runtimes()).length === 0, 'successful shell exit did not close and forget the pane');
  await call('frontend_diagnostic', { phase: 'interaction', message: 'terminal:launch-input-exit-close' });
}
