import { readFileSync } from 'node:fs';
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
      fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 7 });
      fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 7 });
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
    const workspaceTab = page.locator('.workspace-tab-select').filter({ has: page.locator('.runtime-activity') });
    expect(await workspaceTab.first().evaluate(element => {
      const indicator = element.querySelector('.runtime-activity')!.getBoundingClientRect();
      const name = element.querySelector('.workspace-tab-name')!.getBoundingClientRect();
      return indicator.right <= name.left;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('known-status-left-no-unknown.png'), fullPage: true });
    const global = page.getByRole('button', { name: /開啟工作區 臨時 Terminal 已保留的 grok/ });
    await global.click();
    await expect(page.locator('.pane-position:visible .agent-lifecycle')).toHaveText('程序存活 · 活動未知');
    await expect(page.locator('.sidebar-bottom')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '設定與資料來源' })).toBeEnabled();
  });
}

test('fresh output pulses locally, unread clears on visible foreground work, reduced motion is static', async ({ page }, info) => {
  await page.goto('/tests/browser/agent-status.html');
  const tab = page.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex' });
  const indicator = tab.locator('.runtime-activity');
  await expect(indicator).toHaveCount(0);
  await expect(tab.locator('.lucide-circle-help, .runtime-output-dot')).toHaveCount(0);
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
  await expect(indicator).toHaveCount(0);
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
    const addProject = page.locator('.add-project');
    for (const revealed of [false, true]) {
      if (revealed) {
        await tab.scrollIntoViewIfNeeded(); await tab.click();
        await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
        await page.getByRole('button', { name: '展開完整控制列', exact: true }).click();
      }
      for (const control of [search, tab, addProject]) {
        await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await expect(control).toBeInViewport({ ratio: 1 });
        expect(await control.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${label}-${revealed ? 'focus-reveal' : 'normal'}-controls.png`) });
      await search.fill('no matching synthetic project');
      await expect(page.locator('.project-runtime-tabs')).toHaveCount(0);
      await expect(page.locator('.open-workspaces')).toBeVisible();
      await addProject.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await expect(addProject).toBeInViewport({ ratio: 1 });
      expect(await addProject.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
      await page.screenshot({ path: info.outputPath(`${label}-${revealed ? 'focus-reveal' : 'normal'}-filtered-footer.png`) });
      await search.fill('');
      // Tab navigation must bring the search back after scrolling elsewhere.
      await search.focus();
      await page.keyboard.press('Shift+Tab');
      await addProject.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
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


test('successful Agent exit removes only its tab, while abnormal Agent and original Shell remain', async ({ page }) => {
  await page.goto('/tests/browser/agent-status.html');
  const project = page.locator('.project-group').filter({ has: page.getByRole('button', { name: /^工作台介面 / }) });
  const tab = project.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex' });
  await expect(project).toContainText('3 分頁 · 2 Agent');
  await tab.click();
  await page.evaluate(() => {
    const fixture = (window as unknown as { agentStatusFixture: { emit: (event: unknown) => void } }).agentStatusFixture;
    fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
    fixture.emit({ type: 'exit', runtimeId: 'runtime-a', exitCode: 0 });
  });
  await expect(tab).toHaveCount(0);
  await expect(project).toContainText('2 分頁 · 1 Agent');
  await expect(project.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 claude' })).toBeVisible();
  await expect(project.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 Shell' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { agentStatusFixture: { operations: string[] } }).agentStatusFixture.operations))
    .toEqual(['forget:runtime-a']);
});

// Rust serde and the actual App consume this same synthetic wire contract.
test('ordered observations propagate without PTY activity and expire conservatively', async ({ page }, info) => {
  await page.goto('/tests/browser/agent-status.html');
  const project = page.locator('.project-group').filter({ has: page.getByRole('button', { name: /^工作台介面 / }) });
  const tab = project.getByRole('button', { name: '開啟工作區 工作台介面 已保留的 codex' });
  await tab.click();
  await expect(page.locator('.runtime-connecting')).toHaveCount(0);
  const event = JSON.parse(readFileSync(new URL('../../fixtures/agent-activity/busy-event.json', import.meta.url), 'utf8'));
  const emit = async (patch: Record<string, unknown>) => page.evaluate(value => {
    (window as unknown as { agentStatusFixture: { emit: (event: unknown) => void } }).agentStatusFixture.emit(value);
  }, { ...event, ...patch });
  await emit({ validForMs: 3000 });
  const sidebarStatus = tab.locator('.runtime-activity');
  const workspaceStatus = page.locator('.workspace-tab').filter({ hasText: '已保留的 codex' }).locator('.runtime-activity');
  await expect(sidebarStatus).toHaveAttribute('aria-label', /Agent 最近回報：工作中/);
  await expect(workspaceStatus).toHaveAttribute('aria-label', /Agent 最近回報：工作中/);
  await expect(sidebarStatus.locator('.runtime-output-dot')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('structured-report-left.png') });
  await emit({ revision: 2, observation: 'turnStopRequested', validForMs: 800 });
  await expect(sidebarStatus).toHaveAttribute('aria-label', /收到回合停止請求/);
  await expect(sidebarStatus).not.toHaveAttribute('aria-label', /閒置/);
  await emit({ revision: 1, observation: 'idle', validForMs: 30000 });
  await expect(sidebarStatus).toHaveCount(0);
  await emit({ generation: 'next-generation', revision: 0, observation: null, validForMs: 0 });
  await emit({ revision: 99, validForMs: 30000 });
  await expect(sidebarStatus).toHaveCount(0);
  await emit({ generation: 'next-generation', revision: 1, validForMs: 3000 });
  await expect(sidebarStatus).toHaveAttribute('aria-label', /Agent 最近回報/);
  await emit({ type: 'disconnected', message: 'Synthetic connection loss' });
  await emit({ generation: 'next-generation', revision: 2, validForMs: 30000 });
  await expect(sidebarStatus).not.toHaveAttribute('aria-label', /Agent 最近回報/);
  expect(await page.evaluate(() => (window as unknown as { agentStatusFixture: { operations: string[] } }).agentStatusFixture.operations)).toEqual([]);
});
