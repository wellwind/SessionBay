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

test('edits task details, retains notes, traps focus and restores the opener', async ({ page }, info) => {
  await openBoard(page);
  const opener = card(page, 'card-0').locator('.kanban-card-open');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: L('Task details', '工作詳情') });
  await expect(dialog.getByRole('textbox', { name: L('Task title', '工作標題') })).toBeFocused();
  const lastControl = dialog.locator('summary');
  await lastControl.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: L('Close dialog', '關閉對話框') })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastControl).toBeFocused();
  await dialog.getByRole('textbox', { name: L('Task title', '工作標題') }).fill('Synthetic revised task');
  await dialog.getByRole('textbox', { name: L('Notes', '備註'), exact: true }).fill('Plan the change\n\nReview before sending');
  await expect(dialog.getByRole('button', { name: L('Start work', '開始工作'), exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: L('Save changes', '儲存變更'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: L('Save changes', '儲存變更'), exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('task-details.png') });
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.getByRole('textbox', { name: L('Notes', '備註'), exact: true })).toHaveValue('Plan the change\n\nReview before sending');
});

test('archives and restores a Done task, then deletes it without recycling sessions', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await page.getByRole('button', { name: L('Archive task', '封存工作'), exact: true }).click();
  await expect(card(page, 'card-4')).toHaveCount(0);
  await page.getByRole('button', { name: L('Archived tasks', '已封存工作'), exact: true }).click();
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await page.getByRole('button', { name: L('Restore task', '還原工作'), exact: true }).click();
  await page.getByRole('button', { name: L('Archived tasks', '已封存工作'), exact: true }).click();
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await page.getByRole('button', { name: L('Delete task', '刪除工作'), exact: true }).click();
  await page.getByRole('combobox', { name: L('Attached sessions', '附加的 Sessions') }).selectOption('detach');
  await page.getByRole('dialog').getByRole('button', { name: L('Delete task', '刪除工作'), exact: true }).click();
  await expect(card(page, 'card-4')).toHaveCount(0);
});

test('merges by dropping on a card center with confirmation, then splits the attached session', async ({ page }) => {
  await openBoard(page);
  const source = card(page, 'card-0').locator('.kanban-card-handle'), destination = card(page, 'card-5');
  const start = (await source.boundingBox())!, end = (await destination.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: L('Merge tasks?', '合併工作？') })).toBeVisible();
  await expect(card(page, 'card-0')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: L('Merge tasks', '合併工作'), exact: true }).click();
  await expect(card(page, 'card-0')).toHaveCount(0);
  await destination.locator('.kanban-card-open').click();
  await expect(page.locator('.kanban-detail-sessions li')).toHaveCount(2);
  await page.locator('.kanban-detail-sessions li').filter({ hasText: title() }).getByRole('button', { name: L('Split into new task', '拆分為新工作') }).click();
  await expect(page.locator('.kanban-detail-sessions li')).toHaveCount(1);
});

test('recycles attached sessions only after the existing per-session confirmation', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await page.getByRole('button', { name: L('Recycle attached sessions…', '將附加的 Sessions 移至資源回收筒…') }).click();
  await expect(page.getByRole('dialog', { name: L('Move to the recycle bin?', '移入資源回收筒？') })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: L('Move to recycle bin', '確認移入資源回收筒'), exact: true }).click();
  await expect(page.getByText(L('No sessions attached. Start work to attach a new session.', '尚未附加 Session。開始工作即可附加新的 Session。'))).toBeVisible();
});

test('starts an agent from the existing launcher and pastes task text without submitting', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-0').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  const launcher = page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') });
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  await expect(page.getByText(L('Task text inserted, not sent. Review it before pressing Enter.', '已插入工作內容，尚未送出。請先檢查，再按 Enter。'))).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { kanbanCalls: { command: string; args: Record<string, unknown> }[] }).kanbanCalls);
  const launches = calls.filter(call => call.command === 'launch_fresh_runtime');
  expect(launches).toHaveLength(1);
  expect(launches[0].args.request).toMatchObject({ kanbanCardId: 'card-0', cwd: '/Users/you/code/harbor-api' });
  const bytes = calls.filter(call => call.command === 'write_runtime').map(call => String(call.args.data)).join('');
  expect(bytes.replace(/\r/g, '\n')).toBe('\x1b[200~' + title() + '\n\nSynthetic planning notes: token bucket' + '\x1b[201~');
});

test('resumes the selected attached session through the workbench flow', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-2').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Resume', '接續'), exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const calls = (window as unknown as { kanbanCalls: { command: string; args: { request?: { sessionId?: string } } }[] }).kanbanCalls;
    return calls.filter(call => call.command === 'launch_runtime').map(call => call.args.request?.sessionId);
  })).toContain('s-harbor-2');
});

test('starts a plain shell for a planned task without sending its text', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-0').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  const launcher = page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') });
  await launcher.getByRole('button', { name: /^Shell/ }).click();
  await launcher.getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  await expect(page.getByText(L('Task text inserted, not sent. Review it before pressing Enter.', '已插入工作內容，尚未送出。請先檢查，再按 Enter。'))).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { kanbanCalls: { command: string; args: Record<string, unknown> }[] }).kanbanCalls);
  expect(calls.find(call => call.command === 'launch_runtime')?.args.request).toMatchObject({ kind: 'shell', kanbanCardId: 'card-0' });
  const bytes = calls.filter(call => call.command === 'write_runtime').map(call => String(call.args.data)).join('');
  expect(bytes.startsWith('\x1b[200~')).toBe(true);
  expect(bytes.endsWith('\x1b[201~')).toBe(true);
});

async function openAllBoards(page: Page) {
  await page.goto('/tests/browser/showcase.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: L('All boards', '全部看板'), exact: true }).click();
  await expect(card(page, 'web-task')).toBeVisible();
}
const stage = (page: Page, name: string) => page.locator(`[data-kanban-column="${name}"]`);

test('all boards groups enabled projects by stage, combines filters and keeps terminals mounted', async ({ page }, info) => {
  await openAllBoards(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(L('All boards', '全部看板'));
  await expect(page.locator('.kanban-column')).toHaveCount(5);
  await expect(card(page, 'web-archived')).toHaveCount(0);
  await expect(card(page, 'web-task').locator('.project-initials')).toHaveText('WD');
  await expect(stage(page, 'todo')).toContainText(L('Polish the dashboard filters', '改善儀表板篩選功能'));
  const project = page.getByRole('combobox', { name: L('Project', '專案'), exact: true });
  await expect(project.locator('option')).toHaveCount(3);
  await project.selectOption('p-web');
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  const search = page.getByRole('searchbox', { name: L('Search board', '搜尋看板') });
  await search.fill('dashboard planning');
  await expect(card(page, 'web-task')).toBeVisible();
  await project.selectOption('p-harbor');
  await expect(page.getByText(L('No tasks match the filters.', '沒有符合篩選條件的工作。'))).toBeVisible();
  await search.fill('token bucket');
  await expect(card(page, 'card-0')).toBeVisible();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
  await expect(page.locator('.kanban-card')).toHaveCount(0);
  await search.fill('');
  await expect(page.locator('.kanban-card')).toHaveCount(2);
  await page.getByRole('checkbox', { name: L('Needs attention', '需要處理') }).check();
  await expect(page.locator('.kanban-card')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('all-boards-filters.png') });
  await page.locator('.sidebar-global', { hasText: L('All workspaces', '全部工作區') }).click();
  await expect(page.locator('.overview-card').first()).toBeVisible();
  await page.getByRole('button', { name: L('All boards', '全部看板'), exact: true }).click();
  await expect(card(page, 'web-task')).toBeVisible();
  await page.getByRole('button', { name: L('Open workspace harbor-api Rate limiting', '開啟工作區 harbor-api 速率限制') }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
});

test('all boards moves through keyboard and menu into the project’s first matching column', async ({ page }) => {
  await openAllBoards(page);
  const handle = card(page, 'web-task').locator('.kanban-card-handle');
  await handle.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(stage(page, 'doing').locator('[data-kanban-card="web-task"]')).toBeVisible();
  await expect(handle).toBeFocused();
  await card(page, 'web-task').locator('.kanban-move-menu button').click();
  await expect(page.getByRole('menuitem', { name: L('Move up', '往上移'), exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: L('Todo', '待辦'), exact: true }).click();
  await expect(stage(page, 'todo').locator('[data-kanban-card="web-task"]')).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { kanbanCalls: { command: string; args: Record<string, unknown> }[] }).kanbanCalls);
  expect(calls.filter(call => call.command === 'move_kanban_card').map(call => call.args)).toEqual([
    { cardId: 'web-task', columnId: 'web-column-2', position: 0 },
    { cardId: 'web-task', columnId: 'web-column-1', position: 1 },
  ]);
  // Inspect the project board to verify the persisted column and unchanged project.
  await page.locator('#navigation-projects').click();
  await page.locator('.directory-card-main').filter({ hasText: 'web-dashboard' }).click();
  await page.getByRole('button', { name: L('Board', '看板'), exact: true }).click();
  await expect(page.locator('[data-kanban-column="web-column-1"] [data-kanban-card="web-task"]')).toBeVisible();
});

test('all boards pointer drop on another project changes only stage; Escape cancels', async ({ page }) => {
  await openAllBoards(page);
  const source = card(page, 'card-0').locator('.kanban-card-handle'), target = card(page, 'web-task');
  const drag = async (cancel: boolean) => {
    // Taller zh-TW cards can push the target below its column's scroll viewport.
    await target.scrollIntoViewIfNeeded();
    const start = (await source.boundingBox())!, end = (await target.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await drag(true);
  await expect(stage(page, 'unsorted').locator('[data-kanban-card="card-0"]')).toBeVisible();
  await drag(false);
  await expect(stage(page, 'todo').locator('[data-kanban-card="card-0"]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card(page, 'card-0').locator('.kanban-project')).toContainText('harbor-api');
  const calls = await page.evaluate(() => (window as unknown as { kanbanCalls: { command: string; args: Record<string, unknown> }[] }).kanbanCalls);
  expect(calls.filter(call => call.command === 'move_kanban_card').map(call => call.args)).toEqual([
    { cardId: 'card-0', columnId: 'column-1', position: 3 },
  ]);
  expect(calls.some(call => call.command === 'merge_kanban_cards')).toBe(false);
});

test('all boards reuses task details and starts work in the owning project', async ({ page }) => {
  await openAllBoards(page);
  await card(page, 'web-task').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  const launcher = page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') });
  await launcher.getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as {
    kanbanCalls: { command: string; args: { request?: Record<string, unknown> } }[];
  }).kanbanCalls.find(call => call.command === 'launch_fresh_runtime')?.args.request)).toMatchObject({
    kanbanCardId: 'web-task', projectId: 'p-web', cwd: '/Users/you/code/web-dashboard',
  });
});
