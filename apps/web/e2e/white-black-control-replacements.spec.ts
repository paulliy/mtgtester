import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

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

function permanent(page: Page, name: string): Locator {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function opponentPermanent(page: Page, seat: string, name: string): Locator {
  return page
    .locator(`.opponent[data-seat="${seat}"] .object:not(.board-card-leave-active)`)
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function opponentExile(page: Page, seat: string): Locator {
  return page
    .locator(`.opponent[data-seat="${seat}"] .opponent-zones .zone`)
    .filter({ hasText: 'Exile' });
}

function humanZone(page: Page, zoneName: 'Graveyard' | 'Exile'): Locator {
  return page.locator('.human-zone .zones-strip .zone').filter({ hasText: zoneName });
}

async function castAndResolve(page: Page, name: string, target?: Locator): Promise<void> {
  const resolvesBefore = await page.getByText(`${name} resolves`, { exact: true }).count();
  const spell = handCard(page, name).first();
  await expect(spell).toHaveClass(/actionable/, { timeout: 20_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  if (target !== undefined) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await target.click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect
    .poll(async () => {
      if ((await page.getByText(`${name} resolves`, { exact: true }).count()) > resolvesBefore) return true;
      const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
      if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
      return false;
    }, {
      timeout: 20_000,
    })
    .toBe(true);
}

async function passUntil(page: Page, target: Locator, timeout = 60_000): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout },
    )
    .toBe(true);
}

test('Planar Void casts normally, then exiles P2’s permanent destroyed by Generous Gift', async ({
  page,
}) => {
  const title = 'Planar Void: normal cast, then exile a permanent destroyed by Generous Gift';
  await runScenario(page, title);
  await castAndResolve(page, 'Planar Void');
  await expect(permanent(page, 'Planar Void')).toBeVisible();

  await castAndResolve(page, 'Generous Gift', permanent(page, 'Sol Ring'));
  const orderTrigger = page.getByRole('button', { name: 'Planar Void: Exile that card from its graveyard', exact: true });
  await expect.poll(async () => {
    if (await opponentExile(page, 'P2').getByRole('img', { name: 'Sol Ring', exact: true }).isVisible()
      && await humanZone(page, 'Exile').getByRole('img', { name: 'Generous Gift', exact: true }).isVisible()) return true;
    if (await orderTrigger.first().isVisible()) await orderTrigger.first().click();
    else {
      const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
      if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
    }
    return false;
  }, { timeout: 20_000 }).toBe(true);
  await expect(opponentPermanent(page, 'P2', 'Sol Ring')).toHaveCount(0);
  await expect(
    opponentExile(page, 'P2').getByRole('img', { name: 'Sol Ring', exact: true }),
  ).toBeVisible();
  await expect(
    humanZone(page, 'Exile').getByRole('img', { name: 'Generous Gift', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Generous Gift resolves/).first()).toBeVisible();
});

test('Library of Leng puts an effect-discarded card on top and the next normal draw returns it', async ({
  page,
}) => {
  const title =
    'Library of Leng: cast, redirect an effect discard to the library top, then draw it';
  await runScenario(page, title);
  await castAndResolve(page, 'Library of Leng');
  await expect(permanent(page, 'Library of Leng')).toBeVisible();
  await expect(handCard(page, 'Duress')).toBeVisible();

  await passUntil(
    page,
    page.getByRole('button', { name: 'Put it on top of your library', exact: true }),
  );
  await expect(
    page.getByText('Library of Leng: put the discarded card on top of your library?'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Put it on top of your library', exact: true }).click();
  // The engine can advance forced passes and redraw immediately; assert the
  // completed public zone result rather than requiring a transient animation.
  await expect(
    humanZone(page, 'Graveyard').getByRole('img', { name: 'Duress', exact: true }),
  ).toHaveCount(0);

  await passUntil(page, page.locator('.turn-badge').filter({ hasText: 'Turn 5' }));
  await expect(handCard(page, 'Duress')).toBeVisible();
  await expect(page.locator('.log .line').filter({ hasText: /P1.*draws Duress/i }).first()).toBeVisible();
  await expect(permanent(page, 'Library of Leng')).toBeVisible();
});

test('Leyline of the Void uses its actual opening-hand choice and exiles a destroyed opponent card', async ({
  page,
}) => {
  const title =
    'Leyline of the Void: choose its opening-hand action, then exile a destroyed opponent land';
  await runScenario(page, title);

  await expect(page.getByText(/Keep this hand or mulligan/)).toBeVisible();
  await page.getByRole('button', { name: 'Keep this hand', exact: true }).click();
  await expect(page.getByText('You may begin the game with a card from your opening hand on the battlefield.')).toBeVisible();
  await handCard(page, 'Leyline of the Void').first().click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(permanent(page, 'Leyline of the Void')).toBeVisible();
  const declineOpening = page.getByRole('button', { name: 'Keep the remaining cards in hand', exact: true });
  if (await declineOpening.isVisible()) await declineOpening.click();

  const plainsInHand = handCard(page, 'Plains');
  const gift = handCard(page, 'Generous Gift').first();
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if ((await gift.getAttribute('class'))?.includes('actionable'))
          return true;
        if (
          (await plainsInHand.first().getAttribute('class'))?.includes('actionable')
        ) {
          await plainsInHand.first().click();
          return false;
        }
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 90_000, intervals: [100, 250, 500] },
    )
    .toBe(true);

  await castAndResolve(page, 'Generous Gift', opponentPermanent(page, 'P2', 'Plains').first());
  await expect(
    opponentExile(page, 'P2').getByRole('img', { name: 'Plains', exact: true }),
  ).toBeVisible();
  await expect(permanent(page, 'Leyline of the Void')).toBeVisible();
  await expect(opponentPermanent(page, 'P2', 'Elephant')).toBeVisible();
});
