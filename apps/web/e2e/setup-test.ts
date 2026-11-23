import { expect, test } from '@playwright/test';

// The player board keeps its log in a Game info column, your lands, graveyard and exile in piles,
// and opponents' zones behind a button, all closed at first. Specs read them as part of the board, so open them; the board's own
// spec checks the closed piles.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      // The New game opening ("Where to?") was seen, so specs land on the setup panel.
      localStorage.setItem('decktank.opened', 'true');
      localStorage.setItem('mtg.playerGameInfoOpen', 'true');
      localStorage.setItem('mtg.playerOpponentZonesOpen', 'true');
      for (const pile of ['lands', 'graveyard', 'exile']) {
        localStorage.setItem(`mtg.playerPile.${pile}`, 'true');
      }
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
