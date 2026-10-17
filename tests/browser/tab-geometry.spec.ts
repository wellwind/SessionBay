import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const geometry = (page: Page) => page.locator('.workspace-tabs').evaluate(container => {
  const elements = [...container.querySelectorAll(':scope > .history-tab, :scope > .workspace-tab')];
  return elements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { x: rect.x, width: rect.width, gap: index ? rect.x - elements[index - 1].getBoundingClientRect().right : 0,
      margin: style.margin, transform: style.transform, borderLeft: style.borderLeftWidth,
      outline: style.outline, active: element.classList.contains('active') };
  });
});

for (const theme of ['dark', 'light']) for (const palette of ['bay', 'code-modern', 'code-2026']) for (const focus of [false, true]) {
  test(`${theme} ${palette} focus=${focus}`, async ({ page }, testInfo) => {
    await page.goto(`/tests/browser/workspace-focus-mode.html?edge=1&theme=${theme}&palette=${palette}`);
    await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
    if (focus) await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    const before = await geometry(page);
    await page.locator('.workspace-tab-select').last().click();
    const active = await geometry(page);
    await page.keyboard.press('Tab');
    const keyboard = await geometry(page);
    expect(await page.locator(':focus').evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('tabs.png'), fullPage: true });
    expect(await page.locator('.workspace-tabs').evaluate(element => getComputedStyle(element).paddingInline)).toBe('0px');
    await testInfo.attach('geometry', { body: JSON.stringify({ before, active, keyboard }, null, 2), contentType: 'application/json' });
    await writeFile(testInfo.outputPath('geometry.json'), JSON.stringify({ before, active, keyboard }, null, 2));
    expect(active.map(({ x, width }) => ({ x, width }))).toEqual(before.map(({ x, width }) => ({ x, width })));
    expect(keyboard).toEqual(active);
    expect(active.slice(1).map(item => item.gap)).toEqual([0, 0]);
    expect(active.every(item => item.transform === 'none')).toBe(true);
    const first = await page.locator('.workspace-tab-select').first().boundingBox();
    const last = await page.locator('.workspace-tab').last().boundingBox();
    await page.mouse.move(first!.x + 30, first!.y + 15);
    await page.mouse.down();
    await page.mouse.move(last!.x + last!.width - 5, last!.y + 15, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.workspace-tab-select').first()).toHaveAttribute('aria-label', 'Hidden shell 1');
    expect((await geometry(page)).every(item => item.transform === 'none')).toBe(true);
    await page.getByRole('button', { name: '重新命名分頁 Hidden shell', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '顯示名稱', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '關閉分頁 Hidden shell', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });
}
