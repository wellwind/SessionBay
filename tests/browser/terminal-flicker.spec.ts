import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const synchronized of [true, false]) {
test(`split repaint with real xterm 6 renderer (synchronized=${synchronized})`, async ({ page, browser }, testInfo) => {
  await page.goto(`/tests/browser/terminal-flicker.html?unsynchronized=${synchronized ? '0' : '1'}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { flickerCounts: { done: boolean } }).flickerCounts.done)).toBe(true);
  const counts = await page.evaluate(() => (window as unknown as { flickerCounts: Record<string, number | boolean> }).flickerCounts);
  const evidence = testInfo.outputPath('synthetic-render-counters.json');
  await writeFile(evidence, JSON.stringify({ browser: browser.version(), counts }, null, 2));
  await testInfo.attach('synthetic-render-counters', { path: evidence, contentType: 'application/json' });
  expect(counts.frames).toBe(30);
  expect(counts.resets).toBe(1);
  expect(counts.writes).toBe(61);
  expect(counts.acks).toBe(61);
  // Stable xterm 6 supports DEC 2026 across writes. Keep an unsynchronized
  // negative control so a broken/empty render counter cannot pass this check.
  if (synchronized) expect(counts.blankRenders).toBe(0);
  else expect(counts.blankRenders).toBeGreaterThan(0);
  await expect(page.locator('.xterm-rows')).toContainText('Synthetic complete frame 29');
});
}

test('one bounded response write avoids intermediate blank repaint', async ({ page, browser }, testInfo) => {
  await page.goto('/tests/browser/terminal-flicker.html?batched=1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { flickerCounts: { done: boolean } }).flickerCounts.done)).toBe(true);
  const counts = await page.evaluate(() => (window as unknown as { flickerCounts: Record<string, number | boolean> }).flickerCounts);
  const evidence = testInfo.outputPath('synthetic-batched-render-counters.json');
  await writeFile(evidence, JSON.stringify({ browser: browser.version(), counts }, null, 2));
  await testInfo.attach('synthetic-batched-render-counters', { path: evidence, contentType: 'application/json' });
  expect(counts.frames).toBe(30);
  expect(counts.resets).toBe(1);
  expect(counts.writes).toBe(31);
  expect(counts.acks).toBe(31);
  expect(counts.blankRenders).toBe(0);
  await expect(page.locator('.xterm-rows')).toContainText('Synthetic complete frame 29');
});
