import { expect, test } from '@playwright/test';

type Trace = { writes: string[]; begins: number; retained: string[]; discarded: string[]; chunks: number[]; names: string[]; payloads: number[][] };
declare global { interface Window { fileTrace: Trace; releaseFile?: () => void; svgExecuted?: boolean } }
for (const route of ['drop', 'paste'] as const) {
  test(`${route}: synthetic DOM File bytes become one bracketed path, never binary or Enter`, async ({ page }, info) => {
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
    await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual(['\x1b[200~file:///private/synthetic/file-1/safe.png \x1b[201~']);
    expect(await page.evaluate(() => window.fileTrace.retained)).toEqual(['file-1']);
    expect(await page.evaluate(() => window.fileTrace.begins)).toBe(1);
    await expect(page.getByRole('alert')).toContainText('未送出');
    await page.screenshot({ path: info.outputPath(`image-${route}.png`) });
  });
}
test('ordinary text paste still works; a File takes priority over incidental text without duplication', async ({ page }) => {
  await page.goto('/tests/browser/image-input.html');
  await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'ordinary text');
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual(['\x1b[200~ordinary text\x1b[201~']);
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'caption');
    data.items.add(new File([new Uint8Array([1, 2])], 'test.png', { type: 'image/png' }));
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual([
    '\x1b[200~ordinary text\x1b[201~', '\x1b[200~file:///private/synthetic/file-1/test.png \x1b[201~',
  ]);
  expect(await page.evaluate(() => window.fileTrace.begins)).toBe(1);
  expect(await page.evaluate(() => window.fileTrace.retained)).toEqual(['file-1']);
});

test('Enter sends normally while staging; the cancelled file never reaches the later prompt', async ({ page }) => {
  await page.goto('/tests/browser/image-input.html?pauseFile=1');
  await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'synthetic.png', { type: 'image/png' }));
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.getByRole('alert')).toContainText('正在準備檔案');
  await expect.poll(() => page.evaluate(() => typeof window.releaseFile)).toBe('function');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual(['\r']);
  await page.evaluate(() => window.releaseFile!());
  await expect.poll(() => page.evaluate(() => window.fileTrace.discarded)).toEqual(['file-1']);
  expect(await page.evaluate(() => window.fileTrace.retained)).toEqual([]);
  expect(await page.evaluate(() => window.fileTrace.writes)).toEqual(['\r']);
});

test('intact multiline text paste while preparing stays in the current prompt', async ({ page }) => {
  await page.goto('/tests/browser/image-input.html?pauseFile=1');
  await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3])], 'synthetic.png', { type: 'image/png' }));
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect.poll(() => page.evaluate(() => typeof window.releaseFile)).toBe('function');
  await page.evaluate(() => {
    const data = new DataTransfer(); data.setData('text/plain', 'line one\nline two');
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    window.releaseFile!();
  });
  await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual([
    '\x1b[200~line one\rline two\x1b[201~', '\x1b[200~file:///private/synthetic/file-1/synthetic.png \x1b[201~',
  ]);
  expect(await page.evaluate(() => window.fileTrace.discarded)).toEqual([]);
  expect(await page.evaluate(() => window.fileTrace.retained)).toEqual(['file-1']);
});


test('opaque SVG bytes drop into the explicitly selected pane without rendering or metadata text', async ({ page }) => {
  await page.goto('/tests/browser/image-input.html');
  await expect(page.getByRole('button', { name: '貼上', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Toggle pane focus' }).click();
  await expect(page.locator('.terminal-pane')).not.toHaveClass(/focused/);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted=true</script></svg>';
  await page.evaluate((svg) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'file:///synthetic/Finder/scene.svg\n');
    transfer.items.add(new File([svg], 'scene.svg', { type: 'image/svg+xml' }));
    document.querySelector('.xterm-host')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, svg);
  await expect(page.locator('.terminal-pane')).toHaveClass(/focused/);
  await expect.poll(() => page.evaluate(() => window.fileTrace.writes)).toEqual(['\x1b[200~file:///private/synthetic/file-1/scene.svg \x1b[201~']);
  expect(await page.evaluate(() => window.fileTrace.names)).toEqual(['scene.svg']);
  expect(await page.evaluate(() => window.fileTrace.payloads.flat())).toEqual(Array.from(new TextEncoder().encode(svg)));
  expect(await page.evaluate(() => window.fileTrace.retained)).toEqual(['file-1']);
  expect(await page.evaluate(() => window.svgExecuted)).toBeUndefined();
});
