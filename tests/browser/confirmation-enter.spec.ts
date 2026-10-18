import { expect, test } from '@playwright/test';

test('native Enter opens then confirms only on a separate press; explicit cancel and IME remain safe', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?edge=1');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  const opener = page.getByRole('button', { name: '關閉分頁 Hidden shell', exact: true });
  const stops = () => page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string }[] } }).focusFixture.calls.filter(call => call.command === 'stop_runtime').length);
  await opener.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('button', { name: '結束並關閉', exact: true });
  await expect(confirm).toBeFocused();
  await page.screenshot({ path: info.outputPath('primary-confirmation-focus.png') });
  expect(await stops()).toBe(0);
  for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }])
    await confirm.dispatchEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...guard });
  expect(await stops()).toBe(0);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stops()).toBe(0);
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await stops()).toBe(1);
});


test('F1 explicit confirmation preserves focus ownership, cancels on Escape and sends once on Enter plus click', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?edge=1&hook-skip=1');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  const count = (command: string) => page.evaluate(command =>
    (window as unknown as { focusFixture: { calls: { command: string }[] } }).focusFixture.calls.filter(call => call.command === command).length, command);
  const submit = async () => {
    await page.getByRole('button', { name: '新增工作', exact: true }).click();
    const launcher = page.getByRole('dialog', { name: '開始新的工作' });
    await launcher.getByRole('button', { name: '開始工作', exact: true }).click();
    return page.getByRole('dialog', { name: '本次不啟用活動回報', exact: true });
  };
  let dialog = await submit();
  await expect(dialog).toBeVisible();
  expect(await count('launch_fresh_without_hooks')).toBe(0);
  await expect(dialog.getByRole('button', { name: '關閉對話框' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await count('cancel_fresh_launch')).toBe(1);
  dialog = await submit();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath('f1-hook-skip-confirmation.png') });
  const confirm = dialog.getByRole('button', { name: '本次不啟用活動回報，繼續啟動', exact: true });
  await confirm.focus();
  const originalButton = await confirm.elementHandle();
  await page.keyboard.press('Enter');
  await originalButton!.evaluate(button => (button as HTMLButtonElement).click());
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => count('attach_runtime')).toBe(3); // Two initial shells, then the confirmed Agent.
  expect(await count('launch_fresh_without_hooks')).toBe(1);
  expect(await count('list_runtimes')).toBe(0); // Confirmation itself does not invalidate ownership.
  expect(await count('save_settings')).toBe(0);
  expect(await count('stop_runtime')).toBe(0);
  await page.screenshot({ path: info.outputPath('f1-confirmed-agent.png') });
});
