import { expect, test } from '@playwright/test';
for (const theme of ['dark', 'light']) for (const width of [1280, 720]) {
  test(`Explorer ${theme} ${width}: project tabs, search and retained terminal`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`/tests/browser/workspace-focus-mode.html?theme=${theme}`);
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
    await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
    const terminal = page.locator('.xterm-screen');
    await expect(terminal).toBeVisible();
    await terminal.evaluate(node => { (window as unknown as { originalTerminal: Element }).originalTerminal = node; });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'README.md', exact: true }).dblclick();
    await page.getByRole('button', { name: 'large.ts', exact: true }).dblclick();
    const tabs = page.locator('.project-file-tabs-host');
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await expect(terminal).toBeHidden();
    const editor = page.getByLabel('唯讀內容：large.ts');
    await editor.focus(); await page.keyboard.press('Control+f');
    const find = page.locator('.monaco-editor .find-widget .find-part textarea, .monaco-editor .find-widget .find-part input').first();
    await find.fill('END_SENTINEL');
    const mark = page.locator('.monaco-editor .currentFindMatch');
    await expect(mark).toBeVisible();
    await expect.poll(async () => {
      const a = await mark.boundingBox(); const b = await editor.boundingBox();
      return !!a && !!b && a.x >= b.x && a.x + a.width <= b.x + b.width;
    }).toBe(true);
    await editor.focus(); await page.keyboard.press('Control+f'); await expect(find).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.monaco-editor .find-widget')).toHaveAttribute('aria-hidden', 'true');
    // Closing Find removes a 27px view zone synchronously; Monaco paints its
    // new scroll offset on the next frame. Do not snapshot the stale DOM style.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const scroll = await editor.locator('.lines-content').getAttribute('style');
    expect(scroll).toMatch(/top:\s*-/);
    await tabs.getByRole('tab', { name: /README.md/ }).click();
    await expect(page.getByLabel('唯讀內容：README.md')).toContainText('<script>');
    await tabs.getByRole('tab', { name: /large.ts/ }).click();
    await expect.poll(() => editor.locator('.lines-content').getAttribute('style')).toBe(scroll);
    expect(await page.locator('.monaco-editor .view-line').count()).toBeLessThan(100);
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByRole('tree')).toBeHidden();
    await expect(editor).toBeVisible();
    await page.screenshot({ path: info.outputPath(`explorer-${theme}-${width}-document.png`) });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const pane = page.locator('.project-files-sidebar:visible');
    const work = (await page.locator('.project-work-content').boundingBox())!;
    const panel = (await pane.boundingBox())!;
    const rail = (await page.getByRole('navigation', { name: '工作區功能' }).boundingBox())!;
    const body = (await page.locator('.app-body').boundingBox())!;
    expect(work.x + work.width).toBeLessThanOrEqual(panel.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(rail.x);
    // Align inside the app-shell border rather than to the viewport edge.
    expect(rail.x + rail.width).toBe(body.x + body.width);
    await expect(page.locator('.sidebar')).toBeVisible();
    const resize = page.getByRole('separator', { name: '調整目錄樹寬度' });
    await resize.focus();
    await page.keyboard.press('Home');
    await expect(resize).toHaveAttribute('aria-valuenow', '160');
    const before = (await pane.boundingBox())!.width;
    await page.keyboard.press('ArrowLeft');
    await expect(resize).toHaveAttribute('aria-valuenow', '176');
    await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(before);
    const keyboard = (await pane.boundingBox())!;
    const handle = (await resize.boundingBox())!;
    expect(Math.abs(handle.x + handle.width / 2 - keyboard.x)).toBeLessThanOrEqual(3);
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 32, y, { steps: 8 });
    await page.mouse.up();
    await expect(resize).toHaveAttribute('aria-valuenow', '208');
    await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(keyboard.width);
    const dragged = (await pane.boundingBox())!;
    expect(dragged.x).toBeLessThan(keyboard.x);
    expect(dragged.x + dragged.width).toBeCloseTo(keyboard.x + keyboard.width, 3);
    await page.screenshot({ path: info.outputPath(`explorer-${theme}-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.workspace-tab-select').click();
    await expect(terminal).toBeVisible();
    expect(await terminal.evaluate(node => node === (window as unknown as { originalTerminal: Element }).originalTerminal)).toBe(true);
  });
}

test('Monaco local workers, readonly selection, theme and model disposal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: '檔案內搜尋', exact: true })).toBeEnabled();
  // Import the same locally bundled singleton in this synthetic fixture only.
  const details = await page.evaluate(async () => {
    const modulePath = '/src/components/monaco-preview.ts';
    const { monaco, getJsonWorker } = await import(modulePath);
    const model = monaco.editor.getModels()[0];
    const widget = monaco.editor.getEditors()[0];
    const before = model.getValue();
    widget.focus(); widget.trigger('test', 'type', { text: 'MUST_NOT_INSERT' });
    widget.setSelection(model.getFullModelRange());
    const selected = model.getValueInRange(widget.getSelection());
    // Trigger the real JSON worker while schemas remain disabled.
    const jsonModel = monaco.editor.createModel('{"answer":42}', 'json', monaco.Uri.parse('sessionbay-preview:/test.json'));
    // A detached model alone does not request rich language activation.
    // colorize awaits the lazy JSON tokenizer before requesting its worker.
    await monaco.editor.colorize(jsonModel.getValue(), 'json', {});
    const worker = await getJsonWorker();
    const proxy = await worker(jsonModel.uri);
    const diagnostics = await proxy.doValidation(jsonModel.uri.toString());
    jsonModel.dispose();
    return { unchanged: model.getValue() === before, selected, before, models: monaco.editor.getModels().length,
      diagnostics, readOnly: widget.getOption(monaco.editor.EditorOption.readOnly) };
  });
  expect(details.unchanged).toBe(true);
  expect(details.selected).toBe(details.before);
  expect(details.models).toBe(1);
  expect(details.readOnly).toBe(true);
  expect(details.diagnostics).toEqual([]);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(page.locator('.monaco-editor.vs')).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(page.locator('.monaco-editor.vs-dark')).toBeVisible();
  await page.locator('.project-file-tabs-host').getByRole('button', { name: '關閉檔案 README.md', exact: true }).click();
  expect(await page.evaluate(async () => {
    const modulePath = '/src/components/monaco-preview.ts';
    return (await import(modulePath)).monaco.editor.getModels().length;
  })).toBe(0);
  expect(errors).toEqual([]);
});

test('Monaco preserves folding and selection when switching file tabs', async ({ page }) => {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).dblclick();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'index.ts', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: '檔案內搜尋', exact: true })).toBeEnabled();
  await expect.poll(async () => page.evaluate(async () => {
    const modulePath = '/src/components/monaco-preview.ts';
    const { monaco } = await import(modulePath);
    const widget = monaco.editor.getEditors()[0];
    widget.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 });
    await widget.getAction('editor.foldAll').run();
    return widget.saveViewState().contributionsState['editor.contrib.folding'].collapsedRegions?.length ?? 0;
  })).toBeGreaterThan(0);
  const tabs = page.locator('.project-file-tabs-host');
  await tabs.getByRole('tab', { name: /README.md/ }).click();
  await expect(page.getByLabel('唯讀內容：README.md')).toContainText('<script>');
  await tabs.getByRole('tab', { name: /index.ts/ }).click();
  await expect(page.getByRole('button', { name: '檔案內搜尋', exact: true })).toBeEnabled();
  await expect.poll(async () => page.evaluate(async () => {
    const modulePath = '/src/components/monaco-preview.ts';
    const { monaco } = await import(modulePath);
    const widget = monaco.editor.getEditors()[0];
    const view = widget.saveViewState();
    return { folds: view.contributionsState['editor.contrib.folding'].collapsedRegions?.length ?? 0,
      selected: widget.getModel().getValueInRange(widget.getSelection()) };
  })).toEqual({ folds: 1, selected: 'export' });
});
