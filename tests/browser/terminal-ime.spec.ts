import { expect, test } from '@playwright/test';

test('shipped xterm bundle characterizes the duplicate with only the existing key guard', async ({ page }) => {
  await page.goto('/tests/browser/terminal-ime.html?baseline=1');
  const sent = await page.evaluate(() => (window as unknown as { imeScenario: (name: string) => Promise<string[]> }).imeScenario('commit'));
  expect(sent).toEqual(['中文', '中文']);
});
for (const [scenario, expected] of [
  ['commit', ['中文']], ['repeat', ['中文', '中文']], ['cancel', []],
  ['blur', ['中文']], ['enter', ['中文', '\r']],
  ['consumed-restart', ['中文', '中文']], ['pending-restart', ['中文', '中文']],
  ['ordinary-restart', ['中文', '中文']],
] as const) {
  test(`shipped xterm bundle routes ${scenario} exactly once`, async ({ page }) => {
    await page.goto('/tests/browser/terminal-ime.html');
    const sent = await page.evaluate((name) => (window as unknown as { imeScenario: (name: string) => Promise<string[]> }).imeScenario(name), scenario);
    expect(sent).toEqual(expected);
  });
}
