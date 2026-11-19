import { expect, test } from '@playwright/test';

test('the Ghostty adapter loads under the app CSP and keeps SessionBay terminal rules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text()); });
  // The harness page has no favicon; any other missing resource (such as the WASM) fails.
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto('/tests/browser/ghostty-terminal.html');
  const result = await page.evaluate(() => (window as unknown as { ghosttyScenario: () => Promise<Record<string, unknown>> }).ghosttyScenario());
  expect(result.scrollback).toBeGreaterThan(150);
  // A reader scrolled back stays on the same text while three lines arrive.
  expect(result.held).toEqual({ before: 20, after: 23 });
  expect(result.followsAtBottom).toBe(0);
  // Only the wrapped OSC 8 provider remains; the URL opener is removed.
  expect(result.providers).toBe(1);
  expect(result.copiedOnSelect).toBe(false);
  expect(result.bracketedBefore).toBe(false);
  expect(result.bracketedAfter).toBe(true);
  expect(result.found).toBe(true);
  expect(result.selection).toBe('line 150');
  expect(result.notFound).toBe(false);
  expect(result.sent).toEqual(['\x1b[200~pasted\x1b[201~', '\x1b[13;2u', 'a']);
  expect(result.afterReset).toBe(0);
  expect(errors.filter(error => !/WebSocket|vite/i.test(error))).toEqual([]);
});
