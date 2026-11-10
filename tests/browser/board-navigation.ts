import { expect, type Page } from '@playwright/test';

/** Opens the project board from its entry in the project tab bar. */
export async function openFullBoard(page: Page) {
  await page.locator('.workspace-board-tab').click();
  await expect(page.locator('.workspace-board-tab')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.project-board')).toBeVisible();
}
