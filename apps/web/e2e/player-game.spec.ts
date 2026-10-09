import { expect, test } from './setup-test';

/**
 * A real single-player game against built-in bots, driven through the player board: keep, the
 * land-drop reminder, a land from the "Playable now" list, a spell paid by auto-pay, the
 * opponent summary, and abandoning with confirmation. Runs against the DB-backed server from
 * `playwright.setup.config.ts`, which loads the committed Oracle fixture.
 *
 * The seed fixes the decks, the shuffles, and the built-in bots' choices: P1 first gets priority
 * on turn 1 holding three Forests and Llanowar Elves. After the Elves resolve P1 has nothing left
 * to do, so the server passes for them until their next turn (turn 5). The generated decks come
 * from the supported pool, so a change to which cards are modeled can change what a seed deals;
 * re-pick the seed then (event-player containment moved this from `e2e-2578`, coverage PR02 from
 * `e2e-15162`, coverage PR03 from `e2e-895`).
 */
const SEED = 'e2e-1485';

test('a seeded player game plays a land, casts a spell, and abandons cleanly', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Fresh seed', { exact: true }).fill(SEED);
  await page.getByRole('button', { name: 'Preview matchup' }).first().click();
  const preview = page.getByLabel('Matchup preview');
  await expect(preview.getByText(`Seed: ${SEED}`)).toBeVisible({ timeout: 60_000 });
  await preview.getByRole('button', { name: 'Play' }).click();
  await expect(page).toHaveURL(/\/game$/);

  await page.getByRole('button', { name: 'Keep this hand' }).click({ timeout: 60_000 });

  const playable = page.locator('.playable-now');
  const playForest = playable.getByRole('button', { name: 'Play Forest ×3' });
  await expect(playForest).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.turn-badge')).toContainText('Your turn');
  await expect(page.getByText('Land drop available')).toBeVisible();

  // Passing with the land drop unused asks first; choosing to play a land keeps priority.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  const reminder = page.getByRole('alertdialog', { name: /haven't played a land/ });
  await expect(reminder).toBeVisible();
  await page.getByRole('button', { name: 'Play a land' }).click();
  await expect(reminder).toBeHidden();

  await playForest.click();
  await expect(page.getByText('Land played')).toBeVisible();
  await expect(page.locator('.log .line', { hasText: 'plays Forest' }).last()).toBeVisible();

  await playable.getByRole('button', { name: 'Cast Llanowar Elves' }).click();
  await expect(page.getByText(/Auto-pay: Forest/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.log .line', { hasText: 'Llanowar Elves resolves' })).toBeVisible({
    timeout: 30_000,
  });

  // The bots take their turns, and the summary reports what they did since the Elves.
  await expect(page.locator('.turn-badge')).toContainText('Turn 5 · Your turn', {
    timeout: 60_000,
  });
  const summary = page.locator('.bot-summary');
  await expect(summary.getByText('Since your last action')).toBeVisible();
  await expect(summary.locator('.bot-seat').first()).toBeVisible();

  // "Copy game report" puts a filable report on the clipboard: this seed and the player's own
  // deck, but no opponent decklist while the game is live.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy game report' }).click();
  await expect(page.getByText('Game report copied.')).toBeAttached();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain('## MTG Tester game report');
  expect(report).toContain(`seed \`${SEED}\``);
  expect(report).toContain('Position: Turn 5');
  expect(report).toContain('### P1 decklist (engine order)');
  expect(report).not.toMatch(/### P[234] decklist/);

  // A new turn brings a new land drop, so passing asks again; "Pass anyway" passes.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(reminder).toBeVisible();
  await page.getByRole('button', { name: 'Pass anyway' }).click();
  await expect(reminder).toBeHidden();

  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Play my deck' })).toBeVisible();
});
