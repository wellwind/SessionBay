import { expect, test } from '@playwright/test';
for (const mode of ['dark', 'light']) {
  for (const size of [{ width: 1200, height: 900 }, { width: 560, height: 700 }]) {
    test(`${mode} ${size.width}: selected agent settings stay usable`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.goto(`/tests/browser/agent-settings.html?theme=${mode}`);
      await expect(page.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Claude Code 執行檔路徑' })).toHaveCount(0);
      await page.getByRole('button', { name: /^Grok Build 已停用/ }).click();
      await expect(page.getByRole('checkbox', { name: '啟用 Grok Build', exact: true })).not.toBeChecked();
      await expect(page.getByRole('textbox', { name: 'Grok Build 執行檔路徑' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveCount(0);
      await page.getByRole('checkbox', { name: '啟用 Grok Build', exact: true }).check();
      await expect(page.getByRole('button', { name: '儲存設定' })).toBeVisible();
      expect(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('agent-settings.png'), fullPage: true });
      await page.getByRole('searchbox', { name: '搜尋 Agent' }).fill('no-such-provider');
      await expect(page.getByRole('status').filter({ hasText: '沒有符合的 Agent' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Grok Build 執行檔路徑' })).toHaveCount(1);
    });
  }
}
