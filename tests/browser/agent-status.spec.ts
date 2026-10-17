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
    await expect(tab).toHaveAttribute('title', '已保留的 codex');
    await expect(tab).toHaveAccessibleDescription(/已結束/);
    await tab.scrollIntoViewIfNeeded();
    expect(await tab.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const list = element.closest('.project-list')!.getBoundingClientRect();
      const add = document.querySelector('.add-project')!.getBoundingClientRect();
      return rect.top >= list.top && rect.bottom <= list.bottom && list.bottom <= add.top &&
        element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('project-runtime-reexpanded-hit-target.png'), fullPage: true });
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

for (const [label, width, height, scale] of [['short', 1000, 500, 1], ['css-zoom-200', 1600, 1000, 2]] as const) {
  test(`project tree controls stay reachable in ${label} and focus reveal`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto('/tests/browser/agent-status.html');
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
    await page.evaluate(scale => {
      const app = document.querySelector<HTMLElement>('.app-shell')!;
      app.style.zoom = String(scale);
      app.style.width = `${innerWidth / scale}px`;
      app.style.height = `${innerHeight / scale}px`;
    }, scale);
    const tab = page.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex', exact: true });
    const search = page.getByRole('textbox', { name: '搜尋專案', exact: true });
    const footer = page.locator('.sidebar-bottom button');
    for (const revealed of [false, true]) {
      if (revealed) {
        await tab.scrollIntoViewIfNeeded(); await tab.click();
        await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
        await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
      }
      for (const control of [search, tab, footer]) {
        await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await expect(control).toBeInViewport({ ratio: 1 });
        expect(await control.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${label}-${revealed ? 'focus-reveal' : 'normal'}-footer.png`) });
      await search.fill('no matching synthetic project');
      await expect(page.locator('.project-runtime-tabs')).toHaveCount(0);
      await expect(page.locator('.open-workspaces')).toBeVisible();
      await footer.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect(footer).toBeInViewport({ ratio: 1 });
      expect(await footer.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
      await page.screenshot({ path: info.outputPath(`${label}-${revealed ? 'focus-reveal' : 'normal'}-filtered-footer.png`) });
      await search.fill('');
      // Tab navigation must bring the search back after scrolling elsewhere.
      await search.focus();
      await page.keyboard.press('Shift+Tab');
      await footer.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.keyboard.press('Tab');
      await expect(search).toBeFocused();
      await expect(search).toBeInViewport();
      expect(await search.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);

    }
  });
}
