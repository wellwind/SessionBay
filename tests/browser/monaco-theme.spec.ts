import { expect, test } from '@playwright/test';

test('UI palette recolors the existing Monaco preview and preserves selection on restore', async ({ page }, info) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'large.ts', exact: true }).dblclick();
  const editor = page.getByLabel('唯讀內容：large.ts');
  await expect(editor.locator('.view-line').first()).toBeVisible();
  await editor.focus();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const snapshot = () => editor.evaluate(node => ({
    lines: [...node.querySelectorAll('.view-line')].map(line => line.textContent),
    selected: [...node.querySelectorAll('.selected-text')].map(part => part.getAttribute('style')),
  }));
  await expect(editor.locator('.selected-text').first()).toBeVisible();
  const before = await snapshot();
  const initial = await editor.locator('.monaco-editor').evaluate(node => {
    (window as unknown as { paletteEditor: Element }).paletteEditor = node;
    return getComputedStyle(node).backgroundColor;
  });
  for (const [mode, palette, expected] of [
    ['dark', 'ocean', 'rgb(13, 25, 41)'],
    ['light', 'code-modern', 'rgb(255, 255, 255)'],
    ['dark', 'code-2026', 'rgb(18, 19, 20)'],
  ]) {
    // Same attributes owned by useUiTheme for settings/command previews.
    await page.evaluate(({ mode, palette }) => {
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.themePalette = palette;
    }, { mode, palette });
    await expect(editor.locator('.monaco-editor')).toHaveCSS('background-color', expected);
    expect(await snapshot()).toEqual(before);
    expect(await editor.locator('.monaco-editor').evaluate(node =>
      node === (window as unknown as { paletteEditor: Element }).paletteEditor)).toBe(true);
    await page.screenshot({ path: info.outputPath(`editor-${palette}-${mode}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.themePalette = 'bay';
  });
  await expect(editor.locator('.monaco-editor')).toHaveCSS('background-color', initial);
  expect(await snapshot()).toEqual(before);
  expect(failures).toEqual([]);
});
