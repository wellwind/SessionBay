import { expect, test, type Page } from '@playwright/test';

const handle = (page: Page) => page.getByRole('separator', { name: '調整專案導覽寬度' });
const width = (page: Page) => page.locator('aside.sidebar').evaluate(element => element.getBoundingClientRect().width);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('sessionbay.sidebar.v1')!).width);
async function drag(page: Page, delta: number, finish = true) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + 100;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('project-navigation-resize'), { x, y })).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 6 });
  if (finish) await page.mouse.up();
}
async function open(page: Page) {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-rows')).toContainText('Synthetic focus output');
}
for (const [viewport, maximum] of [[900, 360], [720, 200], [600, 160], [450, 160]]) {
  test(`full App pointer changes aside geometry and persists at CSS width ${viewport}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 620 });
    await page.addInitScript(() => {
      if (!localStorage.getItem('sessionbay.sidebar.v1')) localStorage.setItem('sessionbay.sidebar.v1', JSON.stringify({ version: 1, width: 170 }));
    });
    await open(page);
    if (maximum === 160) {
      await expect(handle(page)).toHaveCount(0);
      await expect.poll(() => width(page)).toBe(160);
      expect(await stored(page)).toBe(170);
      await page.reload();
      await expect.poll(() => width(page)).toBe(160);
      expect(await stored(page)).toBe(170);
      await page.setViewportSize({ width: 1440, height: 940 });
      await expect.poll(() => width(page)).toBe(170);
      return;
    }
    await expect(handle(page)).toHaveAttribute('aria-valuemin', '160');
    await expect(handle(page)).toHaveAttribute('aria-valuemax', String(maximum));
    await expect.poll(() => width(page)).toBe(170);
    await drag(page, 8, false);
    await expect.poll(() => width(page)).toBe(178);
    expect(await stored(page)).toBe(170);
    await page.mouse.up();
    await expect.poll(() => stored(page)).toBe(178);
    await drag(page, -12);
    await expect.poll(() => width(page)).toBe(166);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '166');
    await expect(page.locator('aside.sidebar')).toHaveCSS('width', '166px');
    await page.reload();
    await expect.poll(() => width(page)).toBe(166);
    expect(await stored(page)).toBe(166);
  });
}
test('full App cancels real pointer drafts and preserves preference through resize and Zen', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  await open(page);
  await page.evaluate(() => Object.assign(window, { originalTerminal: document.querySelector('.xterm') }));
  await drag(page, 64);
  await expect.poll(() => width(page)).toBe(300);
  await drag(page, 40, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(300);
  expect(await stored(page)).toBe(300);
  await drag(page, 40, false);
  await page.setViewportSize({ width: 600, height: 413 });
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(160);
  expect(await stored(page)).toBe(300);
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(handle(page)).toHaveCount(0);
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect.poll(() => width(page)).toBe(160);
  await page.setViewportSize({ width: 1200, height: 850 });
  await expect.poll(() => width(page)).toBe(300);
  expect(await page.evaluate(() => document.querySelector('.xterm') === (window as unknown as { originalTerminal: Element }).originalTerminal)).toBe(true);
  expect(await stored(page)).toBe(300);
});
