import { expect, test, type Page } from '@playwright/test';

// Full App in Chrome; Git requests reach the real core over a synthetic repo.
const bridge = 'http://127.0.0.1:1441';
const inspect = async (page: Page) => (await (await page.request.post(`${bridge}/inspect`)).json()).ok as
  { index: string; log: string; status: string; conflictFile: string };
const panel = (page: Page) => page.locator('#activity-git-panel');
const gitButton = (page: Page) => page.locator('.workspace-activity-bar').getByRole('button', { name: 'Git', exact: true });

async function open(page: Page, query = '') {
  await page.request.post(`${bridge}/reset`);
  await page.goto(`/tests/browser/workspace-focus-mode.html?activity=1&git=${encodeURIComponent(bridge)}${query}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: /^開啟工作區 .* Focus shell$/ }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.evaluate(() => Object.assign(window, { gitOriginalTerminal: document.querySelector('.xterm') }));
  await gitButton(page).click();
  await expect(panel(page).getByRole('radiogroup', { name: '選擇 repository' })).toBeVisible();
}

const terminalPreserved = (page: Page) => page.evaluate(() =>
  (window as unknown as { gitOriginalTerminal: Element }).gitOriginalTerminal === document.querySelector('.xterm'));

test('stages one change of a hunk, commits it, and keeps the terminal', async ({ page }) => {
  await open(page);
  await expect(panel(page).getByRole('radio')).toContainText('repo');
  await expect(panel(page).getByRole('radio')).toContainText('main');
  await panel(page).getByRole('button', { name: /f\.txt，已修改/ }).click();
  const diff = page.locator('.git-document');
  await expect(diff.getByText('BETA').first()).toBeVisible();
  await diff.getByRole('button', { name: '行內檢視' }).click();
  await diff.getByRole('checkbox', { name: '選取刪除第 4 行' }).click();
  await diff.getByRole('checkbox', { name: '選取新增第 4 行' }).click();
  await diff.getByRole('button', { name: '暫存所選 2 行' }).click();
  await expect(diff.getByText('已暫存所選 2 行。')).toBeVisible();
  // Our own staging must not be reported as an external change.
  await page.waitForTimeout(3500);
  await expect(diff.getByText(/已在外部變更/)).toHaveCount(0);
  expect((await inspect(page)).index).toBe('alpha\nbeta\ngamma\nDELTA\n');
  await page.screenshot({ path: 'test-results/git/evidence-partial-stage.png' });

  const message = panel(page).getByLabel('Commit 訊息');
  await message.fill('Stage only delta');
  await panel(page).getByRole('button', { name: '檢視並 Commit' }).click();
  const dialog = page.getByRole('dialog', { name: '確認建立 commit' });
  await expect(dialog.getByText('f.txt')).toBeVisible();
  await expect(dialog.getByText(/未暫存的變更不會加入/)).toBeVisible();
  await dialog.getByRole('button', { name: '建立 commit' }).click();
  await expect(panel(page).getByText(/已建立 commit .*Stage only delta/)).toBeVisible();
  const state = await inspect(page);
  expect(state.log.split('\n')[0]).toMatch(/^Stage only delta /);
  expect(state.status).toContain(' M f.txt');
  expect(await terminalPreserved(page)).toBe(true);
});

test('merges with a conflict and resolves it in the app', async ({ page }) => {
  await open(page);
  await panel(page).locator('summary', { hasText: 'Branches' }).click();
  // The merge needs a clean tree: stash the fixture's edits first.
  await panel(page).locator('summary', { hasText: 'Stash' }).click();
  await panel(page).getByLabel('包含 untracked 檔案').check();
  await panel(page).getByRole('button', { name: 'Stash 變更' }).click();
  await expect(panel(page).getByText('工作目錄沒有變更。')).toBeVisible();
  await panel(page).getByRole('button', { name: '合併 topic 到 main' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '合併' }).click();
  await expect(panel(page).getByRole('region', { name: '合併進行中' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Continue' })).toBeDisabled();

  await panel(page).getByRole('button', { name: /conflict\.txt，雙方修改/ }).click();
  const view = page.locator('.git-conflict');
  await expect(view.getByText(/目前 branch（main）/).first()).toBeVisible();
  await view.getByRole('button', { name: '兩者（我方在前）' }).click();
  await expect(view.getByRole('button', { name: '標記為已解決' })).toBeDisabled();
  await view.getByRole('button', { name: '儲存結果' }).click();
  await expect(view.getByText('已儲存結果；尚未標記為已解決。')).toBeVisible();
  await view.getByRole('button', { name: '標記為已解決' }).click();
  await expect(view.getByText(/標記為已解決/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/git/evidence-conflict.png' });
  await expect(panel(page).getByRole('button', { name: 'Continue' })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Continue' }).click();
  await expect(panel(page).getByRole('region', { name: '合併進行中' })).toHaveCount(0);
  const state = await inspect(page);
  expect(state.conflictFile).toBe('main line\ntopic line\n');
  expect(state.log.split('\n')[0].split(' ').filter(part => /^[0-9a-f]{40}$/.test(part))).toHaveLength(2);
  expect(await terminalPreserved(page)).toBe(true);
});

test('history graph, keyboard toggle, Zen Mode and narrow windows', async ({ page }) => {
  await open(page);
  await panel(page).getByRole('button', { name: '開啟歷史 graph' }).click();
  const graph = page.getByRole('listbox', { name: 'Commit 歷史' });
  await expect(graph.getByRole('option')).toHaveCount(3);
  await expect(page.locator('.git-graph-cell').first()).toBeVisible();
  await graph.getByRole('option').first().click();
  await page.keyboard.press('ArrowDown');
  await expect(graph.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.git-commit-panel')).toBeVisible();

  // Tooltip names the real shortcut; the shortcut toggles the panel.
  await gitButton(page).hover();
  await expect(page.getByRole('tooltip')).toContainText(/Git.*(⌘|Ctrl|Meta|Mod).*G/i);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${mod}+Shift+G`);
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press(`${mod}+Shift+G`);
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: /f\.txt/ }).first().focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(gitButton(page)).toBeFocused();

  await page.getByRole('button', { name: '進入專注模式' }).click();
  await gitButton(page).click();
  await expect(panel(page).getByRole('radiogroup', { name: '選擇 repository' })).toBeVisible();
  await page.screenshot({ path: 'test-results/git/evidence-zen.png' });

  for (const viewport of [{ width: 900, height: 700 }, { width: 760, height: 600 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = (await page.locator('.activity-panel-shell:visible').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await page.screenshot({ path: 'test-results/git/evidence-narrow.png' });
  expect(await terminalPreserved(page)).toBe(true);
});

test('light theme and long names stay readable', async ({ page }) => {
  await open(page, '&theme=light&long=1');
  await panel(page).getByRole('button', { name: /notes\.txt，未追蹤/ }).click();
  await expect(page.locator('.git-document').getByText('untracked')).toBeVisible();
  const contrast = await page.locator('.git-change-name').first().evaluate(element => getComputedStyle(element).color);
  expect(contrast).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: 'test-results/git/evidence-light.png' });
});

test('long paths, long branch names and shared panel resize at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page);
  // The full path stays in the accessible name even when the label is truncated.
  const longFile = panel(page).getByRole('button', { name: /^deeply\/nested\/directory\/.*synthetic-file-with-an-intentionally-long-name-for-ellipsis\.txt，未追蹤/ });
  await expect(longFile).toBeVisible();
  await panel(page).getByText('Branches', { exact: true }).click();
  const longBranch = panel(page).getByRole('button', { name: /^切換到 feature\/very-long-branch-name-for-narrow-layout-checks-with-many-segments$/ });
  await expect(longBranch).toBeVisible();

  const shell = page.locator('.activity-panel-shell:visible');
  const separator = page.getByRole('separator', { name: '調整功能面板寬度' });
  const widthOf = async () => (await shell.boundingBox())!.width;
  const start = await widthOf();
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(widthOf).toBeGreaterThan(start);
  const wider = await widthOf();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(widthOf).toBeLessThan(wider);
  // Pointer drag narrows the shared panel as far as it allows.
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 400, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();

  for (const viewport of [{ width: 900, height: 700 }, { width: 760, height: 600 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Long names truncate inside the panel instead of widening it.
    const overflow = await page.locator('#activity-git-panel').evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    for (const item of [longFile, longBranch]) {
      const box = (await item.boundingBox())!;
      const shellBox = (await shell.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(shellBox.x + shellBox.width + 1);
    }
  }
  await page.screenshot({ path: 'test-results/git/evidence-long-names.png' });
  expect(await terminalPreserved(page)).toBe(true);
});
