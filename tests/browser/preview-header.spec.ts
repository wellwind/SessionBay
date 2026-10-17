import { expect, test } from '@playwright/test';

for (const scenario of [
  { name: 'normal', width: 1844, long: false, zoom: 1 },
  { name: 'long', width: 1200, long: true, zoom: 1 },
  { name: 'narrow', width: 360, long: false, zoom: 1 },
  { name: 'zoom-200', width: 720, long: true, zoom: 2 },
]) {
  test(scenario.name, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    await page.goto(`/tests/browser/preview-header.html${scenario.long ? '?long=1' : ''}`);
    // Chromium CSS zoom exercises 200% layout magnification, not deviceScaleFactor.
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, scenario.zoom);
    const header = page.locator('.transcript-header');
    const title = header.locator('h3');
    const trash = header.getByRole('button', { name: '刪除 Session', exact: true });
    const resume = header.getByRole('button', { name: '接續工作', exact: true });
    await expect(title).toBeVisible();
    await header.screenshot({ path: testInfo.outputPath('header.png') });
    const boxes = { title: (await title.boundingBox())!, trash: (await trash.boundingBox())!, resume: (await resume.boundingBox())! };
    await testInfo.attach('geometry', { body: JSON.stringify(boxes, null, 2), contentType: 'application/json' });
    expect(boxes.resume.x - boxes.trash.x - boxes.trash.width).toBeCloseTo(8 * scenario.zoom, 0);
    expect(Math.abs(boxes.trash.y + boxes.trash.height / 2 - boxes.resume.y - boxes.resume.height / 2)).toBeLessThan(1);
    expect(await title.evaluate(element => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(boxes.resume.x + boxes.resume.width).toBeLessThanOrEqual(scenario.width);
    if (scenario.width / scenario.zoom <= 360) expect(boxes.trash.y).toBeGreaterThanOrEqual(boxes.title.y + boxes.title.height);
    await trash.focus();
    await page.keyboard.press('Tab');
    await expect(resume).toBeFocused();
    await expect(resume).toBeInViewport({ ratio: 1 });
    expect((await resume.boundingBox())!.y + (await resume.boundingBox())!.height + 4).toBeLessThanOrEqual(1000);
    expect(await resume.evaluate(element => element.matches(':focus-visible'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('focused-actions.png') });
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as unknown as { previewFixture: { resumed: string[] } }).previewFixture.resumed)).toEqual(['synthetic-preview']);
    await page.keyboard.press('Shift+Tab');
    await expect(trash).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trash).toBeFocused();
  });
}

test('bounded history grid keeps a readable transcript beneath an extreme title', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/tests/browser/preview-header.html?long=1&grid=1');
  const transcript = page.locator('.transcript-scroll');
  await expect(transcript.getByText('Synthetic message 40', { exact: true })).toBeAttached();
  expect((await transcript.boundingBox())!.height).toBeGreaterThanOrEqual(150);
  await transcript.scrollIntoViewIfNeeded();
  await expect(transcript).toBeInViewport();
  await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(transcript.getByText('Synthetic message 40', { exact: true })).toBeInViewport();
  const resume = page.locator('.transcript-header').getByRole('button', { name: '接續工作', exact: true });
  await resume.focus();
  await expect(resume).toBeInViewport({ ratio: 1 });
});
