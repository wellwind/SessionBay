import { expect, test } from '@playwright/test';
for (const width of [1200, 720]) {
  test(`project files work without runtime and replace single-click previews at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tests/browser/workspace-focus-mode.html');
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
    await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '.config', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /隱藏/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '最大化檔案區' })).toHaveCount(0);
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await expect(page.getByLabel('唯讀內容：README.md')).toContainText('<script>');
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'index.ts', exact: true }).click();
    await expect(page.getByLabel('唯讀內容：src/index.ts')).toContainText('export const');
    const tabs = page.locator('.project-file-tabs-host');
    await expect(tabs.getByRole('tab')).toHaveCount(1);
    await expect(tabs.getByRole('tab', { name: /index.ts/ })).toBeVisible();
    await tabs.getByRole('tab', { name: /index.ts/ }).dblclick();
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('button', { name: /outside-link/ })).toBeDisabled();
    const parentRow = page.getByRole('button', { name: 'src', exact: true });
    const childRow = page.getByRole('button', { name: 'index.ts', exact: true });
    await expect(parentRow).toHaveCSS('justify-content', 'flex-start');
    await expect(childRow).toHaveCSS('justify-content', 'flex-start');
    expect((await childRow.boundingBox())!.x).toBeGreaterThan((await parentRow.boundingBox())!.x);
    const geometry = await page.evaluate(() => {
      const files = document.querySelector('.project-files-sidebar:not([hidden])')!.getBoundingClientRect();
      const work = document.querySelector('.project-work-content')!.getBoundingClientRect();
      const preview = document.querySelector('[data-file-explorer]')!.getBoundingClientRect();
      return { filesRight: files.right, workLeft: work.left, top: preview.top - work.top, bottom: work.bottom - preview.bottom, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(geometry.filesRight).toBeLessThanOrEqual(geometry.workLeft);
    expect(Math.abs(geometry.top)).toBeLessThan(1);
    expect(Math.abs(geometry.bottom)).toBeLessThan(1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
    await page.screenshot({ path: testInfo.outputPath(`workspace-files-no-runtime-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string; showHidden?: boolean }[] } }).focusFixture.calls.filter(call => call.command === 'list_workspace_files').every(call => call.showHidden === true))).toBe(true);
  });
}

test('file tabs belong to the project across runtime switches and closing files preserves both terminals', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?edge=1');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm')).toHaveCount(2);
  await page.evaluate(() => Object.assign(window, { savedTerminals: [...document.querySelectorAll('.xterm')] }));
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).dblclick();
  const tabs = page.locator('.project-file-tabs-host');
  await expect(tabs.getByRole('tab')).toHaveCount(1);
  await page.locator('.workspace-tab-select').filter({ hasText: 'Hidden shell' }).click();
  await expect(page.getByRole('region', { name: 'Hidden shell 終端面板', exact: true }).locator('.xterm')).toBeVisible();
  await tabs.getByRole('tab', { name: /README.md/ }).click();
  await expect(page.getByLabel('唯讀內容：README.md')).toBeVisible();
  await expect(page.locator('.xterm:visible')).toHaveCount(0);
  await tabs.getByRole('button', { name: '關閉檔案 README.md', exact: true }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Hidden shell 終端面板', exact: true }).locator('.xterm')).toBeVisible();
  expect(await page.evaluate(() => {
    const saved = (window as unknown as { savedTerminals: Element[] }).savedTerminals;
    return [...document.querySelectorAll('.xterm')].every((node, index) => node === saved[index]);
  })).toBe(true);
  const calls = await page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string }[] } }).focusFixture.calls);
  expect(calls.filter(call => ['launch_runtime', 'detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))).toEqual([]);
  expect(calls.filter(call => call.command === 'attach_runtime')).toHaveLength(2);
});

test('split drag uses only terminal surface beside the project sidebar', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html?edge=1');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await page.getByRole('region', { name: 'Focus shell 終端面板', exact: true }).getByRole('button', { name: '左右分割', exact: true }).click();
  await page.getByRole('button', { name: '開始工作', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(0);
  await page.locator('.workspace-tab-select').filter({ hasText: 'Focus shell' }).click();
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(2);
  const surface = await page.locator('.workspace-terminal-surface').boundingBox();
  const divider = page.getByRole('separator', { name: '左右面板比例' });
  const handle = await divider.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
  await page.mouse.down();
  await page.mouse.move(surface!.x + surface!.width * 0.7, handle!.y + 100);
  await page.mouse.up();
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBe(70);
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.locator('.xterm-screen:visible')).toHaveCount(2);
});
