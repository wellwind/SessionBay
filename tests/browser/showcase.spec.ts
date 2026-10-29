import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Captures the website screenshots from the synthetic showcase fixture:
// npx playwright test --config tests/browser/config/showcase.config.ts
const zh = () => test.info().project.name === 'zh-tw';
const L = (en: string, zhText: string) => (zh() ? zhText : en);

const bridge = 'http://127.0.0.1:1452';

async function open(page: Page, git = false) {
  await page.goto(`/tests/browser/showcase.html${git ? `?git=${encodeURIComponent(bridge)}` : ''}`);
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
  await page.getByRole('button', { name: L('Appearance and defaults', '外觀與預設值'), exact: true }).click();
  await page.getByRole('heading', { name: L('System notifications', '系統通知'), exact: true })
    .evaluate(element => element.scrollIntoView({ block: 'start' }));
  const sound = page.getByRole('checkbox', { name: L('Play a sound when an agent needs attention', 'Agent 需要注意時播放音效') });
  const volume = page.getByRole('slider', { name: L('Attention sound volume', '提醒音效音量'), exact: true });
  await expect(sound).toBeInViewport();
  await expect(sound).not.toBeChecked();
  await expect(volume).toBeInViewport();
  await expect(volume).toHaveValue('70');
  for (const name of [L('Test waiting sound', '測試等待音效'), L('Test completion sound', '測試完成音效'), L('Test failure sound', '測試失敗音效')]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
  }
  await shot(page, 'settings');
});

test('git workbench', async ({ page, request }) => {
  await request.post(`${bridge}/reset`);
  await open(page, true);
  await page.getByRole('button', { name: L('Open workspace harbor-api Rate limiting', '開啟工作區 harbor-api 速率限制') }).click();
  await page.locator('.workspace-activity-bar').getByRole('button', { name: 'Git', exact: true }).click();
  const panel = page.locator('#activity-git-panel');
  await panel.getByRole('button', { name: new RegExp(`^f\\.txt${L(', Modified', '，已修改')}`) }).click();
  await expect(page.locator('.git-document').getByText('BETA').first()).toBeVisible();
  await shot(page, 'git');
});

test('project board', async ({ page }) => {
  await open(page);
  await page.locator('.directory-card-main').first().click();
  await page.getByRole('button', { name: L('Board', '看板'), exact: true }).click();
  await expect(page.locator('.kanban-card').first()).toBeVisible();
  await shot(page, 'board');
});

test('all boards overview', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: L('All boards', '全部看板'), exact: true }).click();
  await expect(page.locator('[data-kanban-card="web-task"]')).toBeVisible();
  await shot(page, 'all-boards');
});
