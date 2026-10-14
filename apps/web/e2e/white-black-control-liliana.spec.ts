import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'default' });
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

function life(page: Page, seat: string): Locator {
  if (seat === 'P1') return page.locator('.human-zone .life-badge');
  return opponent(page, seat).locator('.life-badge');
}

function opponentGraveyard(page: Page, seat: string): Locator {
  return page
    .locator(`.opponent[data-seat="${seat}"] .opponent-zones .zone`)
    .filter({ hasText: 'Graveyard' });
}

function permanent(page: Page, name: string): Locator {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function playableSource(page: Page, name: string): Locator {
  return page
    .locator('.playable-now .playable-entry')
    .filter({ hasText: name })
    .getByRole('button')
    .first();
}

async function castWalker(page: Page, cardName: string): Promise<void> {
  const walker = handCard(page, cardName);
  await expect(walker).toHaveClass(/actionable/, { timeout: 15_000 });
  await walker.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const boardWalker = permanent(page, cardName);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (
          await page
            .locator('.log .line')
            .filter({ hasText: `${cardName} resolves` })
            .isVisible()
        )
          return true;
        if (
          (await pass.isVisible()) &&
          (await page.locator('.stack').getByText(cardName, { exact: true }).isVisible())
        )
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(boardWalker).toBeVisible();
}

async function activateLoyalty(
  page: Page,
  cardName: string,
  ability: RegExp,
  target?: { kind: 'player'; seat: string } | { kind: 'permanent'; name: string },
): Promise<void> {
  const walker = permanent(page, cardName);
  await expect(walker).toBeVisible();
  // Select the source through the viewer's actual Playable now list. The board .object is a
  // layout wrapper and its class is not the reliable affordance for an available loyalty action.
  const source = playableSource(page, cardName);
  await expect(source).toBeVisible({ timeout: 15_000 });
  await source.click();
  const abilityChoice = page.getByRole('button', { name: ability });
  const confirmAction = page.getByRole('button', { name: 'Confirm', exact: true });
  await expect
    .poll(async () => (await abilityChoice.isVisible()) || (await confirmAction.isVisible()))
    .toBe(true);
  if (await abilityChoice.isVisible()) await abilityChoice.click();
  if (target !== undefined) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    if (target.kind === 'player') {
      await opponent(page, target.seat).locator('header').click();
    } else {
      await permanent(page, target.name).click();
    }
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  }
  await expect(page.getByText(`Activate ${cardName}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function chooseDiscardFromHand(page: Page, name: string): Promise<void> {
  // A hand containing one card has a forced discard and resolves without a choice panel.
  if ((await page.locator('.human-zone .hand-card:not(.hand-card-leave-active)').count()) <= 1) {
    await expect(page.locator('.log .line').filter({ hasText: `discards ${name}` })).toBeVisible();
    return;
  }
  const card = handCard(page, name);
  await expect(page.getByText(/Discard a card/).first()).toBeVisible();
  await expect(card).toHaveClass(/actionable/);
  await card.click();
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

test('Liliana of the Veil normally casts and its +1 makes each player discard', async ({
  page,
}) => {
  const title = 'Liliana of the Veil: normally cast, then +1 makes each player discard';
  await runScenario(page, title);
  await castWalker(page, 'Liliana of the Veil');

  await activateLoyalty(page, 'Liliana of the Veil', /Each player discards a card/);
  const p1Discard = 'Lab P1 Liliana Discard Card';
  await chooseDiscardFromHand(page, p1Discard);
  await passUntil(page, opponent(page, 'P4').getByRole('heading', { name: 'Graveyard (1)' }));

  for (const [seat, name] of [
    ['P2', 'Lab P2 Liliana Discard Card'],
    ['P3', 'Lab P3 Liliana Discard Card'],
    ['P4', 'Lab P4 Liliana Discard Card'],
  ]) {
    await expect(
      opponent(page, seat).getByRole('heading', { name: 'Graveyard (1)' }),
    ).toBeVisible();
    await expect(page.getByText(new RegExp(`discards ${name}`, 'i')).first()).toBeVisible();
  }
  await expect(handCard(page, p1Discard)).toHaveCount(0);
  await expect(page.getByText(/Liliana of the Veil resolves/i).first()).toBeVisible();
});

test('Liliana of the Veil normally casts and its −2 makes the targeted player sacrifice a creature', async ({
  page,
}) => {
  const title =
    'Liliana of the Veil: normally cast, then −2 makes the targeted player sacrifice a creature';
  await runScenario(page, title);
  await castWalker(page, 'Liliana of the Veil');

  await activateLoyalty(page, 'Liliana of the Veil', /Target player sacrifices a creature/, {
    kind: 'player',
    seat: 'P2',
  });
  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' }));
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(permanent(page, 'Lab P2 Liliana Sacrifice Creature')).toHaveCount(0);
  await expect(
    page.getByText(/Liliana of the Veil.*sacrifices.*Lab P2 Liliana Sacrifice Creature/i).first(),
  ).toBeVisible();
});

test('Liliana, Waker of the Dead normally casts and its +1 costs life when opponents cannot discard', async ({
  page,
}) => {
  const title = 'Liliana, Waker of the Dead: +1 discards and opponents unable to discard lose life';
  await runScenario(page, title);
  await castWalker(page, 'Liliana, Waker of the Dead');

  await activateLoyalty(
    page,
    'Liliana, Waker of the Dead',
    /Each player discards; opponents unable/,
  );
  await chooseDiscardFromHand(page, 'Lab P1 Liliana Discard Card');
  await expect(life(page, 'P2')).toHaveText('37');

  await expect(life(page, 'P2')).toHaveText('37');
  await expect(life(page, 'P4')).toHaveText('37');
  await expect(opponent(page, 'P3').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(page.locator('.log .line').filter({ hasText: 'loses 3 life' })).toHaveCount(2);
  await expect(page.getByText(/Liliana, Waker of the Dead resolves/i).first()).toBeVisible();
});

test('Liliana, Waker of the Dead normally casts and its −3 uses your graveyard to kill a creature', async ({
  page,
}) => {
  const title = 'Liliana, Waker of the Dead: −3 gives a creature −X/−X for your graveyard size';
  await runScenario(page, title);
  await castWalker(page, 'Liliana, Waker of the Dead');

  await activateLoyalty(
    page,
    'Liliana, Waker of the Dead',
    /Target creature gets -X\/-X for your graveyard size/,
    {
      kind: 'permanent',
      name: 'Lab P2 Waker Target',
    },
  );
  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' }));
  await expect(permanent(page, 'Lab P2 Waker Target')).toHaveCount(0, { timeout: 20_000 });
  await expect(permanent(page, 'Lab P2 Waker Untouched Creature')).toBeVisible();
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(
    page.getByText(/Liliana, Waker of the Dead.*Lab P2 Waker Target.*dies/i).first(),
  ).toBeVisible();
});

test('Liliana of the Veil uses its prepared −6 to make P2 divide and sacrifice a pile', async ({
  page,
}) => {
  const title = 'Liliana of the Veil: activate −6 and let P2 choose a pile to sacrifice';
  await runScenario(page, title);
  const walker = permanent(page, 'Liliana of the Veil');
  await expect(walker).toBeVisible();
  await expect(walker).toContainText('6');

  await activateLoyalty(page, 'Liliana of the Veil', /Separate permanents into piles/, {
    kind: 'player',
    seat: 'P2',
  });
  for (const [name, pile] of [
    ['Lab P2 Liliana Pile Creature One', 1],
    ['Lab P2 Liliana Pile Creature Two', 2],
    ['Lab P2 Liliana Pile Artifact', 2],
  ] as const) {
    await passUntil(page, page.getByText(`Put ${name} in a pile.`, { exact: true }));
    await page.getByRole('button', { name: `Put it in pile ${pile}`, exact: true }).click();
  }
  await passUntil(page, opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (2)' }));

  await expect(permanent(page, 'Liliana of the Veil')).toHaveCount(0);
  await expect(permanent(page, 'Lab P2 Liliana Pile Creature One')).toBeVisible();
  await expect(permanent(page, 'Lab P2 Liliana Pile Creature Two')).toHaveCount(0);
  await expect(permanent(page, 'Lab P2 Liliana Pile Artifact')).toHaveCount(0);
  await expect(page.getByText(/Liliana of the Veil.*pile/i).first()).toBeVisible();
});

test('Liliana, Waker of the Dead creates its −7 emblem and reanimates at combat with haste', async ({
  page,
}) => {
  const title = 'Liliana, Waker of the Dead: −7 emblem returns a creature at combat with haste';
  await runScenario(page, title);
  const walker = permanent(page, 'Liliana, Waker of the Dead');
  await expect(walker).toBeVisible();
  await expect(walker).toContainText('7');

  await activateLoyalty(
    page,
    'Liliana, Waker of the Dead',
    /Create a beginning-of-combat reanimation emblem/,
  );
  await expect(permanent(page, 'Liliana, Waker of the Dead')).toHaveCount(0);
  const targetImage = opponentGraveyard(page, 'P2').getByRole('img', {
    name: 'Lab P2 Waker Reanimation Target',
    exact: true,
  });
  const returned = permanent(page, 'Lab P2 Waker Reanimation Target');
  await passUntil(page, returned);
  await expect(
    page.locator('.human-zone').getByRole('img', { name: 'Lab P2 Waker Reanimation Target' }),
  ).toBeVisible();
  await expect(returned.locator('.keywords')).toContainText(/haste/i);
  await expect(targetImage).toHaveCount(0);
  await expect(page.getByText(/Liliana.*emblem/i).first()).toBeVisible();
});
