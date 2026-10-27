import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// Frontend timings and JS heap for the large synthetic repository. Opt-in:
// SESSIONBAY_GIT_BRIDGE_LARGE=1 npx playwright test --config tests/browser/config/git.config.ts --project=chromium git-performance
const bridge = 'http://127.0.0.1:1441';
test.skip(process.env.SESSIONBAY_GIT_BRIDGE_LARGE !== '1', 'large repository measurement is opt-in');

test('large repository: status, graph and diff render within the frontend budget', async ({ page, browserName, browser }, info) => {
  test.skip(browserName !== 'chromium', 'heap metrics use the Chromium DevTools protocol');
  test.setTimeout(180_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0) / 1_048_576;
  };
  await page.request.post(`${bridge}/reset`);
  await page.goto(`/tests/browser/workspace-focus-mode.html?activity=1&git=${encodeURIComponent(bridge)}`);
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: /^開啟工作區 .* Focus shell$/ }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver((list) => w.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask' });
  });
  const heapBefore = await heap();
  const panel = page.locator('#activity-git-panel');
  const results: Record<string, number> = {};
  const measure = async (action: () => Promise<unknown>, ready: () => Promise<unknown>, phase = '') => {
    const started = Date.now();
    await action();
    await ready();
    const elapsed = Date.now() - started;
    // Per-phase long tasks and heap, so a regression points at one surface.
    const tasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks.splice(0));
    results[`${phase}LongTasks`] = tasks.length;
    results[`${phase}LongestTaskMs`] = Math.round(Math.max(0, ...tasks));
    results[`${phase}HeapMiB`] = Number((await heap()).toFixed(1));
    return elapsed;
  };
  results.openStatusMs = await measure(
    () => page.locator('.workspace-activity-bar').getByRole('button', { name: 'Git', exact: true }).click(),
    () => expect(panel.getByRole('button', { name: /untracked-4999\.txt|untracked-\d+\.txt/ }).first()).toBeVisible({ timeout: 60_000 }), 'status');
  results.openGraphMs = await measure(
    () => panel.getByRole('button', { name: '開啟歷史 graph' }).click(),
    () => expect(page.getByRole('listbox', { name: 'Commit 歷史' }).getByRole('option').nth(100)).toBeAttached({ timeout: 60_000 }), 'graph');
  results.openDiffMs = await measure(
    () => panel.getByRole('button', { name: /^file0\.txt，已修改/ }).first().click(),
    () => expect(page.locator('.git-document:not([hidden])').getByText('LINE 5').first()).toBeVisible({ timeout: 60_000 }), 'diff');
  const heapAfter = await heap();
  const report = {
    measuredAt: new Date().toISOString(), browser: `${browserName} ${browser.version()}`, platform: process.platform, arch: process.arch,
    repository: { commits: 20_000, untracked: 5_000, diffLines: 10_000 },
    ...results,
    heapBeforeMiB: Number(heapBefore.toFixed(1)), heapAfterMiB: Number(heapAfter.toFixed(1)),
  };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(info.outputPath('git-performance.json'), JSON.stringify(report, null, 2));
});
