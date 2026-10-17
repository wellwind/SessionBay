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
  await page.screenshot({ path: testInfo.outputPath('agent-status-overview.png'), fullPage: true });
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
