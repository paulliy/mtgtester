/**
 * Shared steps for the site specs (`playwright.site.config.ts`): the page's own errors, and the
 * way into a game from the New game compass.
 */

import { expect, type Page } from '@playwright/test';

/** Script errors the page throws, collected for the whole test. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Choose a mode on the compass and wait for its matchup preview to allow a start. */
export async function chooseMode(page: Page, mode: 'Play' | 'Watch'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(`^${mode}`) }).click();
  const start = page.getByRole('button', {
    name: mode === 'Play' ? 'Start game' : 'Start watching',
  });
  // The first preview waits for the worker to read the card files.
  await expect(start).toBeEnabled({ timeout: 60_000 });
}

/** The turn the board's status line names. */
export async function boardTurn(page: Page): Promise<number> {
  const text =
    (await page
      .getByText(/Turn \d+/)
      .first()
      .textContent()) ?? '';
  return Number(/Turn (\d+)/.exec(text)?.[1] ?? NaN);
}
