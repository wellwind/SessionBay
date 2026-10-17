import { expect, test } from '@playwright/test';
for (const theme of ['dark', 'light']) {
  test(`${theme}: consistent rows, selection, delete and keyboard focus`, async ({ page }, info) => {
    await page.goto(`/tests/browser/interactions.html?theme=${theme}`);
    await page.locator('.project-main').filter({ hasText: '工作台介面' }).click();
    const rows = page.getByRole('list', { name: 'Session 清單' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    const row = rows.nth(1);
    const select = row.locator('.session-card-select');
    const remove = row.getByRole('button', { name: /刪除 Session/ });
    const before = await row.boundingBox();
    await expect(remove).toHaveCSS('opacity', '0');
    await select.hover();
    await expect(remove).toHaveCSS('opacity', '1');
    expect(await row.boundingBox()).toEqual(before);
    await expect(select).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: info.outputPath(`${theme}-history-hover.png`) });
    await select.click();
    await expect(row).toHaveClass(/active/);
    await expect(select).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => row.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const selectedBackground = await row.evaluate(el => getComputedStyle(el).backgroundColor);
    await remove.hover();
    expect(await row.evaluate(el => getComputedStyle(el).backgroundColor)).not.toEqual(selectedBackground);
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('修正鍵盤焦點');
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await expect(remove).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: info.outputPath(`${theme}-history-keyboard.png`) });
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '確認移入資源回收筒' }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole('button', { name: '復原刪除' })).toBeFocused();
    const project = page.locator('.project-main').first();
    await project.hover();
    await expect(project).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: info.outputPath(`${theme}-sidebar-hover.png`) });
    const tab = page.locator('.workspace-tab-select').first();
    await tab.hover();
    await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: info.outputPath(`${theme}-tabs-hover.png`) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-current', 'true');
    await page.screenshot({ path: info.outputPath(`${theme}-workspace-toolbar.png`) });
    await page.getByRole('button', { name: '設定與資料來源', exact: true }).click();
    await page.locator('.settings-nav > button').first().hover();
    await page.screenshot({ path: info.outputPath(`${theme}-settings-hover.png`) });
  });
}
test('touch actions remain visible and reduced motion removes transitions', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1100, height: 850 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:1437/tests/browser/interactions.html');
  await page.locator('.project-main').filter({ hasText: '工作台介面' }).click();
  const remove = page.locator('.session-card-delete').first();
  await expect(remove).toHaveCSS('opacity', '1');
  await expect(remove).toHaveCSS('transition-duration', '0s');
  await context.close();
});

for (const theme of ['dark', 'light']) {
  test(`${theme}: long project title keeps rename adjacent at narrow width`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.goto(`/tests/browser/interactions.html?theme=${theme}&long=1`);
    await page.locator('.project-main').filter({ hasText: '工作台介面' }).click();
    const header = page.locator('.project-header');
    await expect(header.locator('.header-buttons > button:not(.icon-button)')).toHaveCount(2);
    await expect(header.getByRole('button', { name: '資源回收筒', exact: true })).toHaveClass('icon-button');
    await expect(header.getByRole('button', { name: '移出專案', exact: true })).toHaveAttribute('title', /不刪除對話/);
    const rename = page.getByRole('button', { name: '重新命名專案', exact: true });
    await expect(rename).toHaveAttribute('title', '重新命名專案');
    const bounds = await rename.evaluate(button => {
      const icon = button.getBoundingClientRect();
      const row = button.parentElement!.getBoundingClientRect();
      const heading = button.parentElement!.querySelector('h1')!.getBoundingClientRect();
      return { width: icon.width, inside: icon.right <= row.right && icon.left >= heading.right, rowRight: row.right };
    });
    expect(bounds.width).toBe(32);
    expect(bounds.inside).toBe(true);
    expect(bounds.rowRight).toBeLessThanOrEqual(1000);
    await rename.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '重新命名專案' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rename).toBeFocused();
    await page.screenshot({ path: info.outputPath(`${theme}-long-project-rename.png`) });
  });
}

for (const palette of ['code-modern', 'code-2026']) {
  for (const theme of ['dark', 'light']) {
    test(`${palette} ${theme}: only the primary tab action changes the tab surface`, async ({ page }, info) => {
      await page.goto(`/tests/browser/interactions.html?theme=${theme}&palette=${palette}`);
      await page.locator('.project-main').filter({ hasText: '工作台介面' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme-palette', palette);
      const tab = page.locator('.workspace-tab').first();
      const primary = tab.locator('.workspace-tab-select');
      const rename = tab.getByRole('button', { name: /重新命名分頁/ });
      const close = tab.getByRole('button', { name: /關閉分頁/ });
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const sample = document.createElement('div');
        document.body.append(sample);
        const values = Object.fromEntries(['code-tab-active', 'code-tab-inactive', 'code-tab-hover', 'surface-hover'].map(name => {
          sample.style.backgroundColor = root.getPropertyValue(`--${name}`);
          return [name, getComputedStyle(sample).backgroundColor];
        }));
        sample.remove();
        return values;
      });
      for (const selected of [false, true]) {
        if (selected) await primary.click();
        await page.locator('h1').hover();
        const resting = colors[selected ? 'code-tab-active' : 'code-tab-inactive'];
        await expect(tab).toHaveCSS('background-color', resting);
        const border = await tab.evaluate(el => getComputedStyle(el).borderTopColor);
        await primary.hover();
        await expect(tab).toHaveCSS('background-color', colors['code-tab-hover']);
        await expect(primary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(tab).toHaveCSS('border-top-color', border);
        if (selected) await page.screenshot({ path: info.outputPath(`${palette}-${theme}-primary-hover.png`) });
        for (const [name, secondary] of [['rename', rename], ['close', close]] as const) {
          await secondary.hover();
          await expect(tab).toHaveCSS('background-color', resting);
          await expect(secondary).toHaveCSS('background-color', colors['surface-hover']);
          await expect(primary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
          await expect(tab).toHaveCSS('border-top-color', border);
          if (selected) {
            await expect(primary).toHaveAttribute('aria-current', 'true');
            await page.screenshot({ path: info.outputPath(`${palette}-${theme}-${name}-hover.png`) });
          }
        }
      }
      await primary.focus();
      await page.keyboard.press('Tab');
      await expect(rename).toBeFocused();
      await expect(rename).toHaveCSS('outline-offset', '-3px');
    });
  }
}
