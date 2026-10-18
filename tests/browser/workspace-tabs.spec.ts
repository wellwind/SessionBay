import { expect, test } from '@playwright/test';

test('real App mouse tab reorder persists without changing active tab or other projects', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const tabs = page.locator('.workspace-tab-select');
  // Assert visible names independently of screen-reader-only lifecycle descriptions.
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab b', 'Tab c']);
  await tabs.nth(2).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 12 } });
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab c', 'Tab a', 'Tab b']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test') || '{}').tabs?.map((tab: { id: string }) => tab.id))).toEqual(['c', 'other', 'a', 'global-a', 'b', 'global-b']);
  await page.screenshot({ path: info.outputPath('workspace-tabs-reordered.png') });
  await page.reload();
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab c', 'Tab a', 'Tab b']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await tabs.nth(0).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab c', 'Tab b']);
  await expect(tabs.nth(1)).toBeFocused();
});

test('pointer cancellation never saves, plain clicks and close stay distinct, global tabs reorder', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const tabs = page.locator('.workspace-tab-select');
  const from = (await tabs.nth(0).boundingBox())!;
  const siblingBefore = (await tabs.nth(1).boundingBox())!;
  const to = (await tabs.nth(2).boundingBox())!;
  await page.mouse.move(from.x + 15, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(to.x + 15, to.y + 12, { steps: 12 });
  await expect(page.locator('.workspace-tab.reorder-dragging')).toHaveCount(1);
  await expect.poll(async () => (await tabs.nth(1).boundingBox())!.x).toBeLessThan(siblingBefore.x - 20);
  expect((await tabs.nth(0).boundingBox())!.x).toBeCloseTo(to.x, 0);
  await page.screenshot({ path: info.outputPath('workspace-tabs-during-drag.png') });
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab b', 'Tab c']);
  const before = await page.evaluate(() => localStorage.getItem('workspace-test'));
  await page.waitForTimeout(500); // exceeds App's save debounce while the pointer is held
  expect(await page.evaluate(() => localStorage.getItem('workspace-test'))).toBe(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab b', 'Tab c']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await tabs.nth(0).click();
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab a');
  await page.getByRole('button', { name: '關閉分頁 Tab c', exact: true }).click();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab b']);
  await page.getByRole('button', { name: '開啟工作區 臨時 Terminal Tab global-a', exact: true }).click();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab global-a', 'Tab global-b']);
  await tabs.nth(1).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 12 } });
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab global-b', 'Tab global-a']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab global-a');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test') || '{}').tabs?.filter((tab: { projectId: string | null }) => tab.projectId === null).map((tab: { id: string }) => tab.id))).toEqual(['global-b', 'global-a']);
  await page.reload();
  await page.getByRole('button', { name: '開啟工作區 臨時 Terminal Tab global-a', exact: true }).click();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab global-b', 'Tab global-a']);
});


test('reduced motion keeps the same live preview without animated transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const tabs = page.locator('.workspace-tab-select');
  const from = (await tabs.nth(0).boundingBox())!;
  const target = (await tabs.nth(2).boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down();
  await page.mouse.move(target.x + 10, target.y + 10, { steps: 8 });
  await expect(page.locator('.reorder-dragging')).toHaveCount(1);
  expect(await tabs.nth(1).evaluate(el => getComputedStyle(el.parentElement!).transitionDuration)).toBe('0s');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.reorder-preview')).toHaveCount(0);
});

test('held drag follows through a normal gap and scroll without saving', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const rows = page.locator('.workspace-tab');
  const source = page.locator('.workspace-tab-select').first();
  const from = (await source.boundingBox())!;
  const b = (await rows.nth(1).boundingBox())!;
  const c = (await rows.nth(2).boundingBox())!;
  const gapX = (b.x + b.width + c.x) / 2;
  const saved = await page.evaluate(() => localStorage.getItem('workspace-test'));
  await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 2, from.y + 10, { steps: 8 });
  await page.mouse.move(gapX, from.y + 10, { steps: 8 });
  await expect(page.locator('.reorder-dragging')).toHaveCount(1);
  expect((await source.boundingBox())!.x).toBeCloseTo(gapX - 10, 0);
  await page.screenshot({ path: info.outputPath('workspace-tabs-gap-tracking.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  // Make the real App strip overflow before taking the next gesture snapshot.
  await page.locator('.workspace-tabs').evaluate(el => { (el as HTMLElement).style.maxWidth = '320px'; });
  const next = (await source.boundingBox())!;
  await page.mouse.move(next.x + 10, next.y + 10); await page.mouse.down();
  await page.mouse.move(next.x + 35, next.y + 10);
  const heldX = (await source.boundingBox())!.x;
  await page.locator('.workspace-tabs').evaluate(el => { el.scrollLeft = 50; });
  await expect.poll(() => page.locator('.workspace-tabs').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(async () => (await source.boundingBox())!.x).toBeCloseTo(heldX, 0);
  await expect(page.locator('.reorder-dragging')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('workspace-tabs-stationary-scroll.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem('workspace-test'))).toBe(saved);
});

test('lifted source cannot hide the real Focus Exit control from drop validation', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  const exit = page.getByRole('button', { name: '退出專注模式', exact: true });
  const strip = page.locator('.workspace-tabs');
  const tabs = page.locator('.workspace-tab-select');
  // Overflow the real strip so its real sticky Exit overlaps a real tab.
  await strip.evaluate(el => { (el as HTMLElement).style.maxWidth = '400px'; });
  await strip.evaluate(el => {
    const target = el.querySelectorAll('.workspace-tab')[2].getBoundingClientRect();
    const exit = el.querySelector('.focus-mode-toggle')!.getBoundingClientRect();
    el.scrollLeft += target.x + target.width / 2 - (exit.x + exit.width / 2);
  });
  const covered = (await page.locator('.workspace-tab').nth(2).boundingBox())!;
  const control = (await exit.boundingBox())!;
  const x = control.x + control.width / 2;
  const y = control.y + control.height / 2;
  expect(x).toBeGreaterThan(covered.x);
  expect(x).toBeLessThan(covered.x + covered.width);
  expect(y).toBeGreaterThan(covered.y);
  expect(y).toBeLessThan(covered.y + covered.height);
  expect(await exit.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  const from = (await tabs.first().boundingBox())!;
  const saved = await page.evaluate(() => localStorage.getItem('workspace-test'));
  await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await expect(page.locator('.reorder-dragging')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('workspace-tabs-real-focus-exit-covered.png') });
  await page.mouse.up();
  await expect(tabs.locator('.workspace-tab-name')).toHaveText(['Tab a', 'Tab b', 'Tab c']);
  expect(await page.evaluate(() => localStorage.getItem('workspace-test'))).toBe(saved);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  await exit.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
});

for (const width of [800, 1200]) test(`tab strip edge spacing and overflow at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 850 });
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const strip = page.locator('.workspace-tabs');
  for (const focused of [false, true]) {
    if (focused) await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await strip.evaluate(element => { element.scrollLeft = 0; });
    const edges = await strip.evaluate(element => {
      const rect = element.getBoundingClientRect();
      // WorkspaceTabs starts with clipped accessibility-only spans; measure the
      // first real flex item (a workspace tab in both modes).
      const first = element.querySelector(':scope > .workspace-tab')!.getBoundingClientRect();
      return { left: first.left - rect.left, padding: getComputedStyle(element).paddingInline };
    });
    expect(edges).toEqual({ left: 0, padding: '0px' });
    const toggle = page.getByRole('button', { name: focused ? '退出專注模式' : '進入專注模式', exact: true });
    await page.keyboard.press('Tab');
    await toggle.focus();
    expect(await toggle.evaluate(element => {
      const css = getComputedStyle(element);
      return css.outlineStyle !== 'none' && Number.parseFloat(css.outlineOffset) <= -Number.parseFloat(css.outlineWidth);
    })).toBe(true);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`tab-edges-${focused}.png`), fullPage: true });
    await strip.evaluate(element => { (element as HTMLElement).style.maxWidth = '320px'; });
    expect(await strip.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    for (const end of [false, true]) {
      await strip.evaluate((element, end) => { element.scrollLeft = end ? element.scrollWidth : 0; }, end);
      const box = (await strip.boundingBox())!;
      const button = (await toggle.boundingBox())!;
      expect(Math.abs(button.x + button.width - box.x - box.width)).toBeLessThanOrEqual(1);
      await expect(toggle).toBeInViewport();
    }
    await strip.evaluate(element => { (element as HTMLElement).style.maxWidth = ''; });
  }
  await page.getByRole('button', { name: '退出專注模式', exact: true }).press('Enter');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
});
