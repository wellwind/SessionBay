import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const theme of ['dark', 'light']) for (const width of [1440, 600]) {
  test(`10000 synthetic sessions ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/browser/session-feed.html?theme=${theme}`);
    const list = page.getByRole('list', { name: 'Session 清單' });
    await expect(list).toBeVisible();
    const calls = () => page.evaluate(() => (window as unknown as { sessionFeedFixture: { calls: unknown[] } }).sessionFeedFixture.calls.length);
    expect(await calls()).toBe(1);
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      const before = await calls();
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect.poll(calls).toBe(before + 1);
      await expect(list).toHaveAttribute('aria-busy', 'false');
      expect(await list.getByRole('listitem').count()).toBeLessThan(16);
    }
    const position = await list.evaluate(el => el.scrollTop);
    await page.getByRole('button', { name: '切換專案' }).click();
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '切換專案' }).click();
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(position);
    await list.focus();
    await page.keyboard.press('End');
    await expect(page.locator('.session-card-select:focus')).toHaveCount(1);
    expect(await list.getByRole('listitem').count()).toBeLessThan(16);
    await page.screenshot({ path: info.outputPath(`history-${theme}-${width}.png`), fullPage: true });
    const measurement = JSON.stringify({ total: 10000, loadedBatches: 13,
      elapsedMs: Date.now() - started, mountedRows: await list.getByRole('listitem').count(), width, theme });
    await writeFile(info.outputPath('performance.json'), measurement);
    await info.attach('performance.json', { body: measurement, contentType: 'application/json' });
    await page.getByRole('textbox', { name: '搜尋 Session' }).fill('short');
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.session-feed-status')).toHaveCount(0);
    await expect(page.locator('.transcript-footer')).toHaveCount(0);
    expect(await list.getByRole('listitem').count()).toBe(3);
    await page.getByRole('button', { name: '資源回收筒', exact: true }).click();
    const trash = page.getByRole('list', { name: '資源回收筒清單' });
    await expect(trash).toBeVisible();
    await trash.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(trash).toHaveAttribute('aria-busy', 'false');
    expect(await trash.getByRole('listitem').count()).toBeLessThan(16);
    await page.screenshot({ path: info.outputPath(`trash-${theme}-${width}.png`), fullPage: true });
    expect(await page.getByRole('button', { name: '下一頁' }).count()).toBe(0);
  });
}

test('retry, deep deletion and undo preserve navigation without loading the database', async ({ page }) => {
  await page.goto('/tests/browser/session-feed.html');
  const list = page.getByRole('list', { name: 'Session 清單' });
  await expect(list).toBeVisible();
  await page.evaluate(() => { (window as unknown as { sessionFeedFixture: { fail: boolean } }).sessionFeedFixture.fail = true; });
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.getByRole('alert')).toContainText('Synthetic retryable error');
  expect(await list.getByRole('listitem').count()).toBeGreaterThan(0);
  await page.getByRole('button', { name: '重試載入' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await list.evaluate(el => { el.scrollTop = 9000; });
  const visibleDelete = list.locator('.session-card-delete').filter({ visible: true }).last();
  // Focus makes the existing hover/focus action visible without changing selection.
  await visibleDelete.focus();
  const top = await list.evaluate(el => el.scrollTop);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '確認移入資源回收筒' }).click();
  await expect(page.getByRole('button', { name: '復原刪除' })).toBeVisible();
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(top);
  await page.getByRole('button', { name: '復原刪除' }).click();
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(top);
  await page.getByRole('textbox', { name: '搜尋 Session' }).fill('slow');
  await page.waitForTimeout(250);
  await page.getByRole('textbox', { name: '搜尋 Session' }).fill('new');
  await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.session-feed-status')).toHaveCount(0);
    await expect(page.locator('.transcript-footer')).toHaveCount(0);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0);
});

for (const theme of ['dark', 'light']) for (const width of [1440, 600]) {
  test(`read-only removal inspection ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/browser/session-feed.html?theme=${theme}`);
    const launcher = page.getByRole('button', { name: '資源回收筒', exact: true });
    await launcher.click();
    const inspect = page.getByRole('button', { name: /檢查來源 Synthetic Session 0 / });
    await inspect.click();
    await expect(page.getByText('sessions/2026/10/synthetic-session.jsonl')).toBeVisible();
    await expect(page.getByRole('button', { name: '返回資源回收筒' })).toBeFocused();
    await expect(page.getByRole('button', { name: /永久|確認刪除/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`removal-inspection-${theme}-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(inspect).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(launcher).toBeFocused();
  });
}
