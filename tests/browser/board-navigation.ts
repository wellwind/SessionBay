import { expect, type Page } from '@playwright/test';

export async function openFullBoard(page: Page) {
  const activity = page.locator('.workspace-activity[data-activity-id="board"]');
  if (await activity.getAttribute('aria-pressed') !== 'true') await activity.click();
  await page.getByRole('button', { name: /^(Open full board|開啟完整看板)$/ }).click();
  // Close the panel so the full board is unobstructed and task controls are not duplicated.
  await expect(activity).toHaveAttribute('aria-pressed', 'true');
  await activity.click();
  await expect(activity).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.project-board')).toBeVisible();
}
