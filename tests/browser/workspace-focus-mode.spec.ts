import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type Call = { command: string; cols?: number; rows?: number };
const lifecycle = (page: Page) => page.evaluate(() => {
  const { calls } = (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture;
  return calls.filter(call => ['launch_runtime', 'attach_runtime', 'detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command));
});
const latestSize = (page: Page) => page.evaluate(() =>
  (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'resize_runtime').at(-1));
const geometry = (page: Page) => page.locator('.terminal-body').evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
});
async function openWorkspace(page: Page) {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('Synthetic focus output');
  await expect.poll(() => latestSize(page)).toBeTruthy();
  expect(await lifecycle(page)).toEqual([{ command: 'attach_runtime' }]);
}
async function sameTerminal(page: Page) {
  expect(await page.evaluate(() => {
    const saved = (window as unknown as { originalTerminal: Element; originalCanvas: Element });
    return document.querySelector('.xterm') === saved.originalTerminal &&
      document.querySelector('.workspace-canvas') === saved.originalCanvas;
  })).toBe(true);
  expect(await lifecycle(page)).toEqual([{ command: 'attach_runtime' }]);
}

test.beforeEach(async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(() => Object.assign(window, {
    originalTerminal: document.querySelector('.xterm'),
    originalCanvas: document.querySelector('.workspace-canvas'),
  }));
});

test('focus gains terminal area, fits on resize, and preserves runtime and terminal identity', async ({ page, browser }, testInfo) => {
  const normal = await geometry(page);
  const normalSize = await latestSize(page);
  await page.screenshot({ path: testInfo.outputPath('normal.png'), fullPage: true });
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeHidden();
  await expect(page.locator('.project-header')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect.poll(async () => (await geometry(page)).height).toBeGreaterThan(normal.height);
  const focused = await geometry(page);
  expect(focused.width).toBeGreaterThan(normal.width);
  await expect.poll(async () => (await latestSize(page))?.rows ?? 0).toBeGreaterThan(normalSize!.rows!);
  await sameTerminal(page);
  await page.screenshot({ path: testInfo.outputPath('focused.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(async () => (await geometry(page)).width).toBeLessThan(focused.width);
  await expect.poll(async () => (await latestSize(page))?.cols ?? 0).toBeLessThan(normalSize!.cols!);
  await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeInViewport();
  await page.locator('.xterm-screen').click();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
  await expect.poll(() => geometry(page)).toEqual(normal);
  await sameTerminal(page);
  const geometryPath = testInfo.outputPath('geometry.json');
  await writeFile(geometryPath, JSON.stringify({ browser: browser.version(), normal, focused }, null, 2));
  await testInfo.attach('geometry', { path: geometryPath, contentType: 'application/json' });
});

test('history, settings, theme and project navigation remain reachable without reattaching', async ({ page }) => {
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await page.getByRole('button', { name: '歷史 Session', exact: true }).click();
  await expect(page.locator('.history-mount')).toBeVisible();
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  await sameTerminal(page);
  await page.locator('.workspace-tab-select').click();
  await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
  await page.getByRole('button', { name: '設定與資料來源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '關閉設定', exact: true }).click();
  await page.getByRole('button', { name: '快速切換主題', exact: true }).click();
  await page.getByRole('button', { name: '淺色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '收起完整控制列', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeHidden();
  await sameTerminal(page);
  await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  await expect(page.locator('.project-header h1')).toHaveText('Synthetic other');
  await page.getByRole('tab', { name: /^專案/ }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
  await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await sameTerminal(page);
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
});

test('long tab names keep a keyboard-operable focus exit at supported narrow width', async ({ page }) => {
  await page.getByRole('button', { name: '重新命名分頁 Focus shell', exact: true }).click();
  await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill('Long synthetic workspace name '.repeat(6));
  await page.getByRole('button', { name: '儲存名稱', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 550 });
  const exit = page.getByRole('button', { name: '退出專注模式', exact: true });
  await expect(exit).toBeInViewport({ ratio: 1 });
  await exit.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
  await sameTerminal(page);
});


for (const sidebarOpen of [true, false]) {
  test(`hiding revealed controls restores terminal focus (initial sidebar ${sidebarOpen})`, async ({ page }) => {
    if (!sidebarOpen) await page.getByRole('button', { name: '隱藏側欄', exact: true }).click();
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
    const hide = page.getByRole('button', { name: '隱藏側欄', exact: true });
    await hide.focus();
    await hide.click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await sameTerminal(page);
    await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
    await expect(page.locator('.sidebar')).toHaveCount(sidebarOpen ? 1 : 0);
  });
}
