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

test('mixed tab shows each pane project, moves tools with focus and returns panes home', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/browser/workspace-focus-mode.html?overview');
  await page.getByRole('button', { name: /^全部工作區/ }).click();
  await page.evaluate(() => Object.assign(window, { overviewTerminals: [...document.querySelectorAll('.xterm')] }));
  await page.getByRole('checkbox', { name: /^並排選取 Synthetic focus · Shell Focus shell/ }).check();
  await page.getByRole('checkbox', { name: /^並排選取 Synthetic other/ }).check();
  await page.getByRole('button', { name: '並排開啟' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic focus');
  await expect(page.getByRole('img', { name: '混合：Synthetic focus、Synthetic other' })).toBeVisible();
  const focusPane = page.getByRole('region', { name: 'Synthetic focus · Focus shell 終端面板' });
  const otherPane = page.getByRole('region', { name: 'Synthetic other · Other shell 終端面板' });
  await expect(focusPane).toBeVisible();
  await expect(otherPane).toBeVisible();
  await expect(focusPane.locator('.pane-identity')).toContainText('Synthetic focus');
  await expect(otherPane.locator('.pane-identity')).toContainText('Synthetic other');
  const tools = page.locator('.tool-context');
  await expect(tools).toContainText('Synthetic focus');
  await page.screenshot({ path: info.outputPath('mixed-tab.png') });

  await otherPane.locator('.xterm-screen').click();
  await expect(tools).toContainText('Synthetic other');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic focus');

  // Narrow panes collapse their actions into the pane menu.
  const paneMenu = otherPane.getByRole('button', { name: '面板選項 Other shell', exact: true });
  if (await paneMenu.isVisible()) await paneMenu.click();
  await otherPane.getByRole('button', { name: /^移回 Synthetic other/ }).click();
  await expect(otherPane).toBeHidden();
  await expect(page.getByRole('img', { name: /^混合：/ })).toHaveCount(0);
  await expect(tools).toHaveCount(0);
  expect(await page.evaluate(() => {
    const before = (window as unknown as { overviewTerminals: Element[] }).overviewTerminals;
    return before.every((node) => node.isConnected) && document.querySelectorAll('.xterm').length === before.length;
  })).toBe(true);
});
