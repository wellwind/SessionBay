import { expect, test, type Page } from '@playwright/test';
import type { SessionQuery } from '../../src/types';

type Call = { command: string; data?: string; query?: SessionQuery };
const calls = (page: Page) => page.evaluate(() =>
  (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls);
const sessionsButton = (page: Page) => page.getByRole('button', { name: '歷史 Sessions', exact: true });
const projectsButton = (page: Page) => page.getByRole('navigation', { name: '工作區功能' }).getByRole('button', { name: '專案', exact: true });
const projectsPanel = (page: Page) => page.locator('#activity-projects-panel');
const filesButton = (page: Page) => page.getByRole('button', { name: 'Files', exact: true });
const sessionsPanel = (page: Page) => page.locator('#activity-sessions-panel');
const filesPanel = (page: Page) => page.locator('#activity-files-panel');

async function openWorkspace(page: Page, options = '', openSessions = true) {
  await page.goto(`/tests/browser/workspace-focus-mode.html?activity=1${options}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(async () => (await page.locator('.xterm-rows').innerText()).replace(/\s/g, '')).toContain('Syntheticfocusoutput');
  await expect(projectsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.project-work-content').getByRole('list', { name: 'Session 清單', includeHidden: true })).toHaveCount(0);
  if (openSessions) {
    await sessionsButton(page).click();
    await expect(sessionsPanel(page).getByRole('list', { name: 'Session 清單' })).toBeVisible();
    await expect(projectsPanel(page)).toBeHidden();
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

for (const theme of ['dark', 'light']) for (const width of [1200, 1440, 720]) {
  test(`activity navigation ${theme} ${width}: accessible selection, collapse and retained terminal`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await openWorkspace(page, `&theme=${theme}`, false);
    await expect(projectsPanel(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`activity-projects-${theme}-${width}.png`), fullPage: true });
    await sessionsButton(page).click();
    await expect(projectsPanel(page)).toBeHidden();
    const navigation = page.getByRole('navigation', { name: '工作區功能' });
    await expect(navigation.getByRole('button')).toHaveCount(3);
    expect(await navigation.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(['歷史 Sessions', 'Files', '專案']);
    await expect(page.locator('.workspace-activity-bar')).toHaveCount(1);
    await expect(page.locator('.app-body > .sidebar')).toHaveCount(0);
    await expect(page.locator('.activity-panel:visible')).toHaveCount(1);
    await expect(sessionsButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(filesButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(filesPanel(page)).toBeHidden();
    await expect(page.locator('.workspace-tabs').getByRole('button', { name: '歷史 Session', exact: true })).toHaveCount(0);
    const withPanel = await page.locator('.terminal-body').boundingBox();
    await sessionsButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.activity-panel:visible')).toHaveCount(0);
    await expect.poll(async () => (await page.locator('.terminal-body').boundingBox())!.width).toBeGreaterThan(withPanel!.width);
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(filesButton(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(filesPanel(page)).toBeVisible();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(projectsButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(projectsPanel(page)).toBeVisible();
    await expect(filesPanel(page)).toBeHidden();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await sessionsButton(page).click();
    await expect(sessionsPanel(page)).toBeVisible();
    await expect(filesPanel(page)).toBeHidden();
    await expect(projectsPanel(page)).toBeHidden();
    await expect(filesButton(page)).toHaveAttribute('aria-pressed', 'false');
    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.workspace-activity-bar')!.getBoundingClientRect();
      const panel = document.querySelector('#activity-sessions-panel')!.getBoundingClientRect();
      const work = document.querySelector('.project-work-content')!.getBoundingClientRect();
      return { barRight: bar.right, panelLeft: panel.left, panelRight: panel.right, workLeft: work.left,
        viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.barRight).toBeLessThanOrEqual(geometry.panelLeft);
    expect(geometry.panelRight).toBeLessThanOrEqual(geometry.workLeft);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
    await expectRuntimePreserved(page);
    await page.screenshot({ path: info.outputPath(`activity-${theme}-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(sessionsPanel(page)).toBeVisible();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeInViewport();
    await expectRuntimePreserved(page);
    await page.screenshot({ path: info.outputPath(`activity-zen-${theme}-${width}.png`), fullPage: true });
    await projectsButton(page).click();
    await expect(projectsPanel(page)).toBeVisible();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await expectRuntimePreserved(page);
    await page.screenshot({ path: info.outputPath(`activity-zen-projects-${theme}-${width}.png`), fullPage: true });
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
    await projectsButton(page).click();
    await expect(projectsPanel(page)).toBeVisible();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await filesButton(page).click();
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

test('selecting a session opens its center transcript; activity switches preserve transcript and document state', async ({ page }) => {
  await openWorkspace(page);
  await sessionsPanel(page).locator('.session-card-select').filter({ hasText: 'Synthetic focus session 2' }).first().click();
  const transcript = page.getByRole('region', { name: '對話預覽' });
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('Synthetic transcript project-focus-session-2 message 59');
  await expect(page.locator('.xterm-screen')).toBeHidden();
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
  await expect(sessionsPanel(page).locator('.session-card-select[aria-current="true"]')).toContainText('Synthetic focus session 2');
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(document).toBeVisible();
  await filesButton(page).click();
  await expect.poll(() => document.evaluate(element => element.scrollTop)).toBe(fileScroll);
  await page.locator('.workspace-tab-select').click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expectRuntimePreserved(page);
});

test('one global activity selection preserves project-scoped files through project navigation', async ({ page }) => {
  await openWorkspace(page);
  await filesButton(page).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'index.ts', exact: true }).dblclick();
  await expect(page.getByLabel('唯讀內容：src/index.ts')).toBeVisible();
  await projectsButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(filesPanel(page)).toBeHidden();
  await expect(page.getByLabel('唯讀內容：src/index.ts')).toBeVisible();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await expect(projectsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.project-file-tabs-host').getByRole('tab')).toHaveCount(0);
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toContainText('Synthetic other session');
  await expect(sessionsPanel(page)).not.toContainText('Synthetic focus session');
  await expect(projectsPanel(page)).toBeHidden();
  await projectsButton(page).click();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic focus' }).click();
  await expect(projectsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await filesButton(page).click();
  await expect(page.getByRole('button', { name: 'index.ts', exact: true })).toBeVisible();
  await page.locator('.project-file-tabs-host').getByRole('tab', { name: /index.ts/ }).click();
  await expect(page.getByLabel('唯讀內容：src/index.ts')).toBeVisible();
  await projectsButton(page).click();
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect(projectsPanel(page)).toBeVisible();
  await expect(filesPanel(page)).toBeHidden();
  await expectRuntimePreserved(page);
});

test('Zen keeps activity controls reachable and preserves the chosen panel on exit', async ({ page }, info) => {
  await openWorkspace(page);
  await filesButton(page).click();
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '工作區功能' })).toBeVisible();
  await expect(filesPanel(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath('activity-zen-files.png'), fullPage: true });
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeVisible();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.screenshot({ path: info.outputPath('activity-zen-sessions.png'), fullPage: true });
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await page.getByRole('button', { name: '退出專注模式', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.app-topbar')).toBeVisible();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(filesPanel(page)).toBeHidden();
  await expectRuntimePreserved(page);
  await page.screenshot({ path: info.outputPath('activity-zen-restored.png'), fullPage: true });
});

for (const width of [1200, 1440, 720]) {
  test(`single activity sidebar collapses without empty terminal gutters at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await openWorkspace(page);
    await projectsButton(page).click();
    await expect(projectsPanel(page)).toBeVisible();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(filesPanel(page)).toBeHidden();
    await expect(projectsButton(page)).toHaveAttribute('aria-expanded', 'true');
    await projectsButton(page).click();
    await expect(projectsPanel(page)).toBeHidden();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(filesPanel(page)).toBeHidden();
    const edgeGeometry = () => page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
      };
      return { bar: box('.workspace-activity-bar'), content: box('.project-work-content'),
        terminal: box('.terminal-pane'), canvas: box('.workspace-canvas'), width: innerWidth };
    });
    const expectFullSurface = async () => {
      await expect.poll(async () => {
        const geometry = await edgeGeometry();
        return Math.abs(geometry.content.left - geometry.bar.right) < 1 &&
          ['left', 'top', 'right', 'bottom'].every(key =>
            Math.abs(geometry.terminal[key as keyof typeof geometry.terminal] - geometry.content[key as keyof typeof geometry.content]) < 1);
      }).toBe(true);
      const geometry = await edgeGeometry();
      expect(geometry.content.width).toBeGreaterThan(geometry.width * 0.9);
      expect(geometry.canvas).toEqual(geometry.content);
      await expectRuntimePreserved(page);
      return geometry;
    };
    const normal = await expectFullSurface();
    await page.screenshot({ path: info.outputPath(`activity-panel-collapsed-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    const zen = await expectFullSurface();
    expect(zen.content.bottom - zen.content.top).toBeGreaterThan(normal.content.bottom - normal.content.top);
    await page.screenshot({ path: info.outputPath(`activity-zen-panel-collapsed-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await projectsButton(page).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(sessionsPanel(page)).toBeHidden();
    await expect(filesPanel(page)).toBeHidden();
    await expectRuntimePreserved(page);
    await info.attach('edge-geometry', { body: JSON.stringify({ normal, zen }, null, 2), contentType: 'application/json' });
  });
}

test('expanded filters remain scrollable above a usable session list at 700×550', async ({ page }, info) => {
  await page.setViewportSize({ width: 700, height: 550 });
  await openWorkspace(page);
  const panel = sessionsPanel(page);
  await panel.getByRole('button', { name: '篩選', exact: true }).click();
  const controls = panel.locator('.activity-history-controls');
  await expect(controls).toBeVisible();
  await expect.poll(() => controls.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const list = panel.getByRole('list', { name: 'Session 清單' });
  expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(120);
  const children = panel.getByRole('checkbox', { name: '包含子代理與分支' });
  await children.check();
  await expect(children).toBeInViewport();
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'query_sessions').at(-1)?.query?.includeChildren).toBe(true);
  await panel.getByRole('button', { name: '重設篩選', exact: true }).click();
  await expect(children).not.toBeChecked();
  await controls.evaluate(element => { element.scrollTop = 0; });
  await expect(panel.getByRole('textbox', { name: '搜尋 Session' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expectRuntimePreserved(page);
  await page.screenshot({ path: info.outputPath('activity-short-expanded-filters.png'), fullPage: true });
});

test('unscoped Files explains its context and opens Projects while global Sessions remains available', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?activity=1');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await expect(projectsPanel(page)).toBeVisible();
  const overview = page.getByRole('region', { name: '專案管理總覽', exact: true });
  await expect(overview).toBeVisible();
  await filesButton(page).click();
  await expect(filesButton(page)).toBeEnabled();
  await expect(filesButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(filesPanel(page).getByRole('button', { name: '選擇專案', exact: true })).toBeVisible();
  await expect(projectsPanel(page)).toBeHidden();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(overview).toBeVisible();
  await filesPanel(page).getByRole('button', { name: '選擇專案', exact: true }).click();
  await expect(projectsPanel(page)).toBeVisible();
  await expect(filesPanel(page)).toBeHidden();
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeVisible();
  await expect(projectsPanel(page)).toBeHidden();
  await sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' }).fill('other session');
  await expect(sessionsPanel(page)).toContainText('Synthetic other session');
  await expect(overview).toBeVisible();
  await expect(page.getByRole('region', { name: '對話預覽' })).toBeHidden();
  const queries = (await calls(page)).filter(call => call.command === 'query_sessions');
  expect(queries.at(-1)?.query?.projectId).toBeUndefined();
  expect(queries.at(-1)?.query?.query).toBe('other session');
  await sessionsButton(page).click();
  await expect(sessionsPanel(page)).toBeHidden();
  await expect(overview).toBeVisible();
  await sessionsButton(page).click();
  await sessionsPanel(page).locator('.session-card-select').first().click();
  const transcript = page.getByRole('region', { name: '對話預覽' });
  await expect(transcript).toBeVisible();
  await expect(overview).toBeHidden();
  await projectsButton(page).click();
  await expect(transcript).toBeVisible();
  expect((await calls(page)).filter(call => ['launch_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
});


test('Sessions changes to global scope when a temporary Terminal opens without changing activity', async ({ page }) => {
  await openWorkspace(page, '&temporary=1');
  await expect(sessionsPanel(page).getByRole('heading', { name: 'Synthetic focus', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '開啟臨時 Terminal', exact: true }).click();
  await expect(page.locator('.project-header h1')).toHaveText('臨時 Terminal');
  await expect(sessionsButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(sessionsPanel(page).getByRole('heading', { name: '所有 Sessions', exact: true })).toBeVisible();
  await expect.poll(async () => (await calls(page)).filter(call => call.command === 'query_sessions').at(-1)?.query?.projectId).toBeUndefined();
  await sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' }).fill('other session');
  await expect(sessionsPanel(page)).toContainText('Synthetic other session');
  await expect(sessionsPanel(page)).not.toContainText('Synthetic focus session');
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(1);
  await sessionsPanel(page).locator('.session-card-select').first().click();
  const transcript = page.getByRole('region', { name: '對話預覽' });
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('Synthetic transcript project-other-session-0 message 59');
  await filesButton(page).click();
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('Synthetic transcript project-other-session-0 message 59');
  await expect(filesPanel(page).getByRole('button', { name: '選擇專案', exact: true })).toBeVisible();
  await sessionsButton(page).click();
  await expect(sessionsPanel(page).getByRole('textbox', { name: '搜尋 Session' })).toHaveValue('other session');
  await projectsButton(page).click();
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await sessionsButton(page).click();
  await expect(sessionsPanel(page).getByRole('heading', { name: 'Synthetic focus', exact: true })).toBeVisible();
  await expect(sessionsPanel(page)).toContainText('Synthetic focus session');
  await expect(sessionsPanel(page)).not.toContainText('Synthetic other session');
  expect(await page.evaluate(() => (window as unknown as { activityOriginalTerminal: Element }).activityOriginalTerminal === document.querySelector('.xterm'))).toBe(true);
  const operations = await calls(page);
  expect(operations.filter(call => call.command === 'launch_runtime')).toHaveLength(1);
  expect(operations.filter(call => call.command === 'attach_runtime')).toHaveLength(1);
  expect(operations.filter(call => ['detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
});
