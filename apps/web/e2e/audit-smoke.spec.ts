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
  await expect(page.getByText('No finished recorded games yet.')).toBeVisible();
});

test('unreliable mana metrics are unavailable while valid statistics remain visible', async ({
  page,
}) => {
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
  await expect(page.getByText('50% wins')).toBeVisible();
  // One tile covers both rates when neither can be calculated.
  await expect(page.getByText('Flood / drought', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Mana rates unavailable.', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Saved and imported decks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My Deck' })).toBeVisible();
  const generated = page.locator('details', { hasText: 'Generated decks (1)' });
  await expect(generated).not.toHaveAttribute('open');
  await expect(page.getByRole('heading', { name: 'Test Commander (generated)' })).toBeHidden();
  await generated.locator('summary').click();
  await expect(page.getByRole('heading', { name: 'Test Commander (generated)' })).toBeVisible();
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
  await expect(page.getByText('No finished recorded games yet.')).toBeVisible();
});
