import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // The UI tests never start a simulation or contact an AI provider.
  await page.routeWebSocket('**/ws', () => undefined);
  await page.route('**/api/known-decks', (route) => route.fulfill({ json: { decks: [] } }));
});

test('setup loads and navigation reaches the empty statistics view', async ({ page }) => {
  await page.route('**/api/stats', (route) => route.fulfill({ json: { decks: [] } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'New game' })).toBeVisible();
  await page.getByRole('link', { name: 'Stats', exact: true }).click();
  await expect(page.getByText('No finished games yet.')).toBeVisible();
});

test('a deck-only statistics body still renders, with no mana-rate claims', async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({
      json: {
        decks: [
          {
            deckSnapshotId: 'audit',
            name: 'Audit Deck',
            commanders: ['Test Commander'],
            colorIdentity: ['G'],
            archetypeTag: 'Test',
            gamesPlayed: 4,
            wins: 2,
            winRate: 0.5,
            averageFinish: 2,
            averageGameLength: 12,
            averageMulligans: 0,
            mulliganDistribution: [],
            eliminationCauses: [],
            lossesTo: [],
            manaFloodRate: null,
            manaDroughtRate: null,
          },
        ],
      },
    }),
  );
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Audit Deck' })).toBeVisible();
  await expect(page.getByText('50%').first()).toBeVisible();
  await expect(page.getByText(/flood|drought|Mana rates/i)).toHaveCount(0);
});

test('statistics list saved decks first and fold generated decks away', async ({ page }) => {
  const deck = (id: string, name: string, generated: boolean) => ({
    deckSnapshotId: id,
    name,
    generated,
    commanders: ['Test Commander'],
    colorIdentity: ['G'],
    archetypeTag: 'Test',
    gamesPlayed: 1,
    wins: 1,
    winRate: 1,
    averageFinish: 1,
    averageGameLength: 12,
    averageMulligans: 0,
    mulliganDistribution: [],
    eliminationCauses: [],
    lossesTo: [],
    manaFloodRate: null,
    manaDroughtRate: null,
  });
  await page.route('**/api/stats', (route) =>
    route.fulfill({
      json: {
        decks: [deck('gen', 'Test Commander (generated)', true), deck('mine', 'My Deck', false)],
      },
    }),
  );
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Standings' })).toBeVisible();
  await expect(page.getByRole('button', { name: /My Deck/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Test Commander \(generated\)/ })).toBeHidden();
  await page.getByRole('button', { name: /Show 1 generated deck/ }).click();
  await expect(page.getByRole('button', { name: /Test Commander \(generated\)/ })).toBeVisible();
});

test('statistics can recover from a failed request by refreshing', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/stats', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 503, json: { message: 'Test service unavailable' } })
      : route.fulfill({ json: { decks: [] } });
  });
  await page.goto('/stats');
  await expect(page.getByText('Test service unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('No finished games yet.')).toBeVisible();
});
