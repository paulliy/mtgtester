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
const SEED = 'e2e-1';

test('a seeded player game plays a land, casts a spell, and abandons cleanly', async ({ page }) => {
  const playerActionRequestIds: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'playerActionRequired') {
          const requestId = message.payload?.request?.requestId;
          if (typeof requestId === 'string') playerActionRequestIds.push(requestId);
        }
      } catch {
        // Non-JSON socket frames are unrelated to player action requests.
      }
    });
  });
  const waitForNewPlayerAction = async (previousRequestId: string | undefined): Promise<string> => {
    await expect
      .poll(() => playerActionRequestIds.at(-1), { timeout: 60_000 })
      .not.toBe(previousRequestId);
    const requestId = playerActionRequestIds.at(-1);
    if (requestId === undefined || requestId === previousRequestId) {
      throw new Error('Expected a new playerActionRequired request ID after the UI action.');
    }
    // The frame can arrive before Vue renders; bind controls to this exact request.
    await expect(page.locator('.decision')).toHaveAttribute('data-request-id', requestId);
    return requestId;
  };

  await page.goto('/');
  await page.getByText('More options', { exact: true }).click();
  await page.getByPlaceholder('Fresh seed', { exact: true }).fill(SEED);
  await expect(page.getByText(`Seed: ${SEED}`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Matchup preview').getByText('Fully modeled')).toHaveCount(4, {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);

  await page.getByRole('button', { name: /^Keep \d+$/ }).click({ timeout: 60_000 });

  const playable = page.locator('.playable-now');
  // Whichever basic land the seed's deck has: its colors move with the supported pool.
  const playBasic = playable
    .getByRole('button', { name: /^Play (Plains|Island|Swamp|Mountain|Forest)(?: ×\d+)?$/ })
    .first();
  await expect(playBasic).toBeVisible({ timeout: 60_000 });
  const basic = (await playBasic.innerText()).replace(/^Play\s+/, '').replace(/\s+×\d+$/, '');
  await expect(page.locator('.turn-badge')).toContainText('Your turn');
  await expect(page.getByText('Land drop available')).toBeVisible();

  // Passing with the land drop unused asks first; choosing to play a land keeps priority.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  const reminder = page.getByRole('alertdialog', { name: /haven't played a land/ });
  await expect(reminder).toBeVisible();
  await page.getByRole('button', { name: 'Play a land' }).click();
  await expect(reminder).toBeHidden();

  const requestBeforeLand = playerActionRequestIds.at(-1);
  await playBasic.click();
  await expect(page.locator('.log .line', { hasText: `plays ${basic}` }).last()).toBeVisible();
  let currentRequestId = await waitForNewPlayerAction(requestBeforeLand);

  const castButton = playable.getByRole('button', { name: /^Cast / }).first();
  const playableLand = playable.getByRole('button', { name: /^Play (?!a land\b)/ }).first();
  const passPriority = page.getByRole('button', { name: 'Pass priority', exact: true });
  const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
  const discardPrompt = page.locator('.decision .prompt', { hasText: /^Discard down to / });
  let foundCast = await castButton.isVisible();
  for (let actionCount = 0; !foundCast && actionCount < 80; actionCount++) {
    const requestBeforeAction = currentRequestId;
    if (await playableLand.isVisible()) {
      await playableLand.click();
      await expect(page.locator('.log .line', { hasText: /plays .+/ }).last()).toBeVisible();
    } else if (await passPriority.isVisible()) {
      await passPriority.click();
      if (await passAnyway.isVisible()) await passAnyway.click();
    } else if (await discardPrompt.isVisible()) {
      // A deck with nothing castable yet reaches cleanup with eight cards: discard one by
      // clicking it in hand.
      await page.locator('.hand-card.actionable').first().click();
      const confirm = page.locator('.tray-actions').getByRole('button', { name: 'Confirm' });
      if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.click();
    } else {
      const choice = (await page.locator('.decision').innerText()).replace(/\s+/g, ' ').trim();
      throw new Error(
        `A non-priority human choice appeared before a cast action; this scenario needs an explicit UI step. The choice: ${choice}`,
      );
    }
    currentRequestId = await waitForNewPlayerAction(requestBeforeAction);
    foundCast = await castButton.isVisible();
  }
  if (!foundCast)
    throw new Error('No normal cast action became available after 80 production UI actions.');
  await expect(castButton).toBeVisible({ timeout: 60_000 });
  const castLabel = (await castButton.innerText()).trim();
  const castName = castLabel.replace(/^Cast\s+/, '').replace(/\s+×\d+$/, '');
  await castButton.click();
  await expect(page.getByText(/Auto-pay:/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.log .line', { hasText: `${castName} resolves` })).toBeVisible({
    timeout: 30_000,
  });

  // Pass the rest of this turn; the bots take theirs, and the summary reports what they did
  // since your spell resolved.
  const turnOf = async () =>
    Number(/Turn (\d+)/.exec(await page.locator('.turn-badge').innerText())?.[1] ?? 0);
  const castTurn = await turnOf();
  // The cast answered `currentRequestId`. The next request may not come this turn: the engine
  // auto-passes a player whose only options are passes (brief §7.4), so with every land tapped
  // for the spell the game can run straight on to the bots and back to your next upkeep. Each
  // step therefore waits for a request newer than the last one answered, never the answered one.
  let answeredRequestId = currentRequestId;
  for (let passes = 0; passes < 40; passes++) {
    const requestId = await waitForNewPlayerAction(answeredRequestId);
    if ((await turnOf()) > castTurn && (await passPriority.isVisible())) {
      if ((await page.locator('.turn-badge').innerText()).includes('Your turn')) break;
    }
    if (await passPriority.isVisible()) {
      await passPriority.click();
      if (await passAnyway.isVisible()) await passAnyway.click();
    } else if (await discardPrompt.isVisible()) {
      await page.locator('.hand-card.actionable').first().click();
      const confirm = page.locator('.tray-actions').getByRole('button', { name: 'Confirm' });
      if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.click();
    } else {
      const choice = (await page.locator('.decision').innerText()).replace(/\s+/g, ' ').trim();
      throw new Error(
        `A non-priority human choice appeared while passing to your next turn; this scenario needs an explicit UI step. The choice: ${choice}`,
      );
    }
    answeredRequestId = requestId;
  }
  await expect(page.locator('.turn-badge')).toContainText('Your turn');
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

  // A new turn brings a new land drop, so with a land in hand passing asks again; "Pass anyway"
  // passes. Without one there is nothing to remind, which the opening check above covered.
  const landInHand = await playableLand.isVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  if (landInHand) {
    await expect(reminder).toBeVisible();
    await page.getByRole('button', { name: 'Pass anyway' }).click();
    await expect(reminder).toBeHidden();
  } else {
    await expect(reminder).toBeHidden();
  }

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Abandon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'New game' })).toBeVisible();
});
