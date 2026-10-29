import { expect, test, type Page } from '@playwright/test';

const L = (en: string, zh: string) => test.info().project.name === 'zh-tw' ? zh : en;
const title = () => L('Add rate limiting to the upload endpoint', '為上傳 API 加上速率限制');
async function openBoard(page: Page, off = false) {
  await page.goto(`/tests/browser/showcase.html${off ? '?board=off' : ''}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.locator('.directory-card-main').first().click();
  await page.getByRole('button', { name: L('Board', '看板'), exact: true }).click();
  if (!off) await expect(page.locator('.kanban-card').first()).toBeVisible();
}
const column = (page: Page, index: number) => page.locator(`[data-kanban-column="column-${index}"]`);
const card = (page: Page, id: string) => page.locator(`[data-kanban-card="${id}"]`);

test('enables only a curated project board and preserves workspace terminals across navigation', async ({ page }, info) => {
  await openBoard(page, true);
  await page.getByRole('button', { name: L('Enable board', '啟用看板'), exact: true }).click();
  await expect(card(page, 'card-0')).toBeVisible();
  await expect(page.getByRole('heading', { name: L('Untitled task', '未命名工作') })).toBeVisible();
  await page.screenshot({ path: info.outputPath('project-board.png') });
  await page.locator('.workspace-tab-select').first().click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
  await page.getByRole('button', { name: L('Board', '看板'), exact: true }).click();
  await expect(card(page, 'card-0')).toBeVisible();
  await expect(page.getByRole('button', { name: L('Enable board', '啟用看板'), exact: true })).toHaveCount(0);
  await page.locator('#navigation-directories').click();
  await page.locator('.directory-card-main').filter({ hasText: 'notes-cli' }).click();
  await expect(page.getByRole('button', { name: L('Board', '看板'), exact: true })).toHaveCount(0);
});

test('moves and reorders tasks using keyboard and the menu, restoring focus and announcing moves', async ({ page }) => {
  await openBoard(page);
  const handle = card(page, 'card-0').locator('.kanban-card-handle');
  await handle.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(column(page, 0).locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-5');
  await expect(handle).toBeFocused();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(column(page, 1).locator('[data-kanban-card="card-0"]')).toBeVisible();
  await expect(page.locator('.project-board [role="status"]')).toContainText(title());
  const menu = card(page, 'card-0').getByRole('button', { name: L(`Move "${title()}"…`, `移動「${title()}」…`) });
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('menuitem', { name: L('Done', '完成'), exact: true }).click();
  await expect(column(page, 4).locator('[data-kanban-card="card-0"]')).toBeVisible();
  await expect(handle).toBeFocused();
});

test('pointer drag reorders tasks, moves across columns and into an empty column; Escape cancels', async ({ page }) => {
  await openBoard(page);
  const source = card(page, 'card-0').locator('.kanban-card-handle');
  const drag = async (destination: ReturnType<Page['locator']>, cancel = false) => {
    await destination.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();
    const start = (await source.boundingBox())!;
    const end = (await destination.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height - 8, { steps: 12 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drag(card(page, 'card-5'), true);
  await expect(column(page, 0).locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-0');
  await drag(card(page, 'card-5'));
  await expect(column(page, 0).locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-5');
  await drag(card(page, 'card-1'));
  await expect(column(page, 1).locator('[data-kanban-card="card-0"]')).toBeVisible();
  // Empty Review through the same explicit menu command before dropping into it.
  await card(page, 'card-3').scrollIntoViewIfNeeded();
  await card(page, 'card-3').locator('.kanban-move-menu button').click();
  await page.getByRole('menuitem', { name: L('Done', '完成'), exact: true }).click();
  // The board deliberately scrolls horizontally; put both source and target in view.
  await column(page, 3).scrollIntoViewIfNeeded();
  await drag(column(page, 3).locator('.kanban-card-list'));
  await expect(column(page, 3).locator('[data-kanban-card="card-0"]')).toBeVisible();
});

test('manages column names, stages, ordering and destination-required deletion', async ({ page }) => {
  await openBoard(page);
  await column(page, 0).getByRole('button', { name: L('Column settings: Unsorted', '欄位設定：未分類') }).click();
  await expect(page.getByRole('combobox', { name: L('Stage', '階段'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: L('Delete column', '刪除欄位'), exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: L('Close dialog', '關閉對話框') }).click();
  await page.getByRole('button', { name: L('Add column', '新增欄位'), exact: true }).click();
  await page.getByRole('textbox', { name: L('Column name', '欄位名稱') }).fill('Quality queue');
  await page.getByRole('dialog').getByRole('button', { name: L('Add column', '新增欄位'), exact: true }).click();
  await page.getByRole('button', { name: 'Column settings: Quality queue' }).or(page.getByRole('button', { name: '欄位設定：Quality queue' })).click();
  await page.getByRole('textbox', { name: L('Column name', '欄位名稱') }).fill('Final checks');
  await page.getByRole('button', { name: L('Rename column', '重新命名欄位') }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName(L('Column settings: Final checks', '欄位設定：Final checks'));
  await page.getByRole('combobox', { name: L('Stage', '階段'), exact: true }).selectOption('review');
  await expect(page.getByRole('combobox', { name: L('Stage', '階段'), exact: true })).toHaveValue('review');
  await page.getByRole('button', { name: L('Move left', '往左移') }).click();
  await expect(page.locator('.kanban-column').nth(4)).toContainText('Final checks');
  const remove = page.getByRole('button', { name: L('Delete column', '刪除欄位'), exact: true });
  await expect(remove).toBeDisabled();
  await page.getByRole('combobox', { name: L('Move tasks to', '將工作移至') }).selectOption('column-0');
  await remove.click();
  await expect(page.getByRole('heading', { name: 'Final checks', exact: true })).toHaveCount(0);
});

test('filters synthetic card notes and session titles with agent and attention', async ({ page }) => {
  await openBoard(page);
  const search = page.getByRole('searchbox', { name: L('Search board', '搜尋看板') });
  await search.fill('token bucket');
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  await search.fill('');
  await page.locator('.kanban-toolbar select').selectOption('codex');
  await expect(page.locator('.kanban-card')).toHaveCount(2);
  await page.getByRole('checkbox', { name: L('Needs attention', '需要處理') }).check();
  await expect(page.locator('.kanban-card')).toHaveCount(0);
  await expect(page.getByText(L('No tasks match the filters.', '沒有符合篩選條件的工作。'))).toBeVisible();
});
