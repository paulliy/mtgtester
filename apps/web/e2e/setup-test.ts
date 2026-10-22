import { expect, test } from '@playwright/test';

// The player board keeps its log in a Game info column that starts closed. Specs read the log
// as part of the board, so open it for them; it sits beside the rail and covers nothing.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mtg.playerGameInfoOpen', 'true');
    } catch {
      // Storage blocked: specs that read the log will say so.
    }
  });
});

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
