import { expect, test } from '@playwright/test';
for (const width of [1200, 720]) {
  test(`read-only files preserve live terminal at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tests/browser/workspace-files.html');
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.getByRole('button', { name: '檔案預覽', exact: true }).click();
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await expect(page.getByLabel('唯讀內容：README.md')).toContainText('<script>');
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'index.ts', exact: true }).click();
    await expect(page.getByLabel('唯讀內容：src/index.ts')).toContainText('export const');
    await expect(page.getByRole('button', { name: /outside-link/ })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`workspace-files-${width}.png`), fullPage: true });
    const geometry = await page.evaluate(() => {
      const terminal = document.querySelector('.workspace-terminal-surface')!.getBoundingClientRect();
      const files = document.querySelector('.workspace-files-pane')!.getBoundingClientRect();
      return { terminalRight: terminal.right, filesLeft: files.left, right: files.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.terminalRight).toBeLessThanOrEqual(geometry.filesLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
    await page.getByLabel('唯讀內容：src/index.ts').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '檔案預覽', exact: true })).toBeFocused();
    await expect(page.locator('.xterm-screen')).toBeVisible();
  });
}
