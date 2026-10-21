import { expect, test, type Page } from '@playwright/test';

const gitCalls = (page: Page) => page.evaluate(() => (window as unknown as { gitFixture: { calls: string[] } }).gitFixture.calls);
const project = (page: Page, name: string) => page.locator('.sidebar .project-main').filter({ hasText: name });
const gitButton = (page: Page) => page.getByRole('button', { name: 'Git', exact: true });

test('Git contribution appears only for projects with a validated repository', async ({ page }) => {
  await page.goto('/tests/browser/git-workbench.html');
  await project(page, '文件與設計').click();
  await expect.poll(async () => (await gitCalls(page)).includes('discover:p1')).toBe(true);
  await expect(gitButton(page)).toHaveCount(0);
  await project(page, '工作台介面').click();
  await expect(gitButton(page)).toBeVisible();
});

for (const width of [720, 1200]) {
  test(`repository selector isolates same-named repos without touching runtimes at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/tests/browser/git-workbench.html');
    await project(page, '工作台介面').click();
    await gitButton(page).click();
    const panel = page.locator('#activity-git-panel');
    const options = panel.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('alpha/app');
    await expect(options.nth(0)).toContainText('已暫存 1、未暫存 3');
    await expect(options.nth(1)).toContainText('沒有變更');
    await options.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByLabel('目前 repository')).toContainText('/synthetic/project-0/beta/app');
    for (const option of await options.all()) {
      expect(await option.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`git-panel-${width}.png`) });
    expect((await gitCalls(page)).filter(call => call.startsWith('runtime:'))).toEqual([]);
  });
}
