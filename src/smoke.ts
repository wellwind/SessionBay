/** Invoked only after the native diagnostic command confirms SESSIONBAY_SMOKE=1. */
export async function runSmokeInteraction(): Promise<void> {
  const dialog = () => document.querySelector<HTMLElement>('.settings-panel[role="dialog"]');
  const waitFor = (condition: () => boolean, description: string): Promise<void> => {
    const deadline = performance.now() + 5000;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (condition()) resolve();
        else if (performance.now() >= deadline) reject(new Error(`UI smoke: ${description}`));
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  };
  const click = (button: HTMLButtonElement | null) => {
    if (!button || button.disabled || button.getBoundingClientRect().width <= 0)
      throw new Error('UI smoke: expected a visible, enabled settings control');
    button.click();
  };
  const close = () =>
    click(dialog()?.querySelector<HTMLButtonElement>(
      'button[aria-label="稍後設定"], button[aria-label="關閉設定"]',
    ) ?? null);
  const open = () => click(document.querySelector<HTMLButtonElement>(
    'button[aria-label="設定與資料來源"]',
  ));
  if (dialog()) {
    close();
    await waitFor(() => !dialog(), 'initial settings dialog did not dismiss');
  }
  open();
  await waitFor(() => !!dialog(), 'settings dialog did not open');
  close();
  await waitFor(() => !dialog(), 'settings dialog did not close');
  open();
  await waitFor(() => !!dialog(), 'settings dialog did not reopen');
  // Allow the final committed layout to reach the compositor before capture.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  window.SessionBayStartup?.interaction();
}
