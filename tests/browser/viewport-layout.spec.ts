import { expect, test, type Page } from '@playwright/test';

async function visibleLayout(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)!;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        scroll: element.scrollTop, overflowY: element.scrollHeight - element.clientHeight };
    };
    return { width: innerWidth, height: innerHeight,
      boxes: Object.fromEntries(['.app-topbar', '.project-header', '.workspace-tab-bar', '.statusbar', '.terminal-body', '.xterm-cursor', '#root', '.main-content'].map(s => [s, rect(s)])) };
  });
}
async function assertLayout(page: Page, zen = false) {
  await expect(page.locator('.xterm-cursor').first()).toBeAttached();
  await expect.poll(async () => (await visibleLayout(page)).boxes['.terminal-body'].height).toBeGreaterThan(40);
  // WebKit refits xterm a frame or two after a pane resize; Chromium is synchronous.
  await expect.poll(async () => {
    const { boxes } = await visibleLayout(page);
    return boxes['.xterm-cursor'].bottom <= boxes['.terminal-body'].bottom + 1;
  }).toBe(true);
  const data = await visibleLayout(page);
  for (const [selector, r] of Object.entries(data.boxes)) {
    if (zen && ['.app-topbar', '.project-header'].includes(selector)) continue;
    expect(r.x, selector).toBeGreaterThanOrEqual(-1);
    expect(r.y, selector).toBeGreaterThanOrEqual(-1);
    expect(r.right, selector).toBeLessThanOrEqual(data.width + 1);
    expect(r.bottom, selector).toBeLessThanOrEqual(data.height + 1);
  }
  const cursor = data.boxes['.xterm-cursor'], terminal = data.boxes['.terminal-body'];
  expect(cursor.y).toBeGreaterThanOrEqual(terminal.y - 1);
  expect(cursor.bottom).toBeLessThanOrEqual(terminal.bottom + 1);
  expect(data.boxes['#root'].overflowY).toBe(0);
  expect(data.boxes['.main-content'].overflowY).toBe(0);
  expect(data.boxes['.main-content'].scroll).toBe(0);
  return data;
}
for (const theme of ['dark', 'light']) for (const size of [[1440, 940], [720, 470], [720, 496], [600, 413], [450, 310]]) {
  test(`${theme} ${size.join('x')} keeps the input, tabs and status visible`, async ({ page }, info) => {
    await page.goto('/tests/browser/workspace-focus-mode.html' + (size[0] <= 600 ? '?long' : ''));
    await page.getByRole('button', {name:/^開啟工作區 .* Focus shell$/}).click();
    await expect(page.locator('.xterm-rows')).toContainText('Synthetic focus output');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; Object.assign(window, {originalTerminal:document.querySelector('.xterm')}); }, theme);
    await page.setViewportSize({width:size[0],height:size[1]});
    await page.locator('.xterm-screen').click();
    await assertLayout(page);
    await page.getByRole('button', {name:'Files',exact:true}).click();
    await assertLayout(page);
    await page.screenshot({path:info.outputPath('files.png')});
    await page.getByRole('button', {name:'Files',exact:true}).click();
    await page.getByRole('button', {name:'進入專注模式',exact:true}).click();
    await assertLayout(page, true);
    await page.getByRole('button', {name:'退出專注模式',exact:true}).click();
    await assertLayout(page);
    expect(await page.evaluate(() => document.querySelector('.xterm') === (window as unknown as {originalTerminal:Element}).originalTerminal)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as {focusFixture:{calls:{command:string}[]}}).focusFixture.calls.filter(c=>['launch_runtime','attach_runtime','detach_runtime','stop_runtime'].includes(c.command)))).toEqual([{command:'attach_runtime'}]);
    await page.screenshot({path:info.outputPath('restored.png')});
  });
}
test('compact controls are keyboard reachable and no-range navigation preserves its preference', async ({page}) => {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await page.getByRole('button', {name:'開啟工作區 Synthetic focus Focus shell',exact:true}).click();
  await page.setViewportSize({width:1440,height:940});
  const separator=page.getByRole('separator',{name:'調整專案導覽寬度'});
  await separator.focus(); await page.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow','480');
  const saved=await page.evaluate(()=>localStorage.getItem('sessionbay.sidebar.v1'));
  await page.setViewportSize({width:600,height:413});
  await expect(separator).toBeHidden();
  expect(await page.evaluate(()=>localStorage.getItem('sessionbay.sidebar.v1'))).toBe(saved);
  const options=page.getByRole('button',{name:'專案資訊與操作',exact:true});
  await options.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'重新定位',exact:true})).toBeVisible();
  await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
  await expect(options).toBeFocused(); await expect(options).toHaveAttribute('aria-expanded','false');
  const paneOptions=page.getByRole('button',{name:'面板選項 Focus shell',exact:true});
  await paneOptions.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'搜尋終端文字',exact:true})).toBeVisible();
  await page.keyboard.press('Escape'); await expect(paneOptions).toBeFocused();
  await page.setViewportSize({width:1440,height:940});
  await expect(separator).toHaveAttribute('aria-valuenow','480');
  expect(await page.evaluate(()=>localStorage.getItem('sessionbay.sidebar.v1'))).toBe(saved);
});

test('short split panes retain visible prompts and reachable runtime controls', async ({page}) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?edge');
  await page.getByRole('button', {name:'開啟工作區 Synthetic focus Focus shell',exact:true}).click();
  await page.setViewportSize({width:450,height:310});
  await page.getByRole('button', {name:'面板選項 Focus shell',exact:true}).click();
  await page.getByRole('button', {name:'上下分割',exact:true}).click();
  await page.getByRole('button', {name:'開始工作',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  await expect.poll(async () => page.locator('.terminal-body:visible').evaluateAll(elements=>elements.every(e=>e.getBoundingClientRect().height >= 30))).toBe(true);
  for (const pane of await page.locator('.terminal-pane:visible').all()) {
    await pane.getByRole('button', {name:/面板選項/}).click();
    await expect(pane.getByRole('button', {name:'停止',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pane.locator('.xterm-cursor')).toBeInViewport();
  }
});

test('resizing preserves a reader in terminal scrollback', async ({page}) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?long');
  await page.getByRole('button', {name:/^開啟工作區 .* Focus shell$/}).click();
  await expect(page.locator('.xterm-cursor')).toBeAttached();
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -400);
  await expect(page.locator('.xterm-cursor')).toHaveCount(0);
  const before = await page.locator('.xterm-rows').innerText();
  await page.setViewportSize({width:600,height:413});
  await expect.poll(() => page.locator('.xterm-rows').innerText()).not.toBe(before);
  await expect(page.locator('.xterm-cursor')).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).not.toContainText('Synthetic focus output 100');
});

test('compact actions focus search and dialogs, and cancellation restores reachable controls', async ({page}) => {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await page.getByRole('button', {name:'開啟工作區 Synthetic focus Focus shell',exact:true}).click();
  await page.setViewportSize({width:450,height:310});
  const pane = page.getByRole('region', {name:'Focus shell 終端面板',exact:true});
  const options = pane.getByRole('button', {name:'面板選項 Focus shell',exact:true});
  await options.click();
  await pane.getByRole('button', {name:'搜尋終端文字',exact:true}).click();
  await expect(page.getByRole('textbox', {name:'終端搜尋'})).toBeFocused();
  await page.getByRole('button', {name:'關閉終端搜尋'}).click();
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  await options.click();
  await pane.getByRole('button', {name:'重新命名面板 Focus shell'}).click();
  await expect(page.getByRole('textbox', {name:'顯示名稱'})).toBeFocused();
  await page.getByRole('button', {name:'取消',exact:true}).click();
  await expect(options).toBeFocused();
  await options.click();
  const confirmation = page.waitForEvent('dialog');
  const stop = pane.getByRole('button', {name:'停止',exact:true}).click();
  const dialog = await confirmation;
  expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); await stop;
  await expect(options).toBeFocused();
  await expect(options).toHaveAttribute('aria-expanded','false');
});

test('runtime unavailable retains a scrollable route to its final content', async ({page}) => {
  await page.setViewportSize({width:450,height:310});
  await page.goto('/');
  const surface = page.locator('.runtime-unavailable');
  await expect(surface).toBeVisible();
  await surface.hover(); await page.mouse.wheel(0,1000);
  await expect(surface.locator('.runtime-features span').last()).toBeInViewport();
  expect(await surface.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.main-content').evaluate(e=>e.scrollTop)).toBe(0);
});

test('resize hands focused footer and compact trigger to visible controls in both directions', async ({page}) => {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await page.getByRole('button', {name:'開啟工作區 Synthetic focus Focus shell',exact:true}).click();
  const pane = page.getByRole('region', {name:'Focus shell 終端面板',exact:true});
  await pane.evaluate(e=>e.style.height='181px');
  const stop = pane.getByRole('button', {name:'停止',exact:true});
  await stop.focus(); await expect(stop).toBeFocused();
  await pane.evaluate(e=>e.style.height='179px');
  const options = pane.getByRole('button', {name:'面板選項 Focus shell',exact:true});
  await expect(options).toBeFocused();
  await page.keyboard.press('Enter'); await stop.focus();
  await pane.evaluate(e=>e.style.height='181px');
  await expect(stop).toBeFocused(); await expect(stop).toBeVisible();
  await expect(pane).not.toHaveClass(/minimal-chrome/);
  await pane.evaluate(e=>e.style.height='');
  await page.setViewportSize({width:600,height:413});
  await expect(options).toBeVisible();
  // The viewport change can rebuild the pane header over a few frames, so the
  // first trigger may be replaced after it is focused. Wait until focus sticks.
  await expect(async () => {
    await options.focus();
    await expect(options).toBeFocused({ timeout: 250 });
  }).toPass();
  await page.setViewportSize({width:1200,height:850});
  await expect(pane.getByRole('button', {name:'重新命名面板 Focus shell'})).toBeFocused();
  await expect(options).toHaveCount(0);
});

test('nonterminal overview, global results, empty project and settings keep scrollable content reachable', async ({page}) => {
  await page.setViewportSize({width:600,height:413});
  await page.goto('/tests/browser/workspace-focus-mode.html?activity&empty');
  const overview = page.getByRole('region', {name:'專案管理總覽',exact:true});
  await overview.hover(); await page.mouse.wheel(0,1000);
  await expect(overview.getByRole('button', {name:'移出專案 Synthetic other',exact:true})).toBeInViewport();
  await page.getByRole('tab', {name:/^所有目錄/}).click();
  await page.getByRole('button', {name:'專案資訊與操作',exact:true}).click();
  await page.getByRole('button', {name:'搜尋所有工作階段',exact:true}).click();
  await page.keyboard.press('Escape');
  const search = page.getByRole('textbox', {name:'搜尋 Session',exact:true});
  await search.fill('focus session');
  const list = page.getByRole('list', {name:'Session 清單'});
  await expect(list).toContainText('Synthetic focus session');
  await list.hover(); await page.mouse.wheel(0,1000);
  await expect.poll(()=>list.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('tab', {name:/^專案/}).click();
  await page.locator('.sidebar .project-main').filter({hasText:'Synthetic other'}).click();
  const empty = page.locator('#activity-sessions-panel');
  const emptySurface = empty.locator('.session-column > .empty-state');
  await emptySurface.hover(); await page.mouse.wheel(0,1000);
  await expect(empty.getByRole('button', {name:'開始新工作',exact:true})).toBeInViewport();
  await page.getByRole('button', {name:'設定與資料來源',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.hover(); await page.mouse.wheel(0,2000);
  await expect(dialog.getByRole('button', {name:'取消',exact:true})).toBeInViewport();
  await dialog.getByRole('button', {name:'取消',exact:true}).click();
  expect(await page.locator('.main-content').evaluate(e=>e.scrollTop)).toBe(0);
});
