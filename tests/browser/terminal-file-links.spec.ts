import { expect, test, type Page } from '@playwright/test';
const resolves = (page: Page) => page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string; path?: string; projectId?: string; runtimeId?: string; paneId?: string }[] } }).focusFixture.calls.filter(call => call.command === 'resolve_terminal_file'));
async function openWorkspace(page: Page, zen = false) {
  await page.goto('/tests/browser/workspace-focus-mode.html?file-links=1' + (zen ? '&theme=light' : ''));
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-rows')).toContainText('ABS /synthetic');
  if (zen) await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await page.evaluate(() => Object.assign(window, { originalFileLinkTerminal: document.querySelector('.xterm'), openedFileTargets: [] }));
  await page.evaluate(() => { window.open = (...args) => { (window as unknown as { openedFileTargets: unknown[] }).openedFileTargets.push(args[0]); return null; }; });
}
async function point(page: Page, prefix: string, text: string) {
  const row = page.locator('.xterm-rows > div').filter({ hasText: prefix }).first();
  await expect(row).toBeVisible();
  return row.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null; let offset = element.textContent!.indexOf(target) + 2;
    if (offset < 2) throw new Error('Synthetic terminal target missing');
    while ((node = walker.nextNode())) {
      const length = node.textContent!.length;
      if (offset < length) {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      offset -= length;
    }
    throw new Error('Synthetic terminal range missing');
  }, text);
}
async function clickLink(page: Page, prefix: string, text: string, modified = true) {
  const at = await point(page, prefix, text);
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.mouse.move(at.x, at.y); // Real xterm provider/hover, not a test-only click hook.
  if (modified) await page.keyboard.down(modifier);
  await page.mouse.click(at.x, at.y);
  if (modified) await page.keyboard.up(modifier);
}
async function intact(page: Page) {
  expect(await page.evaluate(() => document.querySelector('.xterm') === (window as unknown as { originalFileLinkTerminal: Element }).originalFileLinkTerminal)).toBe(true);
  const calls = await page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string }[] } }).focusFixture.calls);
  expect(calls.filter(call => ['launch_runtime', 'stop_runtime', 'forget_runtime', 'detach_runtime', 'write_runtime'].includes(call.command))).toEqual([]);
  expect(calls.filter(call => call.command === 'attach_runtime')).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { openedFileTargets: unknown[] }).openedFileTargets)).toEqual([]);
}
for (const zen of [false, true]) test(`modifier links reuse file tabs and locate lines in ${zen ? 'Zen light' : 'normal dark'}`, async ({ page }, info) => {
  await openWorkspace(page, zen);
  await clickLink(page, 'ABS ', '/synthetic/focus/src/index.ts:2:3', false);
  expect(await resolves(page)).toEqual([]);
  await clickLink(page, 'ABS ', '/synthetic/focus/src/index.ts:2:3');
  await expect(page.getByLabel('唯讀內容：src/index.ts')).toBeVisible();
  await expect(page.locator('.explorer-status')).toContainText('已定位第 2 行、第 3 欄');
  const tabs = page.locator('.project-file-tabs-host'); await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath(`terminal-file-links-${zen ? 'zen' : 'normal'}.png`), fullPage: true });
  if (zen) await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeVisible();
  await page.locator('.workspace-tab-select').filter({ hasText: 'Focus shell' }).click();
  await clickLink(page, 'REL ', 'src/index.ts:3:4');
  await expect(page.getByRole('dialog', { name: '開啟終端輸出的檔案' })).toBeVisible();
  await expect(page.getByText('請選擇要開啟的檔案；不會自動採用第一筆。')).toBeVisible();
  if (!zen) await page.screenshot({ path: info.outputPath('terminal-file-links-candidates.png'), fullPage: true });
  await page.getByRole('button', { name: /src\/index.ts 啟動目錄候選/ }).click();
  await expect(page.locator('.explorer-status')).toContainText('已定位第 3 行、第 4 欄');
  await expect(tabs.getByRole('tab')).toHaveCount(1); await intact(page);
  const calls = await resolves(page);
  expect(calls.every(call => call.projectId === 'project-focus' && call.paneId === 'pane-focus' && call.runtimeId === 'runtime-focus')).toBe(true);
});
test('quoted Unicode paths, ambiguous names and keyboard path input preserve explicit choice', async ({ page }) => {
  await openWorkspace(page);
  await clickLink(page, 'SPACE ', '/synthetic/focus/src/中文 file(test).ts');
  await expect(page.getByLabel('唯讀內容：src/中文 file(test).ts')).toBeVisible();
  await expect(page.locator('.explorer-status')).toContainText('已定位第 2 行、第 2 欄');
  await page.locator('.workspace-tab-select').filter({ hasText: 'Focus shell' }).click();
  await clickLink(page, 'BARE ', 'same.ts:1');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'src/same.ts', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'other/same.ts', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const opener = page.getByRole('button', { name: '開啟終端檔案路徑', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  await dialog.getByLabel('檔案路徑（可含 :行:欄）').fill('src/index.ts:999:999');
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: /src\/index.ts 啟動目錄候選/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.explorer-status')).toContainText('超出範圍，已限制'); await intact(page);
});
test('OSC8 spoofed filenames reveal the actual target and never fall through to a local path', async ({ page }) => {
  await openWorkspace(page);
  await clickLink(page, 'OSC ', '/synthetic/focus/src/index.ts:4:1');
  await expect(page.getByRole('alert').filter({ hasText: '終端嵌入連結未開啟' })).toContainText('file:///outside/secret.ts');
  expect(await resolves(page)).toEqual([]);
  await clickLink(page, 'HTTP ', 'https://example.invalid/src/index.ts');
  expect(await resolves(page)).toEqual([]); await intact(page);
  await clickLink(page, 'BLOCK ', '/outside/secret.ts:1');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('路徑不在此終端所屬專案內');
  await expect(page.locator('.project-file-tabs-host [role="tab"]')).toHaveCount(0);
});
test('late results cannot open a file after navigation away and back', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: '開啟終端檔案路徑', exact: true }).click();
  await page.getByRole('textbox', { name: '檔案路徑（可含 :行:欄）' }).fill('slow.ts');
  await page.getByRole('button', { name: '尋找專案檔案' }).click();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).evaluate((element: HTMLButtonElement) => element.click());
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic focus' }).click();
  const focused = page.getByRole('button', { name: '開啟終端檔案路徑', exact: true });
  await focused.focus();
  await page.waitForTimeout(850);
  await expect(focused).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.project-file-tabs-host [role="tab"]')).toHaveCount(0);
  await expect(page.locator('.xterm:visible')).toHaveCount(1); await intact(page);
});
test('narrow keyboard dialog keeps full paths visible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 800 }); await openWorkspace(page);
  await page.getByRole('button', { name: '開啟終端檔案路徑', exact: true }).click();
  const input = page.getByRole('textbox', { name: '檔案路徑（可含 :行:欄）' });
  await input.fill('same.ts'); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'src/same.ts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('ordinary mouse drag still selects text for the keyboard-accessible path dialog', async ({ page }) => {
  await openWorkspace(page);
  const start = await point(page, 'ABS ', '/synthetic/focus/src/index.ts');
  const end = await point(page, 'ABS ', ':2:3');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x + 8, end.y, { steps: 8 }); await page.mouse.up();
  expect(await resolves(page)).toEqual([]);
  await page.getByRole('button', { name: '開啟終端檔案路徑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '檔案路徑（可含 :行:欄）' })).toHaveValue(/src\/index.ts/);
  expect(await resolves(page)).toEqual([]); await page.keyboard.press('Escape'); await intact(page);
});

test('partial and last-cell OSC8 attributes cannot shadow a file candidate while colored paths work', async ({ page }) => {
  await openWorkspace(page);
  await clickLink(page, 'OSC-PART ', '/synthetic/');
  await clickLink(page, 'OSC-TAIL ', '/synthetic/focus/src/index.ts:4:');
  expect(await resolves(page)).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await clickLink(page, 'COLOR ', '/synthetic/focus/src/index.ts:2:3');
  await expect(page.getByLabel('唯讀內容：src/index.ts')).toBeVisible();
  await expect(page.locator('.explorer-status')).toContainText('已定位第 2 行、第 3 欄'); await intact(page);
});

test('file and runtime tabs share rectangular geometry and active borders', async ({ page }) => {
  await openWorkspace(page);
  await clickLink(page, 'ABS ', '/synthetic/focus/src/index.ts:2:3');
  const style = (element: Element) => {
    const css = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, radius: css.borderRadius,
      border: css.borderTopWidth, borderStyle: css.borderTopStyle, color: css.borderTopColor, background: css.backgroundColor };
  };
  const file = await page.locator('.project-file-tab.active').evaluate(style);
  await page.locator('.workspace-tab-select').filter({ hasText: 'Focus shell' }).click();
  const runtime = await page.locator('.workspace-tab.active').evaluate(style);
  expect(file).toEqual(runtime);
  expect(runtime.radius).toBe('0px'); expect(runtime.border).toBe('2px');
  await intact(page);
});
