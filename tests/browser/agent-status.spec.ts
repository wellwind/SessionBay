import { expect, test } from '@playwright/test';

test('actual App shows per-project and global Agent lifecycle without Shell or history counts', async ({ page }, testInfo) => {
  await page.goto('/tests/browser/agent-status.html');
  const overview = page.locator('.agent-status-overview');
  await expect(overview).toContainText('2 存活 / 4 已開啟');
  const project = overview.locator('.agent-status-project').filter({ hasText: '工作台介面' });
  await project.locator('summary').click();
  await expect(project).toContainText('已開啟 2 · 存活 1 · 已結束 1 · 中斷 0');
  await expect(project).toContainText('程序存活 · 活動未知');
  const global = overview.locator('.agent-status-project').filter({ hasText: '全域工作階段' });
  await global.locator('summary').click();
  await expect(global).toContainText('已開啟 1 · 存活 1');
  await overview.scrollIntoViewIfNeeded();
  const geometry = await overview.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const heading = element.querySelector(':scope > summary')!.getBoundingClientRect();
    const content = element.querySelector('.agent-status-content')!;
    const bounds = content.getBoundingClientRect();
    return { outerHeight: outer.height, headingInside: heading.top >= outer.top && heading.bottom <= outer.bottom,
      contentInside: bounds.top >= heading.bottom && bounds.bottom <= outer.bottom,
      outerScroll: element.scrollTop, contentHeight: bounds.height };
  });
  expect(geometry.outerHeight).toBeGreaterThan(150);
  expect(geometry.headingInside).toBe(true);
  expect(geometry.contentInside).toBe(true);
  expect(geometry.outerScroll).toBe(0);
  expect(geometry.contentHeight).toBeLessThanOrEqual(228);
  await page.screenshot({ path: testInfo.outputPath('agent-status-overview.png'), fullPage: true });
  // Reaching the footer must not squeeze or scroll the Agent heading out of its section.
  const footer = page.locator('.sidebar-bottom');
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeInViewport();
  await overview.scrollIntoViewIfNeeded();
  await expect(overview.locator(':scope > summary')).toBeInViewport();
  // A hidden project's subscribed runtime updates before selecting its workspace.
  await page.evaluate(() => {
    const fixture = (window as unknown as { agentStatusFixture: { emit: (event: unknown) => void } }).agentStatusFixture;
    fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
    fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
  });
  await expect(project).toContainText('已開啟 2 · 存活 0 · 已結束 2 · 中斷 0');
  await expect(overview).toContainText('1 存活 / 4 已開啟');
  await global.getByRole('button').click();
  await expect(page.locator('.pane-position:visible .agent-lifecycle')).toHaveText('程序存活 · 活動未知');
  await overview.locator(':scope > summary').click();
  await expect(overview).not.toHaveAttribute('open');
  await overview.locator(':scope > summary').click();
  await expect(overview).toHaveAttribute('open');
  await expect(global).toContainText('已開啟 1 · 存活 1');
});


test('compact sidebar keeps the Agent heading, project counts and footer reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.goto('/tests/browser/agent-status.html');
  const overview = page.locator('.agent-status-overview');
  await expect(overview).toContainText('2 存活 / 4 已開啟');
  await overview.scrollIntoViewIfNeeded();
  await expect(overview.locator(':scope > summary')).toBeInViewport();
  const summary = overview.locator('.agent-status-project').filter({ hasText: '工作台介面' }).locator('summary');
  await summary.click();
  await expect(summary).toBeInViewport();
  expect(await overview.evaluate((element) => element.scrollTop)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('agent-status-compact.png'), fullPage: true });
  await page.locator('.sidebar-bottom').scrollIntoViewIfNeeded();
  await expect(page.locator('.sidebar-bottom')).toBeInViewport();
  await overview.locator(':scope > summary').click();
  await expect(overview).not.toHaveAttribute('open');
  await overview.locator(':scope > summary').click();
  await expect(overview).toHaveAttribute('open');
  await expect(summary).toContainText('已開啟 2 · 存活 1 · 已結束 1 · 中斷 0');
});
