import { expect, test, type Page } from '@playwright/test';
import type { SessionQuery } from '../../src/types';

type Call = { command: string; data?: string; query?: SessionQuery };
const calls = (page: Page) => page.evaluate(() =>
  (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls);
const sessionsButton = (page: Page) => page.getByRole('button', { name: '歷史 Sessions', exact: true });
const filesButton = (page: Page) => page.getByRole('button', { name: 'Files', exact: true });
const sessionsPanel = (page: Page) => page.locator('#activity-sessions-panel');
const filesPanel = (page: Page) => page.locator('#activity-files-panel');
const rail = (page: Page) => page.locator('.workspace-activity-bar');
const navigator = (page: Page) => page.locator('.sidebar');
const selectProject = (page: Page, name: string) => navigator(page).locator('.project-main').filter({ hasText: name }).click();

async function openWorkspace(page: Page, options = '', openSessions = true) {
  await page.goto(`/tests/browser/workspace-focus-mode.html?activity=1${options}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await expect(rail(page)).toBeHidden();
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(async () => (await page.locator('.xterm-rows').innerText()).replace(/\s/g, '')).toContain('Syntheticfocusoutput');
  await expect(navigator(page)).toBeVisible();
  await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.project-work-content').getByRole('list', { name: 'Session 清單', includeHidden: true })).toHaveCount(0);
  if (openSessions) {
    await sessionsButton(page).click();
    await expect(sessionsPanel(page).getByRole('list', { name: 'Session 清單' })).toBeVisible();
  }
  await page.evaluate(() => Object.assign(window, {
    activityOriginalTerminal: document.querySelector('.xterm'),
    activityOriginalCanvas: document.querySelector('.workspace-canvas'),
  }));
}

async function expectRuntimePreserved(page: Page) {
  expect(await page.evaluate(() => {
    const saved = window as unknown as { activityOriginalTerminal: Element; activityOriginalCanvas: Element };
    return saved.activityOriginalTerminal === document.querySelector('.xterm') &&
      saved.activityOriginalCanvas === document.querySelector('.workspace-canvas');
  })).toBe(true);
  expect((await calls(page)).filter(call =>
    ['launch_runtime', 'attach_runtime', 'detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))
    .map(call => call.command)).toEqual(['attach_runtime']);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return { body: box('.app-body'), navigator: box('.sidebar'), main: box('.main-content'),
      header: box('.project-header'), content: box('.project-work-content'), rail: box('.workspace-activity-bar'),
      tools: box('.project-activity-tools'), viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
}

async function expectAdjacentSurfaces(page: Page, panel?: 'sessions' | 'files') {
  const value = await geometry(page);
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1);
  near(value.main.left, value.navigator.width ? value.navigator.right : value.body.left);
  near(value.content.left, value.main.left);
  if (value.header.width) near(value.header.left, value.content.left);
  near(value.rail.right, value.body.right);
  near(value.rail.width, 44);
  if (panel) {
    const side = (await page.locator(`#activity-${panel}-panel`).boundingBox())!;
    near(value.content.right, side.x);
    near(side.x + side.width, value.rail.left);
  } else near(value.content.right, value.rail.left);
  const terminal = page.locator('.terminal-pane:visible');
  if (await terminal.count() === 1) {
    const surface = (await terminal.boundingBox())!;
    near(surface.x, value.content.left);
    near(surface.y, value.content.top);
    near(surface.x + surface.width, value.content.right);
    near(surface.y + surface.height, value.content.bottom);
  }
  expect(value.content.width).toBeGreaterThan(0);
  expect(value.scrollWidth).toBeLessThanOrEqual(value.viewport);
  return value;
}

for (const theme of ['dark', 'light']) for (const width of [1200, 1440, 720]) {
  test(`right project tools ${theme} ${width}: independent navigation and normal/Zen geometry`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await openWorkspace(page, `&theme=${theme}`, false);
    const navigation = page.getByRole('navigation', { name: '工作區功能' });
    expect(await navigation.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(['歷史 Sessions', 'Files']);
    await expect(page.locator('#activity-projects-panel')).toHaveCount(0);
    await expect(page.locator('.workspace-tabs').getByRole('button', { name: '歷史 Session', exact: true })).toHaveCount(0);
    const normal = await expectAdjacentSurfaces(page);
    await page.screenshot({ path: info.outputPath(`activity-normal-collapsed-${theme}-${width}.png`), fullPage: true });
    await sessionsButton(page).click();
    await expect(sessionsPanel(page)).toBeVisible();
    await expect(navigator(page)).toBeVisible();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    const expanded = await expectAdjacentSurfaces(page, 'sessions');
    expect(expanded.content.width).toBeLessThan(normal.content.width);
    await page.screenshot({ path: info.outputPath(`activity-normal-sessions-${theme}-${width}.png`), fullPage: true });
    await sessionsButton(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(filesButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(filesPanel(page)).toBeVisible();
    await expect(sessionsPanel(page)).toBeHidden();
    await expectAdjacentSurfaces(page, 'files');
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(filesPanel(page)).toBeHidden();
    await expectAdjacentSurfaces(page);
    await sessionsButton(page).click();
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(navigator(page)).toBeHidden();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(filesPanel(page)).toBeHidden();
    const zen = await expectAdjacentSurfaces(page);
    expect(zen.content.width).toBeGreaterThan(width * 0.9);
    expect(zen.content.height).toBeGreaterThan(normal.content.height);
    await expectRuntimePreserved(page);
    await page.screenshot({ path: info.outputPath(`activity-zen-collapsed-${theme}-${width}.png`), fullPage: true });
    await sessionsButton(page).click();
    await expect(sessionsPanel(page)).toBeVisible();
    await expectAdjacentSurfaces(page, 'sessions');
    await page.screenshot({ path: info.outputPath(`activity-zen-sessions-${theme}-${width}.png`), fullPage: true });
    await sessionsButton(page).click();
    await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
    await expect(navigator(page)).toBeVisible();
    await expect(sessionsPanel(page)).toBeVisible();
    await expectAdjacentSurfaces(page, 'sessions');
    await expectRuntimePreserved(page);
    await info.attach('normal-zen-geometry', { body: JSON.stringify({ normal, expanded, zen }, null, 2), contentType: 'application/json' });
  });
}

test('switching activities retains session filters, list position and terminal input state', async ({ page }) => {
  await openWorkspace(page);
  const list = sessionsPanel(page).getByRole('list', { name: 'Session 清單' });
  const search = sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' });
  await search.fill('focus session');
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'query_sessions').at(-1)?.query?.query).toBe('focus session');
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await list.evaluate(element => { element.scrollTop = 600; });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(600);
  await page.locator('.xterm-helper-textarea').pressSequentially('synthetic input');
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'write_runtime').map(call => call.data).join('')).toBe('synthetic input');
  const queries = (await calls(page)).filter(call => call.command === 'query_sessions').length;
  for (let iteration = 0; iteration < 3; iteration++) {
    await filesButton(page).click();
    await expect(navigator(page)).toBeVisible();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await filesButton(page).click();
    await expect(filesPanel(page)).toBeHidden();
    await sessionsButton(page).click();
    await expect(search).toHaveValue('focus session');
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(600);
  }
  expect((await calls(page)).filter(call => call.command === 'query_sessions')).toHaveLength(queries);
  expect((await calls(page)).filter(call => call.command === 'write_runtime').map(call => call.data).join('')).toBe('synthetic input');
  await expectRuntimePreserved(page);
});

test('explicit session and file selection changes center while activity icons preserve it', async ({ page }) => {
  await openWorkspace(page);
  await sessionsPanel(page).locator('.session-card-select').filter({ hasText: 'Synthetic focus session 2' }).first().click();
  const transcript = page.getByRole('region', { name: '對話預覽' });
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('Synthetic transcript project-focus-session-2 message 59');
  await expect(page.locator('.xterm-screen')).toBeHidden();
  const contentBounds = (await page.locator('.project-work-content').boundingBox())!;
  const transcriptBounds = (await transcript.boundingBox())!;
  expect(Math.abs(transcriptBounds.x - contentBounds.x)).toBeLessThan(1);
  expect(Math.abs(transcriptBounds.width - contentBounds.width)).toBeLessThan(1);
  await expect(sessionsPanel(page).getByRole('region', { name: '對話預覽' })).toHaveCount(0);
  const transcriptScroll = transcript.locator('.transcript-scroll');
  await transcriptScroll.evaluate(element => { element.scrollTop = 120; });
  await filesButton(page).click();
  await expect(transcript).toBeVisible();
  await expect.poll(() => transcriptScroll.evaluate(element => element.scrollTop)).toBe(120);
  await page.getByRole('button', { name: 'large.ts', exact: true }).dblclick();
  const document = page.getByLabel('唯讀內容：large.ts');
  await expect(document).toBeVisible();
  await document.evaluate(element => { element.scrollTop = 800; });
  const fileScroll = await document.evaluate(element => element.scrollTop);
  expect(fileScroll).toBeGreaterThan(0);
  await sessionsButton(page).click();
  await expect(document).toBeVisible();
  await expect(page.locator('.history-mount')).toBeHidden();
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(document).toBeVisible();
  await filesButton(page).click();
  await expect.poll(() => document.evaluate(element => element.scrollTop)).toBe(fileScroll);
  await page.locator('.workspace-tab-select').click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expectRuntimePreserved(page);
});

test('each project restores its selected center tab and independently chosen tool panel', async ({ page }) => {
  await openWorkspace(page, '', false);
  await filesButton(page).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'index.ts', exact: true }).dblclick();
  const document = page.getByLabel('唯讀內容：src/index.ts');
  await expect(document).toBeVisible();
  await selectProject(page, 'Synthetic other');
  await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(filesPanel(page)).toBeHidden();
  await expect(sessionsPanel(page)).toContainText('Synthetic other session');
  await expect(sessionsPanel(page)).not.toContainText('Synthetic focus session');
  await expect(page.locator('.project-file-tabs-host').getByRole('tab')).toHaveCount(0);
  await sessionsButton(page).click();
  await selectProject(page, 'Synthetic focus');
  await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'index.ts', exact: true })).toBeVisible();
  await expect(document).toBeVisible();
  await selectProject(page, 'Synthetic other');
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(filesPanel(page)).toBeHidden();
  await selectProject(page, 'Synthetic focus');
  await page.locator('.workspace-tab-select').click();
  await selectProject(page, 'Synthetic other');
  await selectProject(page, 'Synthetic focus');
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expectRuntimePreserved(page);
});

test('Zen tool choice is remembered separately and never changes normal panel or left navigation', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(navigator(page)).toBeHidden();
  await expect(sessionsPanel(page)).toBeHidden();
  await filesButton(page).click();
  await expect(filesPanel(page)).toBeVisible();
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(navigator(page)).toBeVisible();
  await expect(sessionsPanel(page)).toBeVisible();
  await expect(filesPanel(page)).toBeHidden();
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(filesPanel(page)).toBeVisible();
  await expect(sessionsPanel(page)).toBeHidden();
  await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
  await expect(navigator(page)).toBeVisible();
  await expect(filesPanel(page)).toBeVisible();
  await page.getByRole('button', { name: '收起完整控制列', exact: true }).click();
  await expect(navigator(page)).toBeHidden();
  await expect(filesPanel(page)).toBeVisible();
  await expectRuntimePreserved(page);
});

for (const width of [1200, 1440, 720]) {
  test(`collapsed project tools have no placeholder gutters at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await openWorkspace(page, '', false);
    await navigator(page).getByRole('button', { name: '隱藏側欄', exact: true }).click();
    await expect(navigator(page)).toBeHidden();
    const normal = await expectAdjacentSurfaces(page);
    expect(normal.content.width).toBeGreaterThan(width * 0.9);
    await expectRuntimePreserved(page);
    await page.screenshot({ path: info.outputPath(`activity-no-gutters-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    const zen = await expectAdjacentSurfaces(page);
    expect(zen.content.width).toBeGreaterThan(width * 0.9);
    expect(zen.content.height).toBeGreaterThan(normal.content.height);
    await page.screenshot({ path: info.outputPath(`activity-zen-no-gutters-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
    await expect(navigator(page)).toBeHidden();
    await page.getByRole('button', { name: '顯示側欄', exact: true }).click();
    await expect(navigator(page)).toBeVisible();
    await expectAdjacentSurfaces(page);
    await expectRuntimePreserved(page);
  });
}

test('expanded filters stay scrollable above a usable session list at 700×550', async ({ page }, info) => {
  await page.setViewportSize({ width: 700, height: 550 });
  await openWorkspace(page);
  const panel = sessionsPanel(page);
  await panel.getByRole('button', { name: '篩選', exact: true }).click();
  const controls = panel.locator('.activity-history-controls');
  await expect.poll(() => controls.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect((await panel.getByRole('list', { name: 'Session 清單' }).boundingBox())!.height).toBeGreaterThanOrEqual(120);
  const children = panel.getByRole('checkbox', { name: '包含子代理與分支' });
  await children.check();
  await expect(children).toBeInViewport();
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'query_sessions').at(-1)?.query?.includeChildren).toBe(true);
  await panel.getByRole('button', { name: '重設篩選', exact: true }).click();
  await expect(children).not.toBeChecked();
  await controls.evaluate(element => { element.scrollTop = 0; });
  await expect(panel.getByRole('textbox', { name: '搜尋 Session' })).toBeInViewport();
  await expectAdjacentSurfaces(page, 'sessions');
  await expectRuntimePreserved(page);
  await page.screenshot({ path: info.outputPath('activity-short-expanded-filters.png'), fullPage: true });
});

test('overview has no project rail or empty column and explicit global search stays independent', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?activity=1');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await expect(navigator(page)).toBeVisible();
  await expect(page.getByRole('region', { name: '專案管理總覽', exact: true })).toBeVisible();
  await expect(rail(page)).toBeHidden();
  const overview = await geometry(page);
  expect(overview.tools.width).toBe(0);
  expect(overview.main.left).toBe(overview.navigator.right);
  expect(overview.main.right).toBe(overview.body.right);
  await navigator(page).getByRole('tab', { name: /^所有目錄/ }).click();
  await page.getByRole('button', { name: '搜尋所有工作階段', exact: true }).click();
  await expect(rail(page)).toBeHidden();
  await expect(page.locator('.project-work-content').getByRole('list', { name: 'Session 清單' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜尋 Session' }).fill('other session');
  await expect(page.getByRole('list', { name: 'Session 清單' })).toContainText('Synthetic other session');
  const queries = (await calls(page)).filter(call => call.command === 'query_sessions');
  expect(queries.at(-1)?.query?.projectId).toBeUndefined();
  await page.getByRole('button', { name: '返回目錄總覽', exact: true }).click();
  await expect(page.getByRole('region', { name: '所有目錄總覽', exact: true })).toBeVisible();
  await expect(rail(page)).toBeHidden();
  expect((await calls(page)).filter(call => ['launch_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
});

test('temporary Terminal hides project tools without leaking project sessions and restores the original project', async ({ page }) => {
  await openWorkspace(page, '&temporary=1');
  await sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' }).fill('focus session');
  await page.getByRole('button', { name: '開啟臨時 Terminal', exact: true }).click();
  await expect(page.locator('.project-header h1')).toHaveText('臨時 Terminal');
  await expect(rail(page)).toBeHidden();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(1);
  const temporary = await geometry(page);
  expect(temporary.tools.width).toBe(0);
  expect(temporary.content.right).toBe(temporary.body.right);
  await selectProject(page, 'Synthetic focus');
  await expect(sessionsPanel(page)).toBeVisible();
  await expect(sessionsPanel(page).getByRole('heading', { name: 'Synthetic focus', exact: true })).toBeVisible();
  await expect(sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' })).toHaveValue('focus session');
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { activityOriginalTerminal: Element }).activityOriginalTerminal === document.querySelector('.xterm'))).toBe(true);
  const operations = await calls(page);
  expect(operations.filter(call => call.command === 'launch_runtime')).toHaveLength(1);
  expect(operations.filter(call => call.command === 'attach_runtime')).toHaveLength(1);
  expect(operations.filter(call => ['detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
});

test('a project without runtime or history opens Sessions and can browse Files without launching work', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?activity=1&empty=1');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await selectProject(page, 'Synthetic other');
  await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(sessionsPanel(page)).toContainText('把工作接續起來');
  await expect(page.locator('.workspace-tab-select')).toHaveCount(0);
  await expect(navigator(page)).toBeVisible();
  await filesButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByLabel('唯讀內容：README.md')).toBeVisible();
  await selectProject(page, 'Synthetic focus');
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await selectProject(page, 'Synthetic other');
  await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('唯讀內容：README.md')).toBeVisible();
  expect((await calls(page)).filter(call => ['launch_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
});
