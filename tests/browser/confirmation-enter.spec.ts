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
