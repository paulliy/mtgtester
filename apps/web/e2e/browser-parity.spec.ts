/**
 * Browser play matches Bun play (ADR 0053, plan section 8). The harness plays the benchmark pods
 * in Bun and serves their fingerprints; this page plays the same pods in headless Chromium with
 * the same game code. A fingerprint hashes every decision request with its options, every
 * answer, the whole event log and the outcome, so equal fingerprints mean identical games.
 */

import { expect, test } from '@playwright/test';

interface Fingerprint {
  seed: number;
  fingerprint: string;
}

test('the benchmark pods give the same fingerprints in the browser as in Bun', async ({ page }) => {
  const expected = (await (
    await page.request.get('/parity/expected.json')
  ).json()) as Fingerprint[];
  expect(expected.length).toBeGreaterThan(0);
  await page.goto('/parity');
  await page.waitForFunction(() => 'runParity' in window);
  const played = await page.evaluate(() =>
    (window as unknown as { runParity(url: string): Promise<Fingerprint[]> }).runParity(
      '/parity/pods.json',
    ),
  );
  expect(played).toEqual(expected);
});
