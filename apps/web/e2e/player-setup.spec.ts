import { readFileSync } from 'node:fs';
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
  await page.getByRole('button', { name: /^Keep \d+$/ }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('an imported Ur-Dragon deck can be selected again as one saved deck', async ({ page }) => {
  const decklist = readFileSync('packages/server/fixtures/coverage-decks/urdragon.txt', 'utf8');
  await page.goto('/');
  const flow = page.getByRole('region', { name: 'Play my deck' });
  for (let repeat = 0; repeat < 2; repeat++) {
    await flow.getByRole('radio', { name: 'Import deck', exact: true }).check();
    await flow.getByLabel('Deck URL or plaintext decklist').fill(decklist);
    await flow.getByRole('button', { name: 'Preview matchup' }).click();
    const preview = flow.getByLabel('Matchup preview');
    await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
    await preview.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page).toHaveURL(/\/game$/);
    await expect(page.getByRole('button', { name: /^Keep \d+$/ })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /^Keep \d+$/ }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Abandon', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Abandon' }).click();
    await expect(page).toHaveURL(/\/$/);
  }
  await flow.getByRole('radio', { name: 'Saved deck', exact: true }).check();
  const select = flow.getByLabel('Saved snapshot');
  const savedDeck = select.locator('option').filter({ hasText: 'The Ur-Dragon' });
  await expect(savedDeck).toHaveCount(1);
  const snapshotId = await savedDeck.getAttribute('value');
  await select.selectOption(snapshotId!);
  await flow.getByRole('button', { name: 'Preview matchup' }).click();
  const preview = flow.getByLabel('Matchup preview');
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await preview.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByRole('button', { name: /^Keep \d+$/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Keep \d+$/ }).click();
});
