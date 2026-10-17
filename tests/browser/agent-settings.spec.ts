import { expect, test } from '@playwright/test';
for (const mode of ['dark', 'light']) {
  for (const size of [{ width: 1200, height: 900 }, { width: 560, height: 700 }, { width: 360, height: 700 }]) {
    test(`${mode} ${size.width}: selected agent settings stay usable`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.goto(`/tests/browser/agent-settings.html?theme=${mode}`);
      await expect(page.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Claude Code 執行檔路徑' })).toHaveCount(0);
      const picker = page.getByRole('combobox', { name: '搜尋 Agent' });
      await picker.click();
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('tool-dropdown.png'), fullPage: true });
      await picker.fill('grok');
      await picker.press('Enter');
      await expect(page.getByRole('checkbox', { name: '啟用 Grok Build', exact: true })).not.toBeChecked();
      await expect(page.getByRole('textbox', { name: 'Grok Build 執行檔路徑' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveCount(0);
      await page.getByRole('checkbox', { name: '啟用 Grok Build', exact: true }).check();
      await expect(page.getByRole('button', { name: '儲存設定' })).toBeVisible();
      expect(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('agent-settings.png'), fullPage: true });
      await page.getByRole('combobox', { name: '搜尋 Agent' }).fill('no-such-provider');
      await expect(page.getByRole('status').filter({ hasText: '沒有符合的 Agent' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Grok Build 執行檔路徑' })).toHaveCount(1);
      await picker.press('Escape');
      await expect(picker).toHaveValue('Grok Build');
      await expect(picker).toBeFocused();
      await expect(page.getByRole('dialog', { name: '工作台設定' })).toBeVisible();
      await picker.press('ArrowDown');
      await picker.fill('codex');
      await picker.press('Enter');
      await picker.click();
      await picker.fill('grok');
      await picker.press('Enter');
      await expect(page.getByRole('checkbox', { name: '啟用 Grok Build', exact: true })).toBeChecked();
    });
  }
}

for (const palette of ['bay', 'code-modern', 'code-2026']) for (const theme of ['dark', 'light']) {
  test(`consistent dropdown ${palette} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 800, height: 850 });
    await page.goto(`/tests/browser/agent-settings.html?theme=${theme}&palette=${palette}`);
    const picker = page.getByRole('combobox', { name: '搜尋 Agent' });
    await picker.focus();
    await picker.press('ArrowDown');
    await picker.press('ArrowUp');
    await expect(picker).toBeFocused();
    const styles = await picker.evaluate(input => {
      const field = input.parentElement!;
      const popup = document.querySelector('.searchable-select-options')!;
      const read = (element: Element) => {
        const css = getComputedStyle(element);
        return { background: css.backgroundColor, border: css.borderColor, outline: css.outlineStyle, shadow: css.boxShadow };
      };
      return { input: read(input), field: read(field), popup: read(popup) };
    });
    await info.attach('styles', { body: JSON.stringify(styles), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('dropdown-focus.png'), fullPage: true });
    expect(styles.input.outline).toBe('none');
    expect(styles.input.shadow).toBe('none');
    expect(styles.field.outline).toBe('solid');
    expect(styles.popup.background).toBe(styles.field.background);
    expect(styles.popup.border).toBe(styles.field.border);
    await picker.press('Enter');
    await expect(picker).toHaveValue('Codex');
    await picker.press('ArrowDown');
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await expect(picker).toHaveValue('Claude Code');
    await picker.press('ArrowDown');
    await picker.press('ArrowUp');
    await picker.press('Escape');
    await expect(picker).toHaveValue('Claude Code');
    await expect(picker).toBeFocused();
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
  });
}