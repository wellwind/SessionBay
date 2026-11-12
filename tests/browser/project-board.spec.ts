import { expect, test, type Page } from '@playwright/test';
import { openFullBoard } from './board-navigation';

const L = (en: string, zh: string) => test.info().project.name === 'zh-tw' ? zh : en;
const title = () => L('Add rate limiting to the upload endpoint', '為上傳 API 加上速率限制');
// Showcase fixture: card-0 and card-5 are suggestions; card-1, card-6 and an empty task are Todo; card-2 In progress; card-3 Review; card-4 Done.
async function openBoard(page: Page) {
  await page.goto('/tests/browser/showcase.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.locator('.directory-card-main').first().click();
  await openFullBoard(page);
  await expect(page.locator('.kanban-card').first()).toBeVisible();
}
const stage = (page: Page, name: string) => page.locator(`.project-board [data-kanban-column="${name}"]`);
const card = (page: Page, id: string) => page.locator(`.project-board [data-kanban-card="${id}"]`);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { kanbanCalls: { command: string; args: Record<string, unknown> }[] }).kanbanCalls);

async function moveInDrawer(page: Page, id: string, columnId: string) {
  await card(page, id).locator('.kanban-card-open').click();
  const select = page.getByRole('dialog').getByRole('combobox', { name: L('Stage', '階段'), exact: true });
  await select.selectOption(columnId);
  await expect(select).toBeEnabled();
  await page.getByRole('dialog').getByRole('button', { name: L('Close dialog', '關閉對話框') }).click();
}
async function filter(page: Page, label: string, value: string) {
  const select = page.getByRole('combobox', { name: label, exact: true });
  if (!await select.isVisible()) await page.locator('.kanban-toolbar').getByRole('button', { name: L('Filter', '篩選'), exact: true }).click();
  await select.selectOption(value);
}
async function taskAction(page: Page, label: string) {
  await page.getByRole('dialog').getByRole('button', { name: L('Task actions', '任務操作') }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
async function drag(page: Page, source: ReturnType<Page['locator']>, destination: ReturnType<Page['locator']>, cancel = false) {
  await destination.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const start = (await source.boundingBox())!, end = (await destination.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height - 8, { steps: 12 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('enables a curated project board from the Focus panel and preserves terminals across navigation', async ({ page }, info) => {
  await page.goto('/tests/browser/showcase.html?board=off');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.locator('.directory-card-main').first().click();
  // The tab bar has no Board entry; the Focus panel and the palette open the board.
  await expect(page.locator('.workspace-tab-bar').getByRole('button', { name: L('Board', '看板'), exact: true })).toHaveCount(0);
  await page.locator('.workspace-activity[data-activity-id="board"]').click();
  await page.locator('.board-activity').getByRole('button', { name: L('Enable board', '啟用看板'), exact: true }).click();
  await openFullBoard(page);
  await expect(card(page, 'card-1')).toBeVisible();
  await expect(page.locator('.kanban-column')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: L('Untitled task', '未命名任務') })).toBeVisible();
  await page.screenshot({ path: info.outputPath('project-board.png') });
  await page.locator('.workspace-tab-select').first().click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible();
  await expect(page.locator('.project-board')).toHaveCount(0);
  await openFullBoard(page);
  await expect(card(page, 'card-1')).toBeVisible();
  await page.locator('#navigation-directories').click();
  await page.locator('.directory-card-main').filter({ hasText: 'notes-cli' }).click();
  await expect(page.locator('.workspace-activity[data-activity-id="board"]')).toBeDisabled();
});

test('files suggestions: make a task, add to a task, or dismiss', async ({ page }) => {
  await openBoard(page);
  await expect(page.locator('.kanban-suggestion')).toHaveCount(2);
  await card(page, 'card-5').getByRole('button', { name: L('Make it a task', '設為任務') }).click();
  await expect(stage(page, 'todo').locator('[data-kanban-card="card-5"]')).toBeVisible();
  await card(page, 'card-0').locator('.kanban-menu-trigger').click();
  await page.locator('.kanban-menu').getByRole('button').first().click();
  await expect(page.locator('.kanban-suggestions')).toHaveCount(0);
  const log = await calls(page);
  expect(log.some(call => call.command === 'attach_kanban_session' && call.args.sessionId === 's-harbor-0')).toBe(true);
  expect(log.some(call => call.command === 'delete_kanban_card' && call.args.cardId === 'card-0' && call.args.sessions === 'detach')).toBe(true);
  expect(log.some(call => call.command === 'merge_kanban_cards')).toBe(false);
});

test('moves and reorders tasks using keyboard and the drawer, restoring focus and announcing moves', async ({ page }) => {
  await openBoard(page);
  const opener = card(page, 'card-1').locator('.kanban-card-open');
  await opener.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(stage(page, 'todo').locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-6');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(stage(page, 'doing').locator('[data-kanban-card="card-1"]')).toBeVisible();
  await expect(page.locator('.project-board .organization-sr-only[role="status"]')).toContainText(L('Fix flaky retry test', '修正 payments client'));
  await moveInDrawer(page, 'card-1', 'column-4');
  await expect(stage(page, 'done').locator('[data-kanban-card="card-1"]')).toBeVisible();
  await expect(card(page, 'card-1').locator('.kanban-card-open')).toBeFocused();
});

test('pointer drag reorders tasks and moves them across and into an empty column; Escape cancels', async ({ page }) => {
  await openBoard(page);
  const source = card(page, 'card-1');
  await drag(page, source, card(page, 'card-6'), true);
  await expect(stage(page, 'todo').locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-1');
  await drag(page, source, card(page, 'card-6'));
  await expect(stage(page, 'todo').locator('[data-kanban-card]').first()).toHaveAttribute('data-kanban-card', 'card-6');
  await drag(page, source, card(page, 'card-2'));
  await expect(stage(page, 'doing').locator('[data-kanban-card="card-1"]')).toBeVisible();
  await moveInDrawer(page, 'card-3', 'column-4');
  await drag(page, source, stage(page, 'review').locator('.kanban-card-list'));
  await expect(stage(page, 'review').locator('[data-kanban-card="card-1"]')).toBeVisible();
  expect((await calls(page)).some(call => call.command === 'merge_kanban_cards')).toBe(false);
});

test('renames a column; columns cannot be added or deleted', async ({ page }) => {
  await openBoard(page);
  await stage(page, 'review').getByRole('button', { name: L('Column actions: Review', '欄位操作：待審查') }).click();
  await expect(page.getByRole('button', { name: L('Delete…', '刪除…'), exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: L('Rename…', '重新命名…'), exact: true }).click();
  await page.getByRole('textbox', { name: L('Column name', '欄位名稱') }).fill('Final checks');
  await page.getByRole('button', { name: L('Rename column', '重新命名欄位') }).click();
  await expect(page.getByRole('heading', { name: 'Final checks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: L('Board actions', '看板操作') }).click();
  await expect(page.getByRole('button', { name: L('Add column…', '新增欄位…') })).toHaveCount(0);
});

test('filters cards and suggestions by notes, session titles and agent', async ({ page }) => {
  await openBoard(page);
  const search = page.getByRole('searchbox', { name: L('Search board', '搜尋看板') });
  await search.fill('token bucket');
  await expect(page.locator('.project-board .kanban-card')).toHaveCount(0);
  await expect(page.locator('.kanban-suggestion')).toHaveCount(1);
  await search.fill('');
  await filter(page, 'Agent', 'codex');
  await expect(page.locator('.project-board .kanban-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: new RegExp('^' + L('Needs attention', '需要處理')) })).toHaveCount(0);
});

test('autosaves task details, traps focus and restores the opener', async ({ page }, info) => {
  await openBoard(page);
  const opener = card(page, 'card-1').locator('.kanban-card-open');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: L('Task', '任務') });
  await expect(dialog.getByRole('textbox', { name: L('Title', '標題'), exact: true })).toBeFocused();
  const firstControl = dialog.getByRole('combobox', { name: L('Stage', '階段'), exact: true });
  await firstControl.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(firstControl).toBeFocused();
  await dialog.getByRole('textbox', { name: L('Title', '標題'), exact: true }).fill('Synthetic revised task');
  await dialog.getByRole('textbox', { name: L('Notes', '備註'), exact: true }).fill('Plan the change\n\nReview before sending');
  await expect(dialog.getByText(L('Saved', '已儲存'), { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: L('Save', '儲存'), exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('task-details.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toHaveText('Synthetic revised task');
  await opener.click();
  await expect(dialog.getByRole('textbox', { name: L('Notes', '備註'), exact: true })).toHaveValue('Plan the change\n\nReview before sending');
});

test('archives a Done task, restores it from the Done column link, then deletes it', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await taskAction(page, L('Archive task', '封存任務'));
  await expect(card(page, 'card-4')).toHaveCount(0);
  await stage(page, 'done').getByRole('button', { name: new RegExp(L('Archived', '已封存')) }).click();
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await page.getByRole('button', { name: L('Restore task', '還原任務'), exact: true }).click();
  await page.getByRole('button', { name: L('Back to board', '返回看板') }).click();
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await taskAction(page, L('Delete task…', '刪除任務…'));
  await page.getByRole('combobox', { name: L('Attached sessions', '附加的 Sessions') }).selectOption('detach');
  await page.getByRole('dialog').getByRole('button', { name: L('Delete task', '刪除任務'), exact: true }).click();
  await expect(card(page, 'card-4')).toHaveCount(0);
});

test('merges through the task menu with confirmation, then splits the attached session', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-1').locator('.kanban-card-open').click();
  await taskAction(page, L('Merge into another task…', '合併到其他任務…'));
  await page.getByRole('combobox', { name: L('Merge into task', '合併到任務') }).selectOption('card-6');
  await page.getByRole('dialog').getByRole('button', { name: L('Merge tasks', '合併任務'), exact: true }).click();
  await page.getByRole('dialog', { name: L('Merge tasks?', '合併任務？') }).getByRole('button', { name: L('Merge tasks', '合併任務'), exact: true }).click();
  await expect(card(page, 'card-1')).toHaveCount(0);
  await card(page, 'card-6').locator('.kanban-card-open').click();
  await expect(page.locator('.kanban-detail-sessions li')).toHaveCount(2);
  await page.locator('.kanban-detail-sessions li').first().getByRole('button', { name: /^(Session actions|Session 操作)/ }).click();
  await page.getByRole('button', { name: L('Split into new task', '拆成新任務') }).click();
  await expect(page.locator('.kanban-detail-sessions li')).toHaveCount(1);
});

test('recycles attached sessions only after the existing per-session confirmation', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-4').locator('.kanban-card-open').click();
  await taskAction(page, L('Recycle attached sessions…', '將附加的 Sessions 移至資源回收筒…'));
  await expect(page.getByRole('dialog', { name: L('Move to the recycle bin?', '移入資源回收筒？') })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: L('Move to recycle bin', '確認移入資源回收筒'), exact: true }).click();
  await expect(page.getByText(L('No sessions yet. Start work and the new session is attached here.', '還沒有 Session。開始工作後，新的 Session 會附加在這裡。'))).toBeVisible();
});

test('starts a new agent session for a Todo task, moves it to In progress and pastes task text without submitting', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-1').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('More ways to start', '其他開始方式') }).click();
  await page.getByRole('button', { name: L('Start a new session', '開新 Session'), exact: true }).click();
  const launcher = page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') });
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  await expect(page.getByText(L('Task text inserted, not sent. Review it before pressing Enter.', '已插入任務內容，尚未送出。請先檢查，再按 Enter。'))).toBeVisible();
  const log = await calls(page);
  expect(log.filter(call => call.command === 'move_kanban_card').map(call => call.args)).toEqual([{ cardId: 'card-1', columnId: 'column-2', position: 1 }]);
  const launches = log.filter(call => call.command === 'launch_fresh_runtime');
  expect(launches).toHaveLength(1);
  expect(launches[0].args.request).toMatchObject({ kanbanCardId: 'card-1', cwd: '/Users/you/code/harbor-api' });
  const bytes = log.filter(call => call.command === 'write_runtime').map(call => String(call.args.data)).join('');
  expect(bytes.startsWith('\x1b[200~' + L('Fix flaky retry test', '修正 payments client'))).toBe(true);
  expect(bytes.endsWith('\x1b[201~')).toBe(true);
});

test('continues the latest attached session as the primary action', async ({ page }) => {
  await openBoard(page);
  await card(page, 'card-2').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Continue with OpenCode', '繼續 OpenCode 工作') }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'launch_runtime')
    .map(call => (call.args.request as { sessionId?: string } | undefined)?.sessionId)).toContain('s-harbor-2');
});

test('starts a plain shell for a planned task without sending its text', async ({ page }) => {
  await openBoard(page);
  await card(page, 'empty-task').locator('.kanban-card-open').click();
  await page.getByRole('dialog').getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  const launcher = page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') });
  await launcher.getByRole('button', { name: /^Shell/ }).click();
  await launcher.getByRole('button', { name: L('Start work', '開始工作'), exact: true }).click();
  await expect.poll(async () => (await calls(page)).find(call => call.command === 'launch_runtime')?.args.request).toMatchObject({ kind: 'shell', kanbanCardId: 'empty-task' });
});

test('the focus panel lists in-progress work and starts the next task', async ({ page }) => {
  await openBoard(page);
  await page.locator('.workspace-activity[data-activity-id="board"]').click();
  const panel = page.locator('.board-activity');
  await expect(panel.getByRole('region', { name: L('In progress', '進行中') }).locator('.focus-card')).toHaveCount(1);
  await panel.getByRole('region', { name: L('Up next', '接下來') }).getByRole('button', { name: L('Start', '開始'), exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: L('Start a new task', '開始新的工作') })).toBeVisible();
  await expect(panel.getByRole('region', { name: L('In progress', '進行中') }).locator('.focus-card')).toHaveCount(2);
  const geometry = await panel.evaluate(element => {
    const list = element.querySelector('.board-activity-groups')!;
    return { panelBottom: element.getBoundingClientRect().bottom, listBottom: list.getBoundingClientRect().bottom, overflow: getComputedStyle(list).overflowY };
  });
  expect(geometry.listBottom).toBeLessThanOrEqual(geometry.panelBottom);
  expect(geometry.overflow).toBe('auto');
});

/** Waits until a locator's box is unchanged across two frames and its entrance/reorder animations have finished. */
async function settledBox(locator: ReturnType<Page['locator']>) {
  let previous = '';
  await expect.poll(async () => {
    await locator.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))));
    const box = JSON.stringify(await locator.boundingBox());
    const stable = box === previous;
    previous = box;
    return stable;
  }).toBe(true);
  return (await locator.boundingBox())!;
}

async function openAllBoards(page: Page) {
  await page.goto('/tests/browser/showcase.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: L('All boards', '全部看板'), exact: true }).click();
  await expect(card(page, 'web-task')).toBeVisible();
}

test('all boards shows enabled projects by stage, switches scope and keeps terminals mounted', async ({ page }, info) => {
  await openAllBoards(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(L('All boards', '全部看板'));
  await expect(page.locator('.kanban-column')).toHaveCount(4);
  await expect(card(page, 'web-archived')).toHaveCount(0);
  await expect(card(page, 'web-task').locator('.project-initials')).toContainText('WD');
  await expect(stage(page, 'todo')).toContainText(L('Polish the dashboard filters', '改善儀表板篩選功能'));
  const search = page.getByRole('searchbox', { name: L('Search board', '搜尋看板') });
  await search.fill('dashboard planning');
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  await search.fill('');
  await page.screenshot({ path: info.outputPath('all-boards.png') });
  await page.getByRole('combobox', { name: L('Board scope', '看板範圍') }).selectOption('p-web');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('web-dashboard');
  await expect(page.locator('.project-board')).toBeVisible();
  await expect(page.getByRole('heading', { name: L('Ready to build', '準備開發'), exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: L('Board scope', '看板範圍') }).selectOption('');
  await expect(card(page, 'card-1')).toBeVisible();
  await page.locator('.sidebar-global', { hasText: L('All workspaces', '全部工作區') }).click();
  await expect(page.locator('.overview-card').first()).toBeVisible();
});

test('all boards moves through keyboard and the drawer within the owning project', async ({ page }) => {
  await openAllBoards(page);
  const opener = card(page, 'web-task').locator('.kanban-card-open');
  await opener.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(stage(page, 'doing').locator('[data-kanban-card="web-task"]')).toBeVisible();
  await expect(opener).toBeFocused();
  await moveInDrawer(page, 'web-task', 'web-column-1');
  await expect(stage(page, 'todo').locator('[data-kanban-card="web-task"]')).toBeVisible();
  expect((await calls(page)).filter(call => call.command === 'move_kanban_card').map(call => call.args)).toEqual([
    { cardId: 'web-task', columnId: 'web-column-2', position: 0 },
    // The archived web task still counts in the destination's catalog order.
    { cardId: 'web-task', columnId: 'web-column-1', position: 1 },
  ]);
});

test('all boards pointer drop on another project changes only stage; Escape cancels', async ({ page }) => {
  await openAllBoards(page);
  const source = card(page, 'card-2'), target = card(page, 'web-task');
  await drag(page, source, target, true);
  await expect(stage(page, 'doing').locator('[data-kanban-card="card-2"]')).toBeVisible();
  await drag(page, source, target);
  await expect(stage(page, 'todo').locator('[data-kanban-card="card-2"]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await calls(page)).filter(call => call.command === 'move_kanban_card').map(call => call.args)).toEqual([
    { cardId: 'card-2', columnId: 'column-1', position: 3 },
  ]);
});

for (const mode of ['project', 'all-none', 'all-project'] as const) {
  test(`${mode} keeps column lists and quick-add within the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (mode === 'project') await openBoard(page);
    else {
      await openAllBoards(page);
      if (mode === 'all-project') await page.getByRole('combobox', { name: L('Group by', '分組依據') }).selectOption('project');
    }
    const boards = page.locator('.kanban-columns');
    for (let index = 0; index < await boards.count(); index++) {
      if (mode === 'all-project') await boards.nth(index).scrollIntoViewIfNeeded();
      const geometry = await boards.nth(index).evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { bottom: bounds.bottom, lists: [...element.querySelectorAll<HTMLElement>('.kanban-card-list')].map(list => ({
          height: list.clientHeight, bottom: list.getBoundingClientRect().bottom, overflow: getComputedStyle(list).overflowY,
        })), headers: [...element.querySelectorAll('.kanban-column-header')].map(header => header.getBoundingClientRect().height) };
      });
      const statusTop = (await page.locator('.statusbar').boundingBox())!.y;
      expect(geometry.bottom).toBeLessThanOrEqual(statusTop);
      for (const list of geometry.lists) {
        expect(list.height).toBeGreaterThan(0);
        expect(list.bottom).toBeLessThanOrEqual(geometry.bottom);
        expect(list.overflow).toBe('auto');
      }
      for (const height of geometry.headers) expect(height).toBeLessThanOrEqual(42);
    }
    if (mode === 'project') {
      const quickAdd = stage(page, 'todo').locator('.kanban-quick-add');
      expect((await quickAdd.boundingBox())!.y + (await quickAdd.boundingBox())!.height)
        .toBeLessThanOrEqual((await page.locator('.statusbar').boundingBox())!.y);
    }
  });
}

test('dragging near the horizontal edge scrolls to off-screen columns and Escape stops scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await openAllBoards(page);
  const scroller = page.locator('.kanban-columns');
  // All boards fills in project by project; press only once the card has stopped moving.
  const source = await settledBox(card(page, 'card-1'));
  const bounds = (await scroller.boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 5, source.y + 12, { steps: 10 });
  await expect(card(page, 'card-1')).toHaveClass(/kanban-dragging/);
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  const stopped = await scroller.evaluate(element => element.scrollLeft);
  await page.waitForTimeout(100);
  expect(await scroller.evaluate(element => element.scrollLeft)).toBe(stopped);
  await page.mouse.up();
  await expect(stage(page, 'todo').locator('[data-kanban-card="card-1"]')).toHaveCount(1);
});

test('reduced motion keeps the board static while still showing new cards', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBoard(page);
  const translate = await card(page, 'card-1').evaluate(element => getComputedStyle(element).translate);
  expect(['none', '0px']).toContain(translate);
  await card(page, 'card-1').locator('.kanban-card-open').click();
  expect(await page.locator('.dialog-drawer').evaluate(element => getComputedStyle(element).animationName)).toBe('kanban-fade');
});
