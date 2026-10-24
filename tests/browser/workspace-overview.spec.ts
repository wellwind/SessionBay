import { expect, test } from '@playwright/test';

test('all-workspaces grid monitors every pane and zooms in without remounting terminals', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/browser/workspace-focus-mode.html?overview');
  await page.getByRole('button', { name: /^全部工作區/ }).click();
  const grid = page.getByRole('list', { name: '開啟中的工作' });
  const cards = grid.getByRole('button', { name: /^放大 / });
  await expect(cards).toHaveCount(4);
  // The Codex pane reported a terminal question, so it leads the attention order.
  await expect(cards.first()).toHaveAccessibleName(/^放大 Synthetic focus · .* Refactor agent，等待輸入/);
  await expect(page.getByText('1 個等待輸入')).toBeVisible();
  await expect.poll(() => grid.locator('.overview-tail').first().innerText()).toContain('Synthetic focus output 100');
  await expect(grid.getByText('臨時 Terminal')).toBeVisible();
  // Every terminal remains mounted under the grid; remember the exact nodes.
  await page.evaluate(() => Object.assign(window, { overviewTerminals: [...document.querySelectorAll('.xterm')] }));
  await page.screenshot({ path: info.outputPath('overview-grid.png') });

  await cards.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();

  await grid.getByRole('button', { name: /^放大並回覆 / }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic focus');
  await expect(grid).toHaveCount(0);
  await expect(page.locator('.terminal-pane.focused .xterm-helper-textarea')).toBeFocused();
  await page.getByRole('button', { name: '返回全部工作區' }).click();
  await expect(grid).toBeVisible();

  await page.getByLabel('專案篩選').selectOption({ label: 'Synthetic other' });
  await expect(cards).toHaveCount(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+O' : 'Control+Shift+O');
  await expect(grid).toHaveCount(0);

  expect(await page.evaluate(() => {
    const before = (window as unknown as { overviewTerminals: Element[] }).overviewTerminals;
    const after = [...document.querySelectorAll('.xterm')];
    return before.length === after.length && before.every((node, index) => node.isConnected && node === after[index]);
  })).toBe(true);
});

test('overview stays within short, narrow windows', async ({ page }, info) => {
  await page.setViewportSize({ width: 720, height: 470 });
  await page.goto('/tests/browser/workspace-focus-mode.html?overview');
  await page.getByRole('button', { name: /^全部工作區/ }).click();
  await expect(page.getByRole('list', { name: '開啟中的工作' }).getByRole('button', { name: /^放大 / })).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const overview = page.locator('.workspace-overview');
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-narrow.png') });
});
