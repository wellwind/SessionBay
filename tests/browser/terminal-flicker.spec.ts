import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('characterize split synchronized repaint with real xterm renderer', async ({ page, browser }, testInfo) => {
  await page.goto('/tests/browser/terminal-flicker.html');
  await expect.poll(() => page.evaluate(() => (window as unknown as { flickerCounts: { done: boolean } }).flickerCounts.done)).toBe(true);
  const counts = await page.evaluate(() => (window as unknown as { flickerCounts: Record<string, number | boolean> }).flickerCounts);
  const evidence = testInfo.outputPath('synthetic-render-counters.json');
  await writeFile(evidence, JSON.stringify({ browser: browser.version(), counts }, null, 2));
  await testInfo.attach('synthetic-render-counters', { path: evidence, contentType: 'application/json' });
  expect(counts.frames).toBe(30);
  expect(counts.resets).toBe(1);
  expect(counts.writes).toBe(61);
  expect(counts.acks).toBe(61);
  // Baseline characterization for pinned xterm 5.5, not a post-fix acceptance test.
  expect(counts.blankRenders).toBeGreaterThan(0);
  await expect(page.locator('.xterm-rows')).toContainText('Synthetic complete frame 29');
});


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
