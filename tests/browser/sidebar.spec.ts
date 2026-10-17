import { expect, test } from '@playwright/test';
for (const viewport of [{ width: 1200, height: 850 }, { width: 1000, height: 650 }]) {
test(`sidebar drag, collapse, navigation and reload at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
  await page.setViewportSize(viewport);
  await page.goto('/tests/browser/sidebar.html');
  const handles = page.getByRole('button', { name: /^排序 / });
  await expect(handles).toHaveCount(3);
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 文件與設計');
  const list = page.getByRole('navigation', { name: '專案', exact: true });
  await expect(page.locator('.agent-status-overview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收合 工作台介面 的分頁' })).toHaveAttribute('aria-expanded', 'true');
  // Adjacent parent targets must remain usable with the nested tabs expanded.
  const visibleRows = await list.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll('.project-row')].slice(0, 2).map(row => row.getBoundingClientRect());
    return rows.every(row => row.top >= bounds.top && row.bottom <= bounds.bottom);
  });
  expect(visibleRows).toBe(true);
  await list.scrollIntoViewIfNeeded();
  for (const [name, atTop] of [['排序 API 開發', false], ['排序 文件與設計', true]] as const) {
    const receivesPointer = await page.getByRole('button', { name, exact: true }).evaluate((element, top) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + (top ? 10 : rect.width / 2), rect.top + (top ? 1 : rect.height / 2));
      return hit !== null && element.contains(hit);
    }, atTop);
    expect(receivesPointer).toBe(true);
  }
  await expect(page.getByRole('button', { name: /上移|下移/ })).toHaveCount(0);
  const from = (await page.getByRole('button', { name: '排序 API 開發', exact: true }).boundingBox())!;
  const to = (await handles.first().boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + 1, { steps: 12 });
  await expect(page.locator('.project-group.reorder-dragging')).toHaveCount(1);
  await expect.poll(async () => (await handles.first().boundingBox())!.y).toBeGreaterThan(to.y + 10);
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 文件與設計');
  await page.screenshot({ path: info.outputPath('sidebar-during-drag.png') });
  await page.mouse.up();
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 API 開發');
  await page.screenshot({ path: info.outputPath('sidebar-expanded.png') });
  await page.getByRole('button', { name: '專案', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜尋專案' })).toBeHidden();
  await expect(page.getByRole('button', { name: /開啟工作區/ })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: '專案', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.open-workspaces')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('sidebar-collapsed.png') });
  await page.getByRole('button', { name: '專案', exact: true }).click();
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 API 開發');
  await handles.first().focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect(handles.nth(1)).toBeFocused();
  await expect(handles.nth(1)).toHaveAttribute('aria-label', '排序 API 開發');
});

}


test('expanded project child tab is not a project reorder target', async ({ page }, info) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.goto('/tests/browser/sidebar.html');
  const handles = page.getByRole('button', { name: /^排序 / });
  const before = await handles.evaluateAll(elements => elements.map(el => el.getAttribute('aria-label')));
  const child = page.getByRole('button', { name: /開啟工作區 工作台介面/ });
  await child.scrollIntoViewIfNeeded();
  const source = (await handles.first().boundingBox())!;
  const target = (await child.boundingBox())!;
  await page.mouse.move(source.x + 10, source.y + 10); await page.mouse.down();
  await page.mouse.move(target.x + 10, target.y + target.height / 2, { steps: 12 });
  await expect(page.locator('.project-group.reorder-dragging')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('sidebar-child-drop-rejected.png') });
  await page.mouse.up();
  await expect.poll(() => handles.evaluateAll(elements => elements.map(el => el.getAttribute('aria-label')))).toEqual(before);
  await child.click();
  await expect(page.locator('.workspace-tab.active')).toBeVisible();
});
