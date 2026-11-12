import { expect, type Page } from '@playwright/test';

/** Opens the project board from the Focus panel, then closes the panel so the board is unobstructed. */
export async function openFullBoard(page: Page) {
  const activity = page.locator('.workspace-activity[data-activity-id="board"]');
  if (await activity.getAttribute('aria-pressed') !== 'true') await activity.click();
  await expect(activity).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.board-activity').getByRole('button', { name: /^(Open board|開啟看板)$/ }).click();
  await expect(page.locator('.project-board')).toBeVisible();
  // Opening the board leaves the panel open; close it so task controls are not duplicated.
  await expect(activity).toHaveAttribute('aria-pressed', 'true');
  await activity.click();
  await expect(activity).toHaveAttribute('aria-pressed', 'false');
}
