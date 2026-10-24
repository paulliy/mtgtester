import type { Page } from '@playwright/test';
import { expect, test } from './setup-test';

/**
 * Release the player seat: the server keeps an unfinished single-player game for its own
 * browser, so a game left running would refuse the next spec's start. The opening-hand choice
 * covers the board, and Abandon lives in its Settings menu.
 */
async function abandon(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Keep \d+$/ }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('real DB-backed supported-pool setup previews and starts a human game', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'New game' })).toBeVisible();
  await expect(
    page.getByText('Saved and imported decks are disabled without a database.'),
  ).toHaveCount(0);
  // The matchup previews itself; no button stands between the choices and Start.
  const preview = page.getByLabel('Matchup preview');
  await expect(preview.locator('li')).toHaveCount(4);
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });

  await abandon(page);
});

test('a modeled deck from the gallery fills the selected seat and starts', async ({ page }) => {
  await page.goto('/');
  const preview = page.getByLabel('Matchup preview');
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: /Atarka, World Render/ }).click();
  await expect(preview.locator('li').first()).toContainText('Atarka, World Render', {
    timeout: 60_000,
  });
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });

  await abandon(page);
});

test('Play now starts a game with no setup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page).toHaveURL(/\/game$/, { timeout: 60_000 });
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });

  await abandon(page);
});
