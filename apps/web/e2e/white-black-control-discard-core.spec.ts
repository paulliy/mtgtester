import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  await page.locator('#scenario-select').selectOption({ label: title });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function handCard(page: Page, name: string): Locator {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function opponent(page: Page, seat: string): Locator {
  return page.locator(`.opponent[data-seat="${seat}"], .seat[data-seat="${seat}"]`);
}

function permanent(page: Page, name: string): Locator {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

async function cast(page: Page, name: string, targetSeat?: string): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  const autoPay = page.getByText(/Auto-pay/);
  if (!(await autoPay.isVisible()))
    await page
      .getByRole('button', { name: /^Cast / })
      .first()
      .click();
  await expect(autoPay).toBeVisible();
  if (targetSeat !== undefined) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
    await opponent(page, targetSeat).locator('header').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function castAndResolve(page: Page, name: string, targetSeat?: string): Promise<void> {
  const resolvedBefore = await page.getByText(`${name} resolves`).count();
  await cast(page, name, targetSeat);
  await expect
    .poll(async () => (await page.getByText(`${name} resolves`).count()) > resolvedBefore, {
      timeout: 20_000,
    })
    .toBe(true);
}

async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test('Hymn to Tourach: normal cast makes its target discard two cards at random', async ({
  page,
}) => {
  const title = 'Hymn to Tourach: cast normally and make the target discard two cards at random';
  await runScenario(page, title);
  await castAndResolve(page, 'Hymn to Tourach', 'P2');

  await expect(opponent(page, 'P2')).toContainText('0 in hand');
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (2)' })).toBeVisible();
  await expect(page.getByText(/Hymn to Tourach resolves/).first()).toBeVisible();
});

test('Bottomless Pit: normal cast triggers random discard at P2’s next upkeep', async ({
  page,
}) => {
  const title = 'Bottomless Pit: cast normally, then discard at the next player upkeep';
  await runScenario(page, title);
  await castAndResolve(page, 'Bottomless Pit');
  await expect(permanent(page, 'Bottomless Pit')).toBeVisible();

  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' }));
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
});

test('Necrogen Mists: normal cast lets P2 choose a card at the next upkeep', async ({ page }) => {
  const title = 'Necrogen Mists: cast normally, then choose a card at the next player upkeep';
  await runScenario(page, title);
  await castAndResolve(page, 'Necrogen Mists');
  await expect(permanent(page, 'Necrogen Mists')).toBeVisible();

  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' }));
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
  await expect(page.getByText(/discards Lab P2 Mists Card Two/i).first()).toBeVisible();
});

test('Hypnotic Specter: unblocked combat damage triggers the random discard', async ({ page }) => {
  const title = 'Hypnotic Specter: unblocked combat damage makes the opponent discard at random';
  await runScenario(page, title);
  const specter = permanent(page, 'Hypnotic Specter');
  await expect(specter).toBeVisible();
  await expect(specter).toContainText(/Flying/i);

  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Hypnotic Specter' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' }));
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
  await expect(page.getByText(/discards Lab P2 Specter Card/i).first()).toBeVisible();
});

test('Oppression: its normal cast makes an opponent discard after a spell cast', async ({
  page,
}) => {
  const title = 'Oppression: cast normally, then an opponent casts and discards';
  await runScenario(page, title);
  await castAndResolve(page, 'Oppression');
  await expect(permanent(page, 'Oppression')).toBeVisible();

  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  // P2 drew normally on the turn advanced to by the prepared continuation.
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
  await expect(page.getByText(/Cast Arcane Signet/).first()).toBeVisible();
  await expect(page.getByText(/discards Lab P2 Oppression Discard Card/i).first()).toBeVisible();
});

test('Syphon Mind: normal cast makes each other player discard and draws three', async ({
  page,
}) => {
  const title = 'Syphon Mind: each other player discards and you draw for each';
  await runScenario(page, title);
  await castAndResolve(page, 'Syphon Mind');

  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(
      opponent(page, seat).getByRole('heading', { name: 'Graveyard (1)' }),
    ).toBeVisible();
  }
  for (const name of [
    'Lab P1 Syphon Draw One',
    'Lab P1 Syphon Draw Two',
    'Lab P1 Syphon Draw Three',
  ]) {
    await expect(handCard(page, name)).toBeVisible();
  }
});

test("Geth's Grimoire: normal cast draws for two discards from an opponent's Hymn", async ({
  page,
}) => {
  const title =
    "Geth's Grimoire: cast it, then an opponent casts Hymn and you draw for each discard";
  await runScenario(page, title);
  await castAndResolve(page, "Geth's Grimoire");
  await expect(permanent(page, "Geth's Grimoire")).toBeVisible();

  const pendingDrawTriggers = page.getByRole('button', {
    name: /Geth's Grimoire: You may draw a card \(event player: P3\)/,
  });
  await expect(pendingDrawTriggers).toHaveCount(2);
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  await pendingDrawTriggers.first().click();
  await expect(yes).toBeVisible();
  await yes.click();
  await expect(yes).toBeVisible();
  await yes.click();

  await expect(opponent(page, 'P3').getByRole('heading', { name: 'Graveyard (2)' })).toBeVisible();
  await expect(handCard(page, 'Lab P1 Grimoire Draw One')).toBeVisible();
  await expect(handCard(page, 'Lab P1 Grimoire Draw Two')).toBeVisible();
});
