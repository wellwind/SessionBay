import { expect, test } from '@playwright/test';

test('real App mouse tab reorder persists without changing active tab or other projects', async ({ page }, info) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const tabs = page.locator('.workspace-tab-select');
  await expect(tabs).toHaveText(['Tab a1', 'Tab b1', 'Tab c1']);
  await tabs.nth(2).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 12 } });
  await expect(tabs).toHaveText(['Tab c1', 'Tab a1', 'Tab b1']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test') || '{}').tabs?.map((tab: { id: string }) => tab.id))).toEqual(['c', 'other', 'a', 'global-a', 'b', 'global-b']);
  await page.screenshot({ path: info.outputPath('workspace-tabs-reordered.png') });
  await page.reload();
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  await expect(tabs).toHaveText(['Tab c1', 'Tab a1', 'Tab b1']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await tabs.nth(0).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(tabs).toHaveText(['Tab a1', 'Tab c1', 'Tab b1']);
  await expect(tabs.nth(1)).toBeFocused();
});

test('pointer cancellation never saves, plain clicks and close stay distinct, global tabs reorder', async ({ page }) => {
  await page.goto('/tests/browser/workspace-tabs.html');
  await page.getByRole('button', { name: '開啟工作區 工作台介面 Tab b', exact: true }).click();
  const tabs = page.locator('.workspace-tab-select');
  const from = (await tabs.nth(0).boundingBox())!;
  const to = (await tabs.nth(2).boundingBox())!;
  await page.mouse.move(from.x + 15, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(to.x + 15, to.y + 12, { steps: 12 });
  await expect(page.locator('.workspace-tab.drop-before')).toHaveCount(1);
  await expect(tabs).toHaveText(['Tab a1', 'Tab b1', 'Tab c1']);
  const before = await page.evaluate(() => localStorage.getItem('workspace-test'));
  await page.waitForTimeout(500); // exceeds App's save debounce while the pointer is held
  expect(await page.evaluate(() => localStorage.getItem('workspace-test'))).toBe(before);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(tabs).toHaveText(['Tab a1', 'Tab b1', 'Tab c1']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab b');
  await tabs.nth(0).click();
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab a');
  await page.getByRole('button', { name: '關閉分頁 Tab c', exact: true }).click();
  await expect(tabs).toHaveText(['Tab a1', 'Tab b1']);
  await page.getByRole('button', { name: '開啟工作區 臨時 Terminal Tab global-a', exact: true }).click();
  await expect(tabs).toHaveText(['Tab global-a1', 'Tab global-b1']);
  await tabs.nth(1).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 12 } });
  await expect(tabs).toHaveText(['Tab global-b1', 'Tab global-a1']);
  await expect(page.locator('.workspace-tab.active .workspace-tab-name')).toHaveText('Tab global-a');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('workspace-test') || '{}').tabs?.filter((tab: { projectId: string | null }) => tab.projectId === null).map((tab: { id: string }) => tab.id))).toEqual(['global-b', 'global-a']);
  await page.reload();
  await page.getByRole('button', { name: '開啟工作區 臨時 Terminal Tab global-a', exact: true }).click();
  await expect(tabs).toHaveText(['Tab global-b1', 'Tab global-a1']);
});
