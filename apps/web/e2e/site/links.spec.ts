/**
 * Single player and the multiplayer tables link both ways on one site (ADR 0053, plan sections
 * 7 and 8), and an invite link from before the tables moved still lands on its table.
 */

import { expect, test } from '@playwright/test';
import { collectPageErrors } from './helpers';

test('the compass goes to the tables, and the tables come back to single player', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Multiplayer/ }).click();
  await expect(page).toHaveURL(/\/multiplayer$/);
  await expect(page.getByRole('heading', { name: 'Host a table' })).toBeVisible();
  await page.getByTestId('single-player').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /New game/ })).toBeAttached();
  expect(errors).toEqual([]);
});

test('an old invite link keeps its invite on the way to its table', async ({ page }) => {
  await page.goto('/t/abcdefghijklmnop#invite-code');
  await expect(page).toHaveURL(/\/multiplayer\/abcdefghijklmnop#invite-code$/);
});
