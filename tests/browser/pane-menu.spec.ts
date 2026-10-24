import { expect, test } from '@playwright/test';

// Narrow split panes collapse their actions into a ⋯ menu; the popover must open
// under that pane's own trigger, not at a fixed window corner.
test('split pane menus anchor to their own trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/browser/workspace-focus-mode.html?edge');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await page.getByRole('button', { name: '左右分割', exact: true }).click();
  await page.getByRole('button', { name: '開始工作', exact: true }).click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  for (const pane of await page.locator('.terminal-pane:visible').all()) {
    const trigger = pane.getByRole('button', { name: /^面板選項 / });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = pane.locator('.is-compact > .responsive-control-content:not([hidden])');
    await expect(menu).toBeVisible();
    const t = (await trigger.boundingBox())!;
    const m = (await menu.boundingBox())!;
    expect(Math.abs(m.x + m.width - (t.x + t.width))).toBeLessThanOrEqual(2);
    expect(m.y).toBeGreaterThanOrEqual(t.y + t.height);
    expect(m.y).toBeLessThanOrEqual(t.y + t.height + 8);
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});
