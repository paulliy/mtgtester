import { expect, test } from './setup-test';

test('real DB-backed supported-pool setup previews and starts a human game', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Play my deck' })).toBeVisible();
  await expect(page.getByText('Advanced pod setup')).toBeVisible();
  await expect(
    page.getByText('Saved and imported decks are disabled without a database.'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview matchup' }).click();
  const preview = page.getByLabel('Matchup preview');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.locator('li')).toHaveCount(4);
  await expect(preview.getByText('Fully modeled')).toHaveCount(4);
  await preview.getByRole('button', { name: 'Play' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });

  // Release the player seat: the server keeps an unfinished single-player game for its own
  // browser, so a game left running would refuse the next spec's start.
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
});
