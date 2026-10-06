import { expect, test } from '@playwright/test';

// These specs share one DB-backed server. Release a player seat even when a scenario fails,
// so the next spec can independently start its game instead of inheriting that failure.
test.afterEach(async ({ page }) => {
  const abandon = page.getByRole('button', { name: 'Abandon', exact: true });
  if (!page.isClosed() && (await abandon.isVisible())) {
    await abandon.click();
    await page.getByRole('button', { name: 'Confirm Abandon' }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

export { expect, test };
