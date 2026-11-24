/**
 * Single player on the public site, with no game server (ADR 0053, plan section 8): a watch game
 * against four bots plays to its end and rewinds, and a solo game deals an opening hand, takes
 * the player's land drops and passes across turns, then ends when the player leaves.
 */

import { expect, test, type Locator } from '@playwright/test';
import { boardTurn, chooseMode, collectPageErrors } from './helpers';

test('a watch game plays to the end in the browser and rewinds', async ({ page }) => {
  const errors = collectPageErrors(page);
  await chooseMode(page, 'Watch');
  await page.getByRole('button', { name: 'Pacing', exact: true }).click();
  await page.getByLabel('Pace').fill('0');
  await page.getByRole('button', { name: 'Start watching' }).click();
  await expect(page).toHaveURL(/\/game$/);

  const result = page.getByRole('dialog', { name: /wins|halted|drawn/ });
  await expect(result).toBeVisible({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Close results' }).click();
  await expect(result).toBeHidden();

  const last = await boardTurn(page);
  expect(last).toBeGreaterThan(2);
  await page.getByRole('button', { name: 'Playback' }).click();
  await page.getByRole('button', { name: '◀ Turn' }).click();
  await page.getByRole('button', { name: '◀ Turn' }).click();
  await expect.poll(() => boardTurn(page)).toBeLessThan(last);
  expect(errors).toEqual([]);
});

test('a solo game deals, plays across turns, and ends when the player leaves', async ({ page }) => {
  const errors = collectPageErrors(page);
  await chooseMode(page, 'Play');
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await page.getByRole('button', { name: /^Keep \d+$/ }).click({ timeout: 60_000 });

  const playable = page.locator('.playable-now');
  const playLand = playable
    .getByRole('button', { name: /^Play (Plains|Island|Swamp|Mountain|Forest)(?: ×\d+)?$/ })
    .first();
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
  const discard = page.locator('.decision .prompt', { hasText: /^Discard down to / });
  const badge = page.locator('.turn-badge');
  await expect(badge).toBeVisible({ timeout: 60_000 });
  const firstTurn = await boardTurn(page);

  // Play a land when one is offered and pass otherwise, until the game is two rounds on. The
  // board re-renders as the bots act, so a control seen a moment ago may be gone: each click
  // gives up quickly and the loop looks again.
  const tryClick = (target: Locator) =>
    target.click({ timeout: 2_000 }).then(
      () => true,
      () => false,
    );
  for (let step = 0; step < 300 && (await boardTurn(page)) < firstTurn + 8; step++) {
    if ((await playLand.isVisible()) && (await tryClick(playLand))) continue;
    if ((await pass.isVisible()) && (await tryClick(pass))) {
      if (await passAnyway.isVisible({ timeout: 500 }).catch(() => false)) {
        await tryClick(passAnyway);
      }
      continue;
    }
    if (await discard.isVisible()) {
      await tryClick(page.locator('.hand-card.actionable').first());
      const confirm = page.locator('.tray-actions').getByRole('button', { name: 'Confirm' });
      if (await confirm.isVisible({ timeout: 1_000 }).catch(() => false)) await tryClick(confirm);
      continue;
    }
    await page.waitForTimeout(250);
  }
  expect(await boardTurn(page)).toBeGreaterThanOrEqual(firstTurn + 8);

  await page.getByRole('button', { name: 'Leave game' }).click();
  await page.getByRole('button', { name: 'Confirm Abandon' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});
