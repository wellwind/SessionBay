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
      throw new Error('UI smoke: expected a visible, enabled control');
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
  for (const name of ['Codex', 'Claude Code', 'Grok Build', 'Antigravity CLI']) {
    const checkbox = dialog()?.querySelector<HTMLInputElement>(`input[aria-label="${name} 略過權限確認"]`);
    if (!checkbox || checkbox.checked) throw new Error(`UI smoke: missing/default-unsafe ${name} options`);
  }
  close();
  await waitFor(() => !dialog(), 'settings dialog did not dismiss before project navigation');
  const projectDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="加入或建立專案"]');
  const openProject = () => click(document.querySelector<HTMLButtonElement>('button[aria-label="加入專案"]'));
  const projectButton = (label: string) => Array.from(projectDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((button) => button.textContent?.trim() === label) ?? null;
  if (document.querySelector('h1')?.textContent !== '所有工作階段')
    throw new Error('UI smoke: All Sessions overview is not selected');
  if (document.querySelector('nav[aria-label="專案"] .project-row'))
    throw new Error('UI smoke: blank HOME unexpectedly contains curated projects');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not open');
  click(projectButton('建立新專案'));
  await waitFor(() => !!projectButton('建立並加入'), 'create project mode did not open');
  click(projectButton('取消'));
  await waitFor(() => !projectDialog(), 'project dialog did not cancel');
  openProject();
  await waitFor(() => !!projectDialog(), 'project dialog did not reopen');
  // Form state must reset after cancel, and no create/add command is submitted.
  await waitFor(() => projectButton('加入現有目錄')?.classList.contains('selected') === true,
    'cancelled project creation leaked into the next dialog');
  click(projectButton('建立新專案'));
  await waitFor(() => !!projectButton('建立並加入'), 'create project mode did not reopen');
  // Allow the final committed layout to reach the compositor before capture.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  window.SessionBayStartup?.interaction();
}
