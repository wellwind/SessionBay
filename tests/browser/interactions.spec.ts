import { expect, test } from '@playwright/test';
for (const theme of ['dark', 'light']) {
  test(`${theme}: consistent rows, selection, delete and keyboard focus`, async ({ page }, info) => {
    await page.goto(`/tests/browser/interactions.html?theme=${theme}`);
    await page.locator('.project-main').filter({ hasText: '工作台介面' }).click();
    await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
    const rows = page.getByRole('list', { name: 'Session 清單' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    const row = rows.nth(1).locator('.session-card');
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
    const undo = page.getByRole('button', { name: '復原刪除' });
    const dismiss = page.getByRole('button', { name: '關閉復原提示' });
    await expect(undo).toBeFocused();
    const undoBox = await undo.boundingBox();
    const dismissBox = await dismiss.boundingBox();
    const toast = page.locator('.toast.history-undo');
    await expect(toast).toHaveCSS('position', 'fixed');
    await expect(toast.getByRole('status')).toContainText('已移入資源回收筒：修正鍵盤焦點');
    const statusBox = await toast.getByRole('status').boundingBox();
    expect(undoBox && dismissBox && statusBox).toBeTruthy();
    expect(undoBox!.x).toBeGreaterThanOrEqual(statusBox!.x + statusBox!.width);
    expect(dismissBox!.x).toBeGreaterThan(undoBox!.x + undoBox!.width);
    expect(dismissBox!.x - (undoBox!.x + undoBox!.width)).toBeLessThan(20);
    await page.screenshot({ path: info.outputPath(`${theme}-undo-toast.png`) });
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#activity-sessions-panel')).toBeVisible();
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
  await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
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
    const fullName = `工作台介面：${'很長的專案名稱'.repeat(8)}`;
    const heading = header.getByRole('heading', { level: 1, name: fullName, exact: true });
    await expect(heading).toHaveAttribute('title', fullName);
    await expect(header.locator('.breadcrumb [aria-current="page"]')).toHaveAttribute('title', fullName);
    const geometry = await header.evaluate(el => {
      const title = el.querySelector('h1')!;
      const breadcrumb = el.querySelector('.breadcrumb')!;
      const buttons = [...el.querySelectorAll('.header-buttons > button')];
      return {
        height: el.getBoundingClientRect().height,
        titleHeight: title.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(title).lineHeight),
        breadcrumbHeight: breadcrumb.getBoundingClientRect().height,
        fixedCrumbsFit: [...breadcrumb.querySelectorAll('span:not([aria-current]), button:not([aria-current])')]
          .every(crumb => crumb.scrollWidth <= crumb.clientWidth),
        currentCrumbEllipsized: (() => {
          const crumb = breadcrumb.querySelector('[aria-current="page"]')!;
          return crumb.scrollWidth > crumb.clientWidth && crumb.clientWidth > 0 &&
            getComputedStyle(crumb).textOverflow === 'ellipsis';
        })(),
        buttonsReachable: buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return rect.width >= 32 && rect.right <= innerWidth &&
            button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }),
      };
    });
    expect(geometry.height).toBeLessThanOrEqual(180);
    expect(geometry.titleHeight).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
    expect(geometry.breadcrumbHeight).toBeLessThanOrEqual(20);
    expect(geometry.buttonsReachable).toBe(true);
    expect(geometry.fixedCrumbsFit).toBe(true);
    expect(geometry.currentCrumbEllipsized).toBe(true);
    await rename.focus();
    await page.keyboard.press('Tab');
    await expect(header.getByRole('button', { name: '重新定位', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(header.getByRole('button', { name: '資源回收筒', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(rename).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '重新命名專案' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(fullName);
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
      await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
      await page.locator('#activity-sessions-panel .session-card-select').first().click();
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

for (const theme of ['dark', 'light']) for (const palette of ['bay', 'code-modern', 'code-2026']) {
  test(`${theme} ${palette}: project card highlight meets footer without rounded gaps`, async ({ page }, info) => {
    await page.goto(`/tests/browser/interactions.html?theme=${theme}&palette=${palette}`);
    const card = page.locator('.directory-cards > li').first();
    const main = card.locator('.directory-card-main');
    const footer = card.locator('.directory-card-actions');
    const action = footer.getByRole('button');
    await expect(card).toBeVisible();
    const before = await card.boundingBox();
    const footerBackground = await footer.evaluate(el => getComputedStyle(el).backgroundColor);
    const assertSeam = async () => {
      await expect(main).toHaveCSS('border-bottom-left-radius', '0px');
      await expect(main).toHaveCSS('border-bottom-right-radius', '0px');
      await expect(card).toHaveCSS('border-radius', '12px');
      await expect(card).toHaveCSS('overflow', 'hidden');
      const a = (await main.boundingBox())!;
      const b = (await footer.boundingBox())!;
      expect(a.y + a.height).toBeCloseTo(b.y, 3);
      expect(a.x).toEqual(b.x);
      expect(a.width).toEqual(b.width);
      expect(await card.boundingBox()).toEqual(before);
      expect(await footer.evaluate(el => getComputedStyle(el).backgroundColor)).toEqual(footerBackground);
    };
    await assertSeam();
    await main.hover();
    const hoverColor = await main.evaluate(el => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--surface-hover)';
      el.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(main).toHaveCSS('background-color', hoverColor);
    await assertSeam();
    await page.screenshot({ path: info.outputPath('project-card-hover.png') });
    await page.mouse.move(0, 0);
    await main.focus();
    await expect(main).toBeFocused();
    await expect(main).toHaveCSS('outline-style', 'solid');
    await expect(main).toHaveCSS('outline-width', '2px');
    await expect(main).toHaveCSS('outline-offset', '-3px');
    await assertSeam();
    await page.screenshot({ path: info.outputPath('project-card-focus.png') });
    await page.keyboard.press('Tab');
    await expect(action).toBeFocused();
    await action.hover();
    await expect(main).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await assertSeam();
    await main.hover();
    await page.mouse.down();
    await assertSeam();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await expect(card).toBeVisible();
  });
}
