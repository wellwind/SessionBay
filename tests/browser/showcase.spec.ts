import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Captures the website screenshots from the synthetic showcase fixture:
// npx playwright test --config playwright.showcase.config.ts
const zh = () => test.info().project.name === 'zh-tw';
const L = (en: string, zhText: string) => (zh() ? zhText : en);

async function open(page: Page) {
  await page.goto('/tests/browser/showcase.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
}

async function shot(page: Page, name: string) {
  const dir = `website/src/assets/screenshots/${test.info().project.name}`;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test('projects overview', async ({ page }) => {
  await open(page);
  await shot(page, 'projects');
});

test('session history and preview', async ({ page }) => {
  await open(page);
  await page.locator('.directory-card-main').first().click();
  await page.getByRole('button', { name: L('Sessions', '歷史 Sessions'), exact: true }).first().click();
  await page.locator('.session-card-select').first().click();
  await expect(page.locator('.transcript-message').first()).toBeVisible();
  await shot(page, 'history');
});

test('split terminals', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: L('Open workspace harbor-api Rate limiting', '開啟工作區 harbor-api 速率限制') }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
  await shot(page, 'terminals');
});

test('all workspaces overview', async ({ page }) => {
  await open(page);
  await page.locator('.sidebar-global', { hasText: L('All workspaces', '全部工作區') }).click();
  await expect(page.locator('.overview-card').first()).toBeVisible();
  await shot(page, 'overview');
});

test('settings', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: L('Settings and sources', '設定與資料來源') }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, 'settings');
});
