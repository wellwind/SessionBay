import { expect, test } from '@playwright/test';

for (const width of [800, 1200]) for (const theme of ['dark', 'light']) {
  test(`membership star ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`/tests/browser/workspace-focus-mode.html?edge=1&theme=${theme}&palette=code-modern`);
    await page.getByRole('button', { name: '開啟工作區 Synthetic focus Focus shell', exact: true }).click();
    // Narrow main areas collapse project info/actions into a keyboard menu.
    const projectMenu = page.getByRole('button', { name: '專案資訊與操作', exact: true });
    if (await projectMenu.isVisible()) await projectMenu.click();
    await page.getByRole('button', { name: '重新命名專案', exact: true }).click();
    await page.getByRole('textbox', { name: '顯示名稱', exact: true }).fill('Synthetic long project name '.repeat(6));
    await page.getByRole('button', { name: '儲存名稱', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const star = page.locator('.project-membership');
    const title = page.locator('.project-title-row h1');
    const geometry = async () => ({ star: await star.boundingBox(), title: await title.boundingBox() });
    const before = await geometry();
    expect(before.star!.x + before.star!.width).toBeLessThanOrEqual(before.title!.x);
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await star.focus();
    await page.keyboard.press('Enter');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    expect(await geometry()).toEqual(before);
    await page.keyboard.press('Enter');
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(await geometry()).toEqual(before);
    await expect(star).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '新增工作', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar .project-membership')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('membership.png'), fullPage: true });
    // Dismiss the compact project menu so its popover does not cover the tab strip.
    if (await projectMenu.isVisible() && await projectMenu.getAttribute('aria-expanded') === 'true') await projectMenu.click();
    await page.getByRole('button', { name: '進入專注模式', exact: true }).click();
    await expect(star).toBeHidden();
    await page.keyboard.press('ControlOrMeta+Shift+B');
    // Revealed Zen controls may collapse into the same menu, depending on the measured
    // width; wait for the layout to settle (star or menu) before deciding.
    await expect(star.or(projectMenu)).toBeVisible();
    if (await projectMenu.isVisible() && await projectMenu.getAttribute('aria-expanded') !== 'true') await projectMenu.click();
    await expect(star).toBeVisible();
  });
}
