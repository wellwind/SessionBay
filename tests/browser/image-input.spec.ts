import { expect, test } from '@playwright/test';

type Trace = { writes: string[]; begins: number; retained: string[]; discarded: string[]; chunks: number[] };
declare global { interface Window { imageTrace: Trace } }
for (const route of ['drop', 'paste'] as const) {
  test(`${route}: native DOM file bytes become one bracketed path, never binary or Enter`, async ({ page }, info) => {
    await page.goto('/tests/browser/image-input.html');
    await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
    await page.locator('.xterm-helper-textarea').focus();
    await page.evaluate((route) => {
      const transfer = new DataTransfer();
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      transfer.items.add(new File([png], '../../unsafe\nname.png', { type: 'image/png' }));
      if (route === 'drop') document.querySelector('.xterm-host')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      else document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, route);
    await expect.poll(() => page.evaluate(() => window.imageTrace.writes)).toEqual(['\x1b[200~file:///private/synthetic/image-1.png\x1b[201~']);
    expect(await page.evaluate(() => window.imageTrace.retained)).toEqual(['image-1']);
    expect(await page.evaluate(() => window.imageTrace.begins)).toBe(1);
    await expect(page.getByRole('alert')).toContainText('未送出');
    await page.screenshot({ path: info.outputPath(`image-${route}.png`) });
  });
}
test('ordinary text paste still works; mixed image/text is explicit and not duplicated', async ({ page }) => {
  await page.goto('/tests/browser/image-input.html');
  await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'ordinary text');
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect.poll(() => page.evaluate(() => window.imageTrace.writes)).toEqual(['\x1b[200~ordinary text\x1b[201~']);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'caption');
    data.items.add(new File([new Uint8Array([1, 2])], 'test.png', { type: 'image/png' }));
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.getByRole('alert')).toContainText('分別貼上');
  expect(await page.evaluate(() => window.imageTrace.begins)).toBe(0);
  expect(await page.evaluate(() => window.imageTrace.writes.length)).toBe(1);
});
