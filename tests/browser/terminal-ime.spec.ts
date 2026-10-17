import { expect, test } from '@playwright/test';

test('xterm 6.0 alone reproduces the observed event order under hypothetical legacy code 0', async ({ page }) => {
  await page.goto('/tests/browser/terminal-ime.html?baseline=1');
  const sent = await page.evaluate(() => (window as unknown as { imeScenario: (name: string) => Promise<string[]> }).imeScenario('native'));
  expect(sent).toEqual(['中文', '中文']);
});
for (const [scenario, expected] of [
  ['native', ['中文']], ['legacy229', ['中文']], ['repeat', ['中文', '中文']], ['cancel', []],
  ['blur', ['中文']], ['enter', ['中文', '\r']], ['shift-enter', ['中文', '\x1b[13;2u']],
  ['ctrl-c', ['中文', '\x03']], ['composition-enter', ['中文']], ['composition-shift-enter', ['中文']], ['dispose', []],
] as const) {
  test(`public composing-key handler preserves ${scenario}`, async ({ page }) => {
    await page.goto('/tests/browser/terminal-ime.html');
    const sent = await page.evaluate((name) => (window as unknown as { imeScenario: (name: string) => Promise<string[]> }).imeScenario(name), scenario);
    expect(sent).toEqual(expected);
  });
}

test('stable 6.0 fit and search addons use compatible public APIs', async ({ page }) => {
  await page.goto('/tests/browser/terminal-ime.html');
  expect(await page.evaluate(() => (window as unknown as { imeAddons: () => Promise<boolean> }).imeAddons())).toBe(true);
});
