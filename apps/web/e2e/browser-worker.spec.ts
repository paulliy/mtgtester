/**
 * Single player in the browser (ADR 0053, section 5): the bundled worker reads the site card
 * files and plays a full game against bots inside headless Chromium, with no game server.
 * `scripts/browser-worker-harness.ts` serves the page, the worker and the card files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

interface Received {
  kind: string;
  id?: number;
  text?: string;
}

const received = (page: Page) =>
  page.evaluate(() => (window as unknown as { received: Received[] }).received);
const frames = async (page: Page) =>
  (await received(page))
    .filter((message) => message.kind === 'frame')
    .map((message) => JSON.parse(message.text ?? '{}') as { type: string });
const post = (page: Page, message: unknown) =>
  page.evaluate((m) => (window as unknown as { post(m: unknown): void }).post(m), message);

const deck = readFileSync(
  resolve('packages/server/fixtures/coverage-decks/white-black-control.txt'),
  'utf8',
);

test('the worker plays a pasted deck against bots to the end, with no game server', async ({
  page,
}) => {
  await page.goto('/');
  await expect
    .poll(async () => (await received(page)).find((m) => m.kind === 'ready' || m.kind === 'failed'))
    .toMatchObject({ kind: 'ready' });

  await post(page, { kind: 'ping', id: 1 });
  await expect.poll(async () => (await received(page)).some((m) => m.kind === 'pong')).toBe(true);

  await post(page, {
    kind: 'frame',
    text: JSON.stringify({
      type: 'startGame',
      payload: {
        seats: [
          { kind: 'plaintext', text: deck },
          { kind: 'pool' },
          { kind: 'pool' },
          { kind: 'pool' },
        ],
        providerKind: 'random',
        seed: 'browser-worker',
        paceMs: 0,
      },
    }),
  });
  await expect
    .poll(
      async () =>
        (await frames(page)).some((f) => f.type === 'gameOver' || f.type === 'computeHalted'),
      { timeout: 90_000 },
    )
    .toBe(true);

  const types = (await frames(page)).map((f) => f.type);
  expect(types[0]).toBe('gameStarted');
  expect(types).toContain('stateSnapshot');
  expect(types).not.toContain('error');
  expect(
    await page.evaluate(() => (window as unknown as { workerErrors: string[] }).workerErrors),
  ).toEqual([]);
});
