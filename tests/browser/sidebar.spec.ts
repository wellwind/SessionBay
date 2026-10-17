import { expect, test } from '@playwright/test';
for (const viewport of [{ width: 1200, height: 850 }, { width: 1000, height: 650 }]) {
test(`sidebar drag, collapse, navigation and reload at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
  await page.setViewportSize(viewport);
  await page.goto('/tests/browser/sidebar.html');
  const handles = page.getByRole('button', { name: /^排序 / });
  await expect(handles).toHaveCount(3);
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 文件與設計');
  const list = page.getByRole('navigation', { name: '專案', exact: true });
  await expect(page.locator('.agent-status-overview')).toBeVisible();
  // Adjacent drag targets must fit together, even with the Agent section expanded.
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
  await page.getByRole('button', { name: '排序 API 開發', exact: true }).dragTo(page.getByRole('button', { name: '排序 文件與設計', exact: true }), { targetPosition: { x: 10, y: 1 } });
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 API 開發');
  await page.screenshot({ path: info.outputPath('sidebar-expanded.png') });
  await page.getByRole('button', { name: '專案', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜尋專案' })).toBeHidden();
  await expect(page.getByRole('button', { name: /開啟工作區/ })).toBeVisible();
  await page.getByRole('button', { name: '開啟中的工作區', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '專案', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '開啟中的工作區', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: info.outputPath('sidebar-collapsed.png') });
  await page.getByRole('button', { name: '專案', exact: true }).click();
  await expect(handles.first()).toHaveAttribute('aria-label', '排序 API 開發');
  await handles.first().focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect(handles.nth(1)).toBeFocused();
  await expect(handles.nth(1)).toHaveAttribute('aria-label', '排序 API 開發');
});

}
