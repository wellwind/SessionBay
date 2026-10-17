import { expect, test } from '@playwright/test';

for (const mac of [false, true]) for (const focus of [false, true]) {
  test(`real xterm search: Mac fixture=${mac}, focus=${focus}`, async ({ page }) => {
    // Meta on Windows is an event fixture, not macOS WebView acceptance.
    await page.addInitScript(mac => Object.defineProperty(navigator, 'platform', { get: () => mac ? 'MacIntel' : 'Win32' }), mac);
    await page.goto('/tests/browser/workspace-focus-mode.html');
    await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('Synthetic focus output');
    if (focus) await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    const textarea = page.locator('.xterm-helper-textarea');
    await textarea.focus();
    await expect(textarea).toBeFocused();
    if (mac) await textarea.dispatchEvent('keydown', { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    else await page.keyboard.press('Control+Shift+F');
    await expect(page.locator('.history-tab')).toHaveClass(/active/);
    await expect(page.locator('#session-search')).toBeFocused();
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', String(focus));
    await expect(page.getByRole('heading', { name: '所有工作階段' })).toHaveCount(0);
    const writes = await page.evaluate(() => (window as unknown as { focusFixture: { calls: { command: string }[] } }).focusFixture.calls.filter(call => call.command === 'write_runtime'));
    expect(writes).toEqual([]);
  });
}
