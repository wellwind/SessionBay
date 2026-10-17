import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1200, height: 900 }, { width: 1000, height: 650 }]) {
  test(`project tree preserves lifecycle, focus and compact layout at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/tests/browser/agent-status.html');
    await expect(page.locator('.agent-status-overview')).toHaveCount(0);
    const project = page.locator('.project-group').filter({ has: page.getByRole('button', { name: /^工作台介面 / }) });
    await expect(project).toContainText('3 分頁 · 2 Agent');
    await expect(project).toContainText('活動未知');
    await expect(project.locator('.project-count')).toHaveText('99');
    const tab = project.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex' });
    await tab.scrollIntoViewIfNeeded();
    await expect(tab).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('project-runtime-tree.png'), fullPage: true });
    await page.getByRole('button', { name: '收合 工作台介面 的分頁' }).click();
    await expect(tab).toBeHidden();
    await page.getByRole('button', { name: '展開 工作台介面 的分頁' }).click();
    await expect(tab).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as unknown as { agentStatusFixture: { emit: (event: unknown) => void } }).agentStatusFixture;
      fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
      fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
    });
    await expect(tab).toHaveAttribute('title', /已結束/);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.pane-position:visible .agent-lifecycle')).toHaveText('已結束');
    const global = page.getByRole('button', { name: /開啟工作區 臨時 Terminal 已保留的 grok/ });
    await global.click();
    await expect(page.locator('.pane-position:visible .agent-lifecycle')).toHaveText('程序存活 · 活動未知');
    await page.locator('.sidebar-bottom').scrollIntoViewIfNeeded();
    await expect(page.locator('.sidebar-bottom')).toBeInViewport();
  });
}

test('fresh output pulses locally, unread clears on visible foreground work, reduced motion is static', async ({ page }, info) => {
  await page.goto('/tests/browser/agent-status.html');
  const tab = page.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex' });
  const indicator = tab.locator('.runtime-activity');
  await expect(indicator).not.toHaveAttribute('title', /有新輸出/);
  await expect(indicator.locator('.runtime-connecting')).toHaveCount(0);
  const emit = async (sequence: number) => page.evaluate(sequence => {
    (window as unknown as { agentStatusFixture: { emit: (event: unknown) => void } }).agentStatusFixture.emit({
      type: 'output', runtimeId: 'runtime-a', sequence, data: [65],
    });
  }, sequence);
  await emit(2);
  await expect(indicator).toHaveAttribute('title', /有新輸出.*未讀輸出/);
  await expect(indicator.locator('.runtime-output-dot')).toHaveClass(/recent/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await indicator.locator('.runtime-output-dot').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: info.outputPath('output-activity-reduced-motion.png'), fullPage: true });
  await expect(indicator).not.toHaveAttribute('title', /有新輸出/);
  await expect(indicator).toHaveAttribute('title', /未讀輸出/);
  await page.bringToFront();
  await tab.click();
  await expect(indicator).not.toHaveAttribute('title', /未讀輸出/);
  await emit(3);
  await expect(indicator).toHaveAttribute('title', /有新輸出/);
  await expect(indicator).not.toHaveAttribute('title', /未讀輸出/);
  // Window-background semantics are deterministic without invoking a real Agent.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await emit(4);
  await expect(indicator).toHaveAttribute('title', /未讀輸出/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(indicator).not.toHaveAttribute('title', /未讀輸出/);
});
