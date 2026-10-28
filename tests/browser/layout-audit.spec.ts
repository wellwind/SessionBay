import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Opens every main screen in English and Traditional Chinese at several window
// widths and fails when a control's text is clipped or spills out of its box.
// Long user data (paths, titles) may truncate with an ellipsis when a tooltip
// carries the full text. Set LAYOUT_AUDIT_DIR to also save screenshots.
const zh = () => test.info().project.name === 'zh-tw';
const L = (en: string, zhText: string) => (zh() ? zhText : en);
const widths = [1440, 1280, 1024];
const bridge = 'http://127.0.0.1:1463';

async function open(page: Page, git = false) {
  await page.goto(`/tests/browser/showcase.html${git ? `?git=${encodeURIComponent(bridge)}` : ''}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
}

async function clippedText(page: Page) {
  return page.evaluate(() => {
    const selector = 'button, a, [role="tab"], [role="menuitem"], [role="option"], [role="radio"], label, legend, summary, h1, h2, h3, h4, th, dt, small, .settings-status, .git-chip, .eyebrow, .overview-status';
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || style.display === 'inline' || style.visibility === 'hidden') continue;
      if (el.closest('.xterm, .monaco-editor, [aria-hidden="true"]')) continue;
      const clipped = el.scrollWidth > el.clientWidth + 1 || (style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1);
      if (!clipped) continue;
      if (style.textOverflow === 'ellipsis' && el.closest('[title]')) continue;
      const text = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      found.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''} "${text}" (${el.scrollWidth}>${el.clientWidth})`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) found.push(`page scrolls horizontally (${document.documentElement.scrollWidth}>${innerWidth})`);
    return [...new Set(found)];
  });
}

type View = [name: string, show: (page: Page) => Promise<void>, git?: boolean];
const settings = (section: [string, string]) => async (page: Page) => {
  await page.getByRole('button', { name: L('Settings and sources', '設定與資料來源') }).click();
  await page.getByRole('dialog').getByRole('button', { name: L(...section) }).first().click();
};
const views: View[] = [
  ['projects', async () => undefined],
  ['directories', async page => { await page.locator('#navigation-directories').click(); }],
  ['history', async page => {
    await page.locator('.directory-card-main').first().click();
    await page.getByRole('button', { name: L('Sessions', '歷史 Sessions'), exact: true }).first().click();
    await page.locator('.session-card-select').first().click();
    await expect(page.locator('.transcript-message').first()).toBeVisible();
  }],
  ['history-filters', async page => {
    await page.locator('.directory-card-main').first().click();
    await page.getByRole('button', { name: L('Sessions', '歷史 Sessions'), exact: true }).first().click();
    await page.getByRole('button', { name: L('Filter', '篩選') }).click();
  }],
  ['terminals', async page => {
    await page.getByRole('button', { name: L('Open workspace harbor-api Rate limiting', '開啟工作區 harbor-api 速率限制') }).click();
    await expect(page.locator('.xterm-screen').first()).toBeVisible();
  }],
  ['overview', async page => { await page.locator('.sidebar-global', { hasText: L('All workspaces', '全部工作區') }).click(); }],
  ['settings-sources', settings(['Sources and tools', '來源與工具'])],
  ['settings-profiles', settings(['Shell Profiles', 'Shell Profiles'])],
  ['settings-appearance', settings(['Appearance and defaults', '外觀與預設值'])],
  ['settings-shortcuts', settings(['Keyboard shortcuts', '鍵盤快捷鍵'])],
  ['new-work', async page => {
    await page.locator('.directory-card-main').first().click();
    await page.locator('.header-buttons').getByRole('button', { name: L('New work', '新增工作') }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }],
  ['add-project', async page => { await page.getByRole('button', { name: L('Add / create project', '加入／建立專案') }).first().click(); }],
  ['recycle-bin', async page => {
    await page.locator('.directory-card-main').first().click();
    await page.getByRole('button', { name: L('Recycle bin', '資源回收筒') }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }],
  ['command-palette', async page => {
    await page.getByRole('button', { name: L('Search projects or run a command', '搜尋專案或執行命令') }).click();
  }],
  ['files', async page => {
    await page.locator('.directory-card-main').first().click();
    await page.getByRole('button', { name: 'Files', exact: true }).first().click();
    await page.getByRole('treeitem', { name: /README\.md/ }).click();
  }],
  ['git', async page => {
    await page.getByRole('button', { name: L('Open workspace harbor-api Rate limiting', '開啟工作區 harbor-api 速率限制') }).click();
    await page.locator('.workspace-activity-bar').getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#activity-git-panel').getByRole('radiogroup')).toBeVisible();
  }, true],
];

for (const [name, show, git] of views) {
  test(name, async ({ page, request }) => {
    if (git) await request.post(`${bridge}/reset`);
    const problems: string[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 860 });
      await open(page, git);
      await show(page);
      await page.waitForTimeout(400);
      const dir = process.env.LAYOUT_AUDIT_DIR;
      if (dir) {
        mkdirSync(`${dir}/${test.info().project.name}`, { recursive: true });
        await page.screenshot({ path: `${dir}/${test.info().project.name}/${name}-${width}.png` });
      }
      for (const problem of await clippedText(page)) problems.push(`${width}px ${problem}`);
    }
    if (process.env.LAYOUT_AUDIT_DIR) writeFileSync(`${process.env.LAYOUT_AUDIT_DIR}/${test.info().project.name}-${name}.txt`, problems.join('\n'));
    expect(problems).toEqual([]);
  });
}
