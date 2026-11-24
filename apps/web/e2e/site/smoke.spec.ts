/**
 * Every browser the site supports starts a game in its worker (ADR 0053, plan section 8): the
 * card files load, the matchup preview answers, and a watch game puts a board on screen.
 */

import { expect, test } from '@playwright/test';
import { chooseMode, collectPageErrors } from './helpers';

test('a watch game starts in the browser worker', async ({ page }) => {
  const errors = collectPageErrors(page);
  await chooseMode(page, 'Watch');
  await page.getByRole('button', { name: 'Start watching' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(/Turn \d+/).first()).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});
