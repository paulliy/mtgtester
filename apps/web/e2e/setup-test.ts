import { expect, test } from '@playwright/test';

// Each browser's starting storage (the opening counts as seen; the board's log, piles and
// opponents' zones open) is the `storageState` in playwright.setup.config.ts.

// These specs share one DB-backed server. Release a player seat even when a scenario fails,
// so the next spec can independently start its game instead of inheriting that failure.
test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  const abandon = page.getByRole('button', { name: 'Abandon', exact: true });
  // Abandon lives in the player board's Settings menu.
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!(await abandon.isVisible()) && (await settings.isVisible())) await settings.click();
  if (await abandon.isVisible()) {
    await abandon.click();
    await page.getByRole('button', { name: 'Confirm Abandon' }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

export { expect, test };
