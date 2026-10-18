import { expect, test } from '@playwright/test';

test('JSON worker activation before later editors never registers missing services', async ({ page }, info) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  const terminal = page.locator('.xterm-screen');
  await terminal.evaluate(node => { (window as unknown as { retainedTerminal: Element }).retainedTerminal = node; });
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  // Initialize standalone services with a non-JSON file first. JSON then lazily
  // activates its worker manager; creating another editor exposed ISuggestMemories.
  await page.getByRole('button', { name: 'README.md', exact: true }).dblclick();
  await expect(page.getByLabel('唯讀內容：README.md').locator('.view-line').first()).toBeVisible();
  const workerReply = page.waitForEvent('worker', { predicate: worker => /json[./_-].*worker|json\.worker/i.test(worker.url()) });
  await page.getByRole('button', { name: 'settings.json', exact: true }).dblclick();
  const jsonWorker = await workerReply;
  await expect(page.getByLabel('唯讀內容：settings.json').locator('.view-line').first()).toBeVisible();
  // Wait for actual worker initialization, rather than only its script request.
  await expect.poll(() => jsonWorker.evaluate(() => typeof self.onmessage)).toBe('function');
  await page.getByRole('button', { name: 'src', exact: true }).click();
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('button', { name: 'index.ts', exact: true }).dblclick();
    const code = page.getByLabel('唯讀內容：src/index.ts');
    await expect(code.locator('.view-line').first()).toContainText('export');
    await code.focus();
    await page.keyboard.press('Control+Space');
    await page.keyboard.press('Escape');
    await page.keyboard.type('MUST_NOT_INSERT');
    await expect(code).not.toContainText('MUST_NOT_INSERT');
    // Contributions scheduled after first render must also finish safely.
    await page.waitForTimeout(150);
    expect(failures).toEqual([]);
    await page.getByRole('button', { name: 'settings.json', exact: true }).dblclick();
    await expect(page.getByLabel('唯讀內容：settings.json').locator('.view-line').first()).toBeVisible();
  }
  await page.locator('.workspace-tab-select').click();
  await expect(terminal).toBeVisible();
  expect(await terminal.evaluate(node => node === (window as unknown as { retainedTerminal: Element }).retainedTerminal)).toBe(true);
  expect(failures).toEqual([]);
  await page.screenshot({ path: info.outputPath('monaco-lifecycle.png') });
});
