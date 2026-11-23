import { readFileSync } from 'node:fs';
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

/** Takes a seat from the Bots tab ("Who plays each seat"), then returns to the seats. */
async function sitAt(page: Page, seat: string): Promise<void> {
  await page.getByRole('button', { name: 'Bots', exact: true }).click();
  await page
    .getByRole('group', { name: `Who plays seat ${seat}` })
    .getByRole('button', { name: 'You' })
    .click();
  await page.getByRole('button', { name: 'Seats', exact: true }).click();
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

test('a modeled deck from a seat deck menu fills that seat and starts', async ({ page }) => {
  await page.goto('/');
  const preview = page.getByLabel('Matchup preview');
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Change the deck for P1' }).click();
  await page.getByRole('button', { name: /^Atarka, World Render Draconic/ }).click();
  await expect(preview.locator('li').first()).toContainText('Atarka, World Render', {
    timeout: 60_000,
  });
  await expect(preview.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });

  await abandon(page);
});

test('opponent seats take decks from their menus, and a blocked import holds Start', async ({
  page,
}) => {
  await page.goto('/');
  const seats = page.getByLabel('Matchup preview').locator('li');
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });

  // An opponent's "Change deck" opens the deck chooser for that seat.
  await page.getByRole('button', { name: 'Change the deck for P4' }).click();
  await expect(page.getByRole('group', { name: 'Decks for P4' })).toBeVisible();
  await page.getByRole('button', { name: /^The Ur-Dragon Urdragon/ }).click();
  await expect(seats.nth(3)).toContainText('The Ur-Dragon', { timeout: 60_000 });
  await expect(seats.nth(3)).toContainText('Fully modeled');

  // Your seat moves with its deck.
  await page.getByRole('button', { name: 'Change the deck for P1' }).click();
  await page.getByRole('button', { name: /^Atarka, World Render Draconic/ }).click();
  await page.getByRole('button', { name: 'Use this deck' }).click();
  await sitAt(page, 'P3');
  await expect(seats.nth(2)).toContainText('P3 · You');
  await expect(seats.nth(2)).toContainText('Atarka, World Render', { timeout: 60_000 });
  await expect(seats.nth(3)).toContainText('The Ur-Dragon', { timeout: 60_000 });

  // An import that cannot resolve is caught before the game, and Start stays off.
  await page.getByRole('button', { name: 'Change the deck for P2' }).click();
  await page
    .getByLabel('Deck link or decklist')
    .fill(['Commander', '1 Azusa, Lost but Seeking', '', 'Deck', '1 Not A Real Card'].join('\n'));
  await page.getByRole('button', { name: 'Check and import' }).click();
  await expect(seats.nth(1)).toContainText('Blocked', { timeout: 60_000 });
  await expect(page.getByText('Import stopped')).toBeVisible();
  await expect(seats.nth(1)).not.toContainText('Azusa');
  await expect(page.getByText("This matchup can't start")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start game' })).toBeDisabled();

  // Going back to a generated deck clears the block.
  await page.getByRole('button', { name: /^Generated deck Built/ }).click();
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Start game' })).toBeEnabled();
});

test('an imported Ur-Dragon deck can be selected again as one saved deck', async ({ page }) => {
  const decklist = readFileSync('packages/server/fixtures/coverage-decks/urdragon.txt', 'utf8');
  const seats = page.getByLabel('Matchup preview').locator('li');
  await page.goto('/');
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByRole('button', { name: 'Change the deck for P1' }).click();
    await page.getByLabel('Deck link or decklist').fill(decklist);
    await page.getByRole('button', { name: 'Check and import' }).click();
    await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Start game' }).click();
    await expect(page).toHaveURL(/\/game$/);
    await abandon(page);
  }
  // Two plays of the same list leave one saved deck, beside the modeled Ur-Dragon tile.
  const savedDeck = page.locator('.deck-row').filter({ hasText: 'The Ur-Dragon' }).filter({
    hasText: 'Saved',
  });
  await page.getByRole('button', { name: 'Change the deck for P1' }).click();
  await expect(savedDeck).toHaveCount(1);
  await savedDeck.click();
  await expect(seats.first()).toContainText('The Ur-Dragon', { timeout: 60_000 });
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await abandon(page);
});

test('a generated deck moves with you when you change seats', async ({ page }) => {
  await page.goto('/');
  const seats = page.getByLabel('Matchup preview').locator('li');
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  // The card shows the name in capitals; compare the text itself.
  const yours = (await seats.nth(0).locator('.seat-title').textContent()) ?? '';
  await sitAt(page, 'P3');
  await expect(seats.nth(2)).toContainText('P3 · You');
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await expect(seats.nth(2).locator('.seat-title')).toHaveText(yours);
});

test('a failed automatic preview can be retried without changing anything', async ({ page }) => {
  let failNext = true;
  await page.route('**/api/setup-preview', async (route) => {
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, json: { message: 'Preview service unavailable.' } });
    } else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('Preview service unavailable.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Start game' })).toBeDisabled();
  await page.getByRole('button', { name: 'Try again' }).click();
  const seats = page.getByLabel('Matchup preview').locator('li');
  await expect(seats.getByText('Fully modeled')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Start game' })).toBeEnabled();
});
