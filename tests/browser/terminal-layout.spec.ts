import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function bounds(page: Page) {
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('.pane-meta')).toContainText('執行中');
  await expect(page.locator('body')).toHaveAttribute('data-fit', /\d+x\d+/);
  // Wait for the snapshot write and ResizeObserver/FitAddon to settle.
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('Synthetic terminal output');
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    };
    return { body: box('.terminal-body'), screen: box('.xterm-screen'), footer: box('.pane-footer'), meta: box('.pane-meta') };
  });
}

for (const [name, width, height, zoom] of [
  ['normal', 1000, 600, 100],
  ['compact', 500, 320, 100],
  ['zoom-50', 1000, 600, 50],
  ['zoom-200', 500, 320, 200],
] as const) {
  test(`${name}: renderer stays inside terminal body`, async ({ page, browser }, testInfo) => {
    // The defect is sensitive to row rounding. Find a nearby real pane height
    // where the last row crosses the footer, then compare identical dimensions.
    let url = '';
    let before: Awaited<ReturnType<typeof bounds>> | undefined;
    for (let offset = 0; offset < 18; offset += 3) {
      url = `/tests/browser/terminal-layout.html?width=${width}&height=${height + offset}&zoom=${zoom}`;
      await page.goto(`${url}&baseline=1`);
      before = await bounds(page);
      if (before.screen.bottom > before.footer.top) break;
    }
    expect(before).toBeDefined();
    await page.screenshot({ path: testInfo.outputPath(`${name}-before.png`), fullPage: true });
    // Characterize the original defect, so this cannot pass on an empty fixture.
    expect(before!.screen.bottom).toBeGreaterThan(before!.footer.top);
    await page.goto(url);
    await expect.poll(async () => {
      const after = await bounds(page);
      return after.screen.bottom <= after.footer.top && after.screen.right <= after.body.right;
    }).toBe(true);
    const after = await bounds(page);
    expect(after.screen.top).toBeGreaterThanOrEqual(after.meta.bottom);
    // xterm 6 uses a custom scrollable element, not DOM viewport overflow.
    // Verify real wheel behavior and rendered scrollback rather than its internals.
    const bottomText = await page.locator('.xterm-rows').innerText();
    await page.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => page.locator('.xterm-rows').innerText()).not.toBe(bottomText);
    // Wheel deltas are normalized by the custom scrollbar; one event need not
    // jump to the very first line even when its pixel delta is large.
    const firstLine = (text: string) => Number(text.match(/Synthetic terminal output line (\d+):/)?.[1]);
    await expect.poll(async () => firstLine(await page.locator('.xterm-rows').innerText())).toBeLessThan(firstLine(bottomText));
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => page.locator('.xterm-rows').innerText()).toBe(bottomText);
    await page.locator('.xterm-screen').click();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`${name}-after.png`), fullPage: true });
    const geometryPath = testInfo.outputPath('geometry.json');
    await writeFile(geometryPath, JSON.stringify({ browser: browser.version(), channel: 'chrome', before, after }, null, 2));
    await testInfo.attach('geometry', { path: geometryPath, contentType: 'application/json' });
    const search = page.getByRole('button', { name: '搜尋終端文字', exact: true });
    const options = page.getByRole('button', { name: '面板選項 Shell', exact: true });
    // Narrow panes expose secondary actions through the responsive toolbar.
    // Exercise the actual keyboard entry point instead of bypassing hidden UI.
    if (width < 600) {
      await expect(search).toBeHidden();
      await expect(options).toHaveAttribute('aria-expanded', 'false');
      await options.focus();
      await options.press('Enter');
      await expect(options).toHaveAttribute('aria-expanded', 'true');
    } else {
      await expect(options).toHaveCount(0);
    }
    await expect(search).toBeVisible();
    await search.click();
    await expect(page.getByRole('textbox', { name: '終端搜尋', exact: true })).toBeFocused();
    if (width < 600) await expect(options).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => (await bounds(page)).screen.bottom <= (await bounds(page)).footer.top).toBe(true);
    await page.getByRole('button', { name: '關閉終端搜尋', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '終端搜尋', exact: true })).toHaveCount(0);
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await expect.poll(async () => {
      const restored = await bounds(page);
      return restored.screen.bottom <= restored.footer.top &&
        restored.screen.bottom === after.screen.bottom && restored.body.bottom === after.body.bottom;
    }).toBe(true);
  });
}
