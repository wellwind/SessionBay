import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type Call = { command: string; data?: string; cols?: number; rows?: number };
const lifecycle = (page: Page) => page.evaluate(() => {
  const { calls } = (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture;
  return calls.filter(call => ['launch_runtime', 'attach_runtime', 'detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command));
});
const latestSize = (page: Page) => page.evaluate(() =>
  (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'resize_runtime').at(-1));
const geometry = (page: Page) => page.locator('.terminal-body').evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
});
async function openWorkspace(page: Page) {
  await page.goto('/tests/browser/workspace-focus-mode.html');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.getByRole('button', { name: '歷史 Sessions', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
  await expect(page.locator('#activity-sessions-panel')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(() => page.locator('.xterm-rows').innerText()).toContain('Synthetic focus output');
  await expect.poll(() => latestSize(page)).toBeTruthy();
  expect(await lifecycle(page)).toEqual([{ command: 'attach_runtime' }]);
}
async function sameTerminal(page: Page) {
  expect(await page.evaluate(() => {
    const saved = (window as unknown as { originalTerminal: Element; originalCanvas: Element });
    return document.querySelector('.xterm') === saved.originalTerminal &&
      document.querySelector('.workspace-canvas') === saved.originalCanvas;
  })).toBe(true);
  expect(await lifecycle(page)).toEqual([{ command: 'attach_runtime' }]);
}

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith('edge-to-edge:')) return;
  await openWorkspace(page);
  await page.evaluate(() => Object.assign(window, {
    originalTerminal: document.querySelector('.xterm'),
    originalCanvas: document.querySelector('.workspace-canvas'),
  }));
});

test('English Zen Mode search enters and exits focus mode', async ({ page }, testInfo) => {
  for (const [label, focused] of [['進入專注模式（Zen Mode）', 'true'], ['退出專注模式（Zen Mode）', 'false']]) {
    if (focused === 'false') await page.keyboard.press('ControlOrMeta+Shift+B');
    await page.getByRole('button', { name: /搜尋專案或執行命令/ }).click();
    await page.getByRole('combobox', { name: '搜尋命令或專案', exact: true }).fill('Zen Mode');
    const command = page.getByRole('option', { name: new RegExp(label) });
    await expect(command).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`zen-mode-${focused}.png`) });
    await command.click();
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', focused);
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await sameTerminal(page);
  }
});

test('focus gains terminal area, fits on resize, and preserves runtime and terminal identity', async ({ page, browser }, testInfo) => {
  const normal = await geometry(page);
  const normalSize = await latestSize(page);
  await page.screenshot({ path: testInfo.outputPath('normal.png'), fullPage: true });
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeHidden();
  await expect(page.locator('.project-header')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect.poll(async () => (await geometry(page)).height).toBeGreaterThan(normal.height);
  const focused = await geometry(page);
  expect(focused.width).toBeGreaterThan(normal.width);
  await expect(page.locator('#activity-sessions-panel')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '工作區功能' })).toBeVisible();
  await expect.poll(async () => (await latestSize(page))?.cols ?? 0).toBeGreaterThan(normalSize!.cols!);
  await expect.poll(async () => (await latestSize(page))?.rows ?? 0).toBeGreaterThan(normalSize!.rows!);
  const focusedSize = await latestSize(page);
  await sameTerminal(page);
  await page.screenshot({ path: testInfo.outputPath('focused.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(async () => (await geometry(page)).width).toBeLessThan(focused.width);
  await expect.poll(async () => (await latestSize(page))?.cols ?? 0).toBeLessThan(focusedSize!.cols!);
  await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeInViewport();
  await page.locator('.xterm-screen').click();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
  await expect.poll(() => geometry(page)).toEqual(normal);
  await sameTerminal(page);
  const geometryPath = testInfo.outputPath('geometry.json');
  await writeFile(geometryPath, JSON.stringify({ browser: browser.version(), normal, focused }, null, 2));
  await testInfo.attach('geometry', { path: geometryPath, contentType: 'application/json' });
});

test('history, settings, theme and project navigation remain reachable without reattaching', async ({ page }) => {
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(page.locator('#activity-sessions-panel')).toBeHidden();
  await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
  await expect(page.locator('#activity-sessions-panel')).toBeVisible();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  await sameTerminal(page);
  await page.locator('.workspace-tab-select').click();
  await page.keyboard.press('ControlOrMeta+Shift+B');
  await expect(page.locator('.app-topbar')).toBeVisible();
  await page.getByRole('button', { name: '設定與資料來源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '關閉設定', exact: true }).click();
  await page.getByRole('button', { name: '快速切換主題', exact: true }).click();
  await page.getByRole('button', { name: '淺色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+B');
  await expect(page.locator('.app-topbar')).toBeHidden();
  await sameTerminal(page);
  await page.keyboard.press('ControlOrMeta+Shift+B');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'true');
  await expect(page.locator('.project-header h1')).toHaveText('Synthetic other');
  await page.getByRole('tab', { name: /^專案/ }).click();
  await expect(page.locator('.project-activity-tools')).toBeHidden();
  await expect(page.locator('.app-topbar')).toBeVisible();
  await expect(page.getByRole('button', { name: '退出專注模式', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await sameTerminal(page);
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(page.locator('.app-topbar')).toBeVisible();
});

test('Files sidebar, project tabs and Zen preserve terminal lifecycle', async ({ page }, testInfo) => {
  const toggle = page.getByRole('button', { name: 'Files', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'synthetic.txt', exact: true }).dblclick();
  const preview = page.getByLabel('唯讀內容：synthetic.txt');
  await expect(preview).toContainText('synthetic preview only');
  await expect(page.locator('.xterm-screen')).toBeHidden();
  await sameTerminal(page);
  await toggle.click();
  await expect(page.getByRole('tree')).toBeHidden();
  await expect(preview).toBeVisible();
  await toggle.click();
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#activity-files-panel')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await sameTerminal(page);
  await page.screenshot({ path: testInfo.outputPath('files-zen.png'), fullPage: true });
  await page.getByRole('button', { name: '歷史 Sessions', exact: true }).click();
  await expect(toggle).toBeVisible();
  await expect(page.locator('#activity-sessions-panel')).toBeVisible();
  await expect(preview).toBeVisible();
  await page.locator('.project-file-tabs-host').getByRole('tab', { name: /synthetic.txt/ }).click();
  await expect(preview).toBeVisible();
  await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
  await expect(page.locator('#activity-files-panel')).toBeVisible();
  await expect(page.locator('#activity-sessions-panel')).toBeHidden();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic other' }).click();
  await expect(page.locator('.project-file-tabs-host').getByRole('tab')).toHaveCount(0);
  await page.locator('.sidebar .project-main').filter({ hasText: 'Synthetic focus' }).click();
  await expect(page.locator('#activity-files-panel')).toBeVisible();
  await expect(page.locator('.project-file-tabs-host').getByRole('tab', { name: /synthetic.txt/ })).toHaveAttribute('aria-selected', 'true');
  await expect(preview).toBeVisible();
  await page.locator('.workspace-tab-select').click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await sameTerminal(page);
});

test('long tab names keep a keyboard-operable focus exit at supported narrow width', async ({ page }) => {
  await page.getByRole('button', { name: '重新命名分頁 Focus shell', exact: true }).click();
  await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill('Long synthetic workspace name '.repeat(6));
  await page.getByRole('button', { name: '儲存名稱', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 550 });
  const exit = page.getByRole('button', { name: '退出專注模式', exact: true });
  await expect(exit).toBeInViewport({ ratio: 1 });
  await exit.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', 'false');
  await sameTerminal(page);
});


for (const [normalOpen, zenOpen] of [[true, false], [false, true]]) {
  test(`hiding revealed controls restores terminal focus and independent panels (normal=${normalOpen}, Zen=${zenOpen})`, async ({ page }) => {
    const sessions = page.getByRole('button', { name: '歷史 Sessions', exact: true });
    if (!normalOpen) await sessions.click();
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(sessions).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    if (zenOpen) await sessions.click();
    await page.keyboard.press('ControlOrMeta+Shift+B');
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('ControlOrMeta+Shift+B');
    await expect(page.locator('.app-topbar')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(sessions).toHaveAttribute('aria-expanded', String(zenOpen));
    await sameTerminal(page);
    await page.getByRole('button', { name: '退出專注模式', exact: true }).click();
    await expect(sessions).toHaveAttribute('aria-expanded', String(normalOpen));
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(sessions).toHaveAttribute('aria-expanded', String(zenOpen));
    await sameTerminal(page);
  });
}

// CSS zoom exercises renderer geometry only; native Tauri/WebView zoom remains
// desktop acceptance. Every case respects the existing 700×420 CSS-pixel shell.
for (const [size, width, height, zoom] of [
  ['normal', 1200, 850, 1],
  ['narrow', 800, 650, 1],
  ['zoom-50', 1000, 650, 0.5],
  ['zoom-200', 1600, 1300, 2],
] as const) {
  for (const focused of [false, true]) {
    test(`edge-to-edge: ${size}, ${focused ? 'focus' : 'normal'} single → split → one`, async ({ page, browser }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto('/tests/browser/workspace-focus-mode.html?edge=1');
      await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-backend-ready', 'true');
      // Fixture-only CSS zoom does not emit the app's native zoom event. Set
      // its layout before revealing the terminal so the first fit uses it,
      // rather than capturing a PTY size from before this style mutation.
      await page.evaluate(scale => {
        const app = document.querySelector<HTMLElement>('.app-shell')!;
        app.style.zoom = String(scale);
        app.style.width = `${innerWidth / scale}px`;
        app.style.height = `${innerHeight / scale}px`;
      }, zoom);
      await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
      const original = page.locator('[aria-label="Focus shell 終端面板"]');
      const hidden = page.locator('[aria-label="Hidden shell 終端面板"]');
      await expect(original.locator('.xterm-screen')).toBeVisible();
      await expect.poll(() => original.locator('.xterm-rows').innerText()).toContain('Synthetic focus output');
      await expect(hidden).toBeHidden();
      await page.evaluate(() => {
        Object.assign(window, { edgeOriginal: document.querySelector('[aria-label="Focus shell 終端面板"] .xterm'),
          edgeHidden: document.querySelector('[aria-label="Hidden shell 終端面板"] .xterm'),
          edgeCanvas: document.querySelector('.workspace-canvas') });
      });
      if (focused) await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
      const originalSize = () => page.evaluate(() => (window as unknown as {
        focusFixture: { calls: (Call & { runtimeId?: string })[] };
      }).focusFixture.calls.filter(call => call.command === 'resize_runtime' && call.runtimeId === 'runtime-focus').at(-1));
      const capture = () => page.evaluate(() => {
        const pane = document.querySelector('[aria-label="Focus shell 終端面板"]')!;
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const body = pane.querySelector('.terminal-body')!;
        const style = getComputedStyle(pane);
        return { work: box(document.querySelector('.project-work-content')!),
          canvas: box(document.querySelector('.workspace-canvas')!), pane: box(pane),
          body: box(body), screen: box(pane.querySelector('.xterm-screen')!),
          border: style.borderTopWidth, radius: style.borderTopLeftRadius,
          padding: getComputedStyle(pane.parentElement!).paddingTop,
          bodyPadding: [getComputedStyle(body).paddingTop, getComputedStyle(body).paddingLeft] };
      });
      const assertPreserved = async () => {
        expect(await page.evaluate(() => {
          const saved = window as unknown as { edgeOriginal: Element; edgeHidden: Element; edgeCanvas: Element };
          return saved.edgeOriginal === document.querySelector('[aria-label="Focus shell 終端面板"] .xterm') &&
            saved.edgeHidden === document.querySelector('[aria-label="Hidden shell 終端面板"] .xterm') &&
            saved.edgeCanvas === document.querySelector('.workspace-canvas');
        })).toBe(true);
        const calls = await page.evaluate(() => (window as unknown as {
          focusFixture: { calls: (Call & { runtimeId?: string; paneId?: string })[] };
        }).focusFixture.calls);
        for (const id of ['runtime-focus', 'runtime-hidden']) {
          expect(calls.filter(call => call.runtimeId === id &&
            ['attach_runtime', 'detach_runtime', 'stop_runtime', 'forget_runtime'].includes(call.command))
            .map(call => call.command)).toEqual(['attach_runtime']);
        }
        expect(calls.filter(call => call.command === 'launch_runtime' &&
          ['pane-focus', 'pane-hidden'].includes(call.paneId ?? ''))).toEqual([]);
        await expect(hidden).toBeHidden();
      };
      const assertSingle = async () => {
        await expect(page.locator('.workspace-canvas')).toHaveClass(/single-pane/);
        await expect.poll(async () => {
          const g = await capture();
          return ['left', 'top', 'right', 'bottom'].every(key =>
            Math.abs(g.work[key as keyof typeof g.work] - g.pane[key as keyof typeof g.pane]) < 0.6);
        }).toBe(true);
        const g = await capture();
        expect(g.canvas).toEqual(g.work);
        expect([g.border, g.radius, g.padding]).toEqual(['0px', '0px', '0px']);
        expect(g.bodyPadding).toEqual(['9px', '7px']);
        await expect.poll(async () => {
          const current = await capture();
          return current.screen.left >= current.body.left && current.screen.right <= current.body.right + 0.6 &&
            current.screen.top >= current.body.top && current.screen.bottom <= current.body.bottom + 0.6 &&
            current.body.right - current.screen.right < 30 * zoom;
        }).toBe(true);
        await assertPreserved();
        return capture();
      };
      const before = await assertSingle();
      await expect.poll(async () => (await originalSize())?.cols ?? 0).toBeGreaterThan(1);
      const initialSize = await originalSize();
      await page.screenshot({ path: testInfo.outputPath('single-before.png'), fullPage: true });
      await original.getByRole('button', { name: '左右分割', exact: true }).click();
      await page.getByRole('button', { name: '開始工作', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
      await expect(page.locator('.workspace-canvas')).not.toHaveClass(/single-pane/);
      const second = page.getByRole('region', { name: 'Synthetic shell 終端面板', exact: true });
      await expect(second.locator('.pane-meta')).toContainText('執行中');
      // The project sidebar reduces split width; xterm may wrap even inside words.
      await expect.poll(async () => (await second.locator('.xterm-rows').innerText()).replace(/\s/g, '')).toContain('Syntheticfocusoutput');
      await expect(page.getByRole('separator', { name: '左右面板比例' })).toBeVisible();
      await expect.poll(async () => (await originalSize())?.cols ?? 0).toBeLessThan(initialSize!.cols!);
      const splitSize = await originalSize();
      const split = await capture();
      expect(split.canvas.left - split.work.left).toBeCloseTo(6 * zoom, 1);
      // Chrome floors a nonzero border to one device pixel at DPR 1. At
      // 50% CSS zoom its computed width is therefore 2 CSS px, painted as 1 px.
      expect(Number.parseFloat(split.border) * zoom).toBeCloseTo(Math.max(1, zoom), 5);
      expect([split.radius, split.padding]).toEqual(['7px', '3px']);
      expect(split.pane.width).toBeLessThan(before.pane.width);
      await assertPreserved();
      await page.screenshot({ path: testInfo.outputPath('split.png'), fullPage: true });
      // Maximizing a split is presentation only and must not become single-pane.
      await original.getByRole('button', { name: '最大化面板', exact: true }).click();
      await expect(page.locator('.workspace-canvas')).not.toHaveClass(/single-pane/);
      await original.getByRole('button', { name: '還原面板', exact: true }).click();
      await second.getByRole('button', { name: '關閉面板', exact: true }).click();
      await page.getByRole('button', { name: '結束並關閉', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
      await expect(page.locator('.workspace-canvas').getByRole('separator')).toHaveCount(0);
      const after = await assertSingle();
      await expect.poll(async () => {
        const current = await originalSize();
        return { cols: current?.cols, rows: current?.rows };
      }).toEqual({ cols: initialSize!.cols, rows: initialSize!.rows });
      expect(after.pane).toEqual(before.pane);
      await original.locator('.xterm-screen').click();
      await expect(original.locator('.xterm-helper-textarea')).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('single-restored.png'), fullPage: true });
      const evidence = testInfo.outputPath('edge-geometry.json');
      await writeFile(evidence, JSON.stringify({ browser: browser.version(), width, height, cssZoom: zoom, focused, before, split, after, initialSize, splitSize, restoredSize: await originalSize() }, null, 2));
      await testInfo.attach('edge-geometry', { path: evidence, contentType: 'application/json' });
    });
  }
}

test('default Zen shortcut toggles symmetrically without writing to PTY', async ({ page }) => {
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  for (const state of ['true', 'false']) {
    await input.press('Control+Shift+Enter');
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', state);
    await expect(input).toBeFocused();
  }
  expect(await page.evaluate(() => (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'write_runtime'))).toEqual([]);
  await input.press('Control+k');
  await expect.poll(() => page.evaluate(() => (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'write_runtime').map(call => call.data).join(''))).toBe('\x0b');
  await input.press('z');
  await expect.poll(() => page.evaluate(() => (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'write_runtime').map(call => call.data).join(''))).toBe('\x0bz');
  await sameTerminal(page);
});

test('Zen has one icon-only toggle, no project control, and hover/focus tooltips', async ({ page }, info) => {
  const toggle = page.locator('.workspace-tabs > .focus-mode-toggle');
  for (const active of [false, true]) {
    const label = active ? '退出專注模式' : '進入專注模式';
    await expect(page.locator('.focus-mode-toggle')).toHaveCount(1);
    await expect(page.locator('.focus-project-control')).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName(label);
    await expect(toggle).toHaveAttribute('aria-pressed', String(active));
    await expect(toggle).toHaveText('');
    await expect(toggle.locator('svg')).toHaveCount(1);
    await toggle.hover();
    await expect(page.getByRole('tooltip', { name: label })).toBeVisible();
    await page.mouse.move(0, 0);
    await toggle.focus();
    await expect(page.getByRole('tooltip', { name: label })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`zen-icon-${active}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', String(active));
    await page.keyboard.press(active ? 'Space' : 'Enter');
    await expect(page.locator('[data-app-shell]')).toHaveAttribute('data-focus-mode', String(!active));
    await sameTerminal(page);
  }
});

test('hover tooltip Escape and chrome shortcut never write to the terminal', async ({ page }) => {
  const input = page.locator('.xterm-helper-textarea');
  const toggle = page.locator('.focus-mode-toggle');
  await input.focus();
  await toggle.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  for (const expanded of [true, false]) {
    await page.keyboard.press('ControlOrMeta+Shift+B');
    if (expanded) await expect(page.locator('.sidebar')).toBeVisible();
    else await expect(page.locator('.sidebar')).toBeHidden();
    await expect(input).toBeFocused();
  }
  expect(await page.evaluate(() => (window as unknown as { focusFixture: { calls: Call[] } }).focusFixture.calls.filter(call => call.command === 'write_runtime'))).toEqual([]);
  await sameTerminal(page);
});
