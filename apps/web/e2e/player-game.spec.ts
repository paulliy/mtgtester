import { expect, test } from './setup-test';

/**
 * A real single-player game against built-in bots, driven through the player board: keep, the
 * land-drop reminder, a land from the "Playable now" list, a spell paid by auto-pay, the
 * opponent summary, and abandoning with confirmation. Runs against the DB-backed server from
 * `playwright.setup.config.ts`, which loads the committed Oracle fixture.
 *
 * The seed fixes the decks, the shuffles, and the built-in bots' choices, but generated decks come
 * from the current supported pool. As card coverage changes, the same seed can produce different
 * opening hands; this scenario therefore casts whichever spell is available after its opening land
 * line instead of pinning to one card name.
 */
const SEED = 'e2e-14308';

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
  const playForest = playable.getByRole('button', { name: /^Play Forest(?: ×\d+)?$/ }).first();
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
  await expect(page.locator('.log .line', { hasText: 'plays Forest' }).last()).toBeVisible();

  let castButton = playable.getByRole('button', { name: /^Cast / }).first();
  if (!(await castButton.isVisible({ timeout: 1_000 }))) {
    const sameTurnForest = playable.getByRole('button', { name: /^Play Forest(?: ×\d+)?$/ }).first();
    if (await sameTurnForest.isVisible({ timeout: 1_000 })) {
      await sameTurnForest.click();
      await expect(page.locator('.log .line', { hasText: 'plays Forest' }).last()).toBeVisible();
    }
    castButton = playable.getByRole('button', { name: /^Cast / }).first();
    if (!(await castButton.isVisible({ timeout: 1_000 }))) {
      await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
      const passAnyway = page.getByRole('button', { name: 'Pass anyway' });
      if (await passAnyway.isVisible({ timeout: 1_000 })) await passAnyway.click();
      await expect(page.locator('.turn-badge')).toContainText('Your turn', { timeout: 60_000 });
      const nextTurnForest = playable.getByRole('button', { name: /^Play Forest(?: ×\d+)?$/ }).first();
      if (await nextTurnForest.isVisible({ timeout: 1_000 })) {
        await nextTurnForest.click();
        await expect(page.locator('.log .line', { hasText: 'plays Forest' }).last()).toBeVisible();
      }
      castButton = playable.getByRole('button', { name: /^Cast / }).first();
    }
  }
  await expect(castButton).toBeVisible({ timeout: 60_000 });
  const castLabel = (await castButton.innerText()).trim();
  const castName = castLabel.replace(/^Cast\s+/, '').replace(/\s+×\d+$/, '');
  await castButton.click();
  await expect(page.getByText(/Auto-pay:/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.log .line', { hasText: `${castName} resolves` })).toBeVisible({
    timeout: 30_000,
  });

  // The bots take their turns, and the summary reports what they did since your spell resolved.
  await expect(page.locator('.turn-badge')).toContainText('Your turn', {
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
  expect(report).toMatch(/Position: Turn \d+/);
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
