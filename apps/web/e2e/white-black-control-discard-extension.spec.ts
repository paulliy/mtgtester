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

function handCard(page: Page, name: string) {
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

function life(page: Page, seat: string): Locator {
  if (seat === 'P1') return page.locator('.human-zone .life-badge');
  return page.locator(
    `.opponent[data-seat="${seat}"] .life-badge, .seat[data-seat="${seat}"] .life-badge`,
  );
}

async function cast(page: Page, name: string, targetSeat?: string): Promise<void> {
  const spell = handCard(page, name).first();
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  const autoPay = page.getByText(/Auto-pay/);
  const confirmAction = page.getByRole('button', { name: 'Confirm', exact: true });
  if (!(await autoPay.isVisible()) && !(await confirmAction.isVisible())) {
    // Cards with multiple actions (for example, cycling) first show an action picker.
    await page
      .getByRole('button', { name: /^Cast / })
      .first()
      .click();
  }
  await expect(confirmAction).toBeVisible();
  if (targetSeat !== undefined) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
    await opponent(page, targetSeat).locator('header').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function castAndResolve(page: Page, name: string): Promise<void> {
  await cast(page, name);
  const resolved = page.locator('.log .line').filter({ hasText: `${name} resolves` });
  let passed = false;
  await expect
    .poll(
      async () => {
        if (await resolved.isVisible()) return true;
        const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
        if (
          !passed &&
          (await page.locator('.stack').getByText(name, { exact: true }).isVisible()) &&
          (await pass.isVisible())
        ) {
          passed = true;
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        }
        return false;
      },
      { timeout: 20_000 },
    )
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

test('Archfiend of Ifnir: your discard puts -1/-1 counters on opposing creatures', async ({
  page,
}) => {
  const title = 'Archfiend of Ifnir: your discard puts -1/-1 counters on opposing creatures';
  await runScenario(page, title);
  await castAndResolve(page, 'Archfiend of Ifnir');
  await expect(permanent(page, 'Archfiend of Ifnir')).toBeVisible();

  const p2 = permanent(page, 'Lab P2 Counter Witness');
  const p3 = permanent(page, 'Lab P3 Counter Witness');
  const p4 = permanent(page, 'Lab P4 Counter Witness');
  await passUntil(page, p2.getByText(/-1\/-1/));
  for (const witness of [p2, p3, p4]) await expect(witness.getByText(/-1\/-1/)).toBeVisible();
  await expect(handCard(page, 'Lab P1 Duress Choice')).toHaveCount(0);
});

test('Archfiend normally casts one copy and cycles another with an opponent-only payoff', async ({
  page,
}) => {
  await runScenario(page, 'Archfiend of Ifnir: cast one copy and cycle another for two mana');
  await handCard(page, 'Archfiend of Ifnir').first().click();
  await page.getByRole('button', { name: 'Cast {3}{B}{B}', exact: true }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.locator('.stack').getByText('Archfiend of Ifnir', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(
    page.locator('.log .line').filter({ hasText: 'Archfiend of Ifnir resolves' }),
  ).toBeVisible();
  await expect(permanent(page, 'Archfiend of Ifnir')).toBeVisible();

  await expect(handCard(page, 'Archfiend of Ifnir')).toHaveClass(/actionable/);
  await handCard(page, 'Archfiend of Ifnir').click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(handCard(page, 'Plains')).toBeVisible();
  await expect(handCard(page, 'Archfiend of Ifnir')).toHaveCount(0);
  await expect(
    page
      .locator('.human-zone .zone')
      .filter({ hasText: 'Graveyard' })
      .getByRole('img', { name: 'Archfiend of Ifnir', exact: true }),
  ).toBeVisible();
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(permanent(page, `Lab ${seat} Cycling Counter Witness`)).toContainText('-1/-1');
  await expect(permanent(page, 'Lab Own Cycling Counter Witness')).not.toContainText('-1/-1');
  await expect(permanent(page, 'Archfiend of Ifnir')).toContainText('flying');
  await expect(page.locator('.human-zone').getByTitle('Tapped', { exact: true })).toHaveCount(1);
});

test('Waste Not draws exactly one card for an opponent noncreature nonland discard', async ({
  page,
}) => {
  await runScenario(page, 'Waste Not: Duress discards Sol Ring and draws one card');
  await castAndResolve(page, 'Waste Not');
  await cast(page, 'Duress', 'P2');
  await expect(handCard(page, 'Plains')).toBeVisible();
  await expect(page.locator('.log .line').filter({ hasText: 'draws Plains' })).toHaveCount(1);
  await expect(
    opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)', exact: true }),
  ).toBeVisible();
  await expect(
    opponent(page, 'P2').getByRole('img', { name: 'Sol Ring', exact: true }),
  ).toBeVisible();
  await expect(permanent(page, 'Zombie')).toHaveCount(0);
  await expect(
    page.locator('.human-zone .resource').filter({ hasText: 'Mana ready' }),
  ).toContainText('1');
});

test('Tinybones Joins Up triggers on a legendary creature and excludes a nonlegendary entry', async ({
  page,
}) => {
  await runScenario(page, 'Tinybones Joins Up: a legendary creature mills P2 and costs one life');
  await castAndResolve(page, 'Tinybones Joins Up');
  await page.getByRole('button', { name: 'Choose no more targets', exact: true }).click();
  await castAndResolve(page, 'Lab Nonlegendary Entry Witness');
  await expect(page.getByRole('button', { name: 'Target P2', exact: true })).toHaveCount(0);
  await expect(life(page, 'P2')).toHaveText('40');
  await expect(opponent(page, 'P2').getByRole('heading', { name: /Graveyard/ })).toHaveCount(0);
  await castAndResolve(page, 'Tinybones, Trinket Thief');
  await expect(page.getByRole('button', { name: 'Target P2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Target P2', exact: true }).click();
  await page.getByRole('button', { name: 'Choose no more targets', exact: true }).click();
  await expect(life(page, 'P2')).toHaveText('39');
  await expect(
    opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)', exact: true }),
  ).toBeVisible();
  await expect(opponent(page, 'P2').getByRole('img', { name: 'Swamp', exact: true })).toBeVisible();
  await expect(life(page, 'P3')).toHaveText('40');
  await expect(life(page, 'P4')).toHaveText('40');
});

test('Hushbringer suppresses a real death trigger after a normal cast', async ({ page }) => {
  await runScenario(
    page,
    'Hushbringer: a real death trigger works before it enters and is suppressed afterward',
  );
  async function destroy(name: string) {
    const spellName = 'Lab Hushbringer Destroy Spell';
    const resolved = page.locator('.log .line').filter({ hasText: `${spellName} resolves` });
    const before = await resolved.count();
    await handCard(page, spellName).first().click();
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, name).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    let passed = false;
    await expect
      .poll(
        async () => {
          if ((await resolved.count()) > before) return true;
          const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
          if (
            !passed &&
            (await page.locator('.stack').getByText(spellName, { exact: true }).isVisible()) &&
            (await pass.isVisible())
          ) {
            passed = true;
            await pass.click({ timeout: 1_000 }).catch(() => undefined);
          }
          return false;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(permanent(page, name)).toHaveCount(0);
  }
  await destroy('Lab Before Hushbringer Death Witness');
  await expect
    .poll(
      async () =>
        (await life(page, 'P2').textContent()) === '41' ||
        (await page.getByRole('button', { name: 'Pass priority', exact: true }).isVisible()),
    )
    .toBe(true);
  if ((await life(page, 'P2').textContent()) !== '41')
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(life(page, 'P2')).toHaveText('41');
  await castAndResolve(page, 'Hushbringer');
  await destroy('Lab After Hushbringer Death Witness');
  await expect(life(page, 'P2')).toHaveText('41');
  await expect(
    opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (2)', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.log .line').filter({ hasText: 'gains 1 life' })).toHaveCount(1);
});

test('Waste Not: an opponent creature and land discard produce their printed payoffs', async ({
  page,
}) => {
  const title = 'Waste Not: an opponent discards a creature and a land';
  await runScenario(page, title);
  await castAndResolve(page, 'Waste Not');
  await expect(permanent(page, 'Waste Not')).toBeVisible();
  await cast(page, 'Hymn to Tourach', 'P2');
  await expect(page.getByText('Hymn to Tourach resolves').first()).toBeVisible({ timeout: 20_000 });

  // Waste Not's two abilities trigger together. Choosing one stacks them in APNAP order;
  // the viewer then resolves both and shows their separate token and mana results.
  await page
    .getByRole('button', { name: /Waste Not: Create a 2\/2 black Zombie creature token/ })
    .click();
  const zombie = permanent(page, 'Zombie');
  await expect(zombie).toBeVisible({ timeout: 20_000 });
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (2)' })).toBeVisible();
  await expect(page.getByText('2B', { exact: true })).toBeVisible();
});

test('Whispers of Emrakul: delirium makes the opponent discard two at random', async ({ page }) => {
  const title = 'Whispers of Emrakul: delirium makes the opponent discard two at random';
  await runScenario(page, title);
  await cast(page, 'Whispers of Emrakul', 'P2');

  await expect(page.getByText('Whispers of Emrakul resolves').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(opponent(page, 'P2')).toContainText('0 in hand');
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (2)' })).toBeVisible();
  await expect(page.getByText(/discards Lab P2 Random Discard/).first()).toBeVisible();
});

test('Painful Quandary: an opponent cast triggers a discard-or-life choice', async ({ page }) => {
  const title = 'Painful Quandary: an opponent cast triggers a discard-or-life choice';
  await runScenario(page, title);
  await castAndResolve(page, 'Painful Quandary');
  await expect(permanent(page, 'Painful Quandary')).toBeVisible();

  await passUntil(page, permanent(page, 'Lab P2 Quandary Test Creature'));
  await expect(life(page, 'P2')).toHaveText('40');
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(page.getByText(/discards Swamp/i).first()).toBeVisible();
  await expect(page.getByText(/loses 5 life unless they discard a card resolves/i)).toBeVisible();
});

test('Vicious Rumors: opponents lose life, discard, mill, and its caster gains life', async ({
  page,
}) => {
  const title = 'Vicious Rumors: opponents lose life and discard before milling';
  await runScenario(page, title);
  await castAndResolve(page, 'Vicious Rumors');

  await expect(life(page, 'P1')).toHaveText('41');
  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(life(page, seat)).toHaveText('39');
    await expect(
      opponent(page, seat).getByRole('heading', { name: 'Graveyard (2)' }),
    ).toBeVisible();
  }
  await expect(page.getByText(/mills Lab P2 Rumors Mill/i)).toBeVisible();
});

test('Rankle: combat damage lets you choose discard and lose-life/draw modes', async ({ page }) => {
  const title = 'Rankle: combat damage lets you choose discard and draw modes';
  await runScenario(page, title);
  await castAndResolve(page, 'Rankle, Master of Pranks');
  const rankle = permanent(page, 'Rankle, Master of Pranks');
  await expect(rankle).toBeVisible();

  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 20_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Rankle, Master of Pranks' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  const selectedMode = page.getByRole('button', {
    name: 'Each player discards a card; Each player loses 1 life and draws a card',
    exact: true,
  });
  await expect(selectedMode).toBeVisible({ timeout: 20_000 });
  await selectedMode.click();
  await expect(handCard(page, 'Lab P1 Rankle Draw')).toBeVisible({ timeout: 20_000 });
  await expect(life(page, 'P1')).toHaveText('39');
  await expect(handCard(page, 'Lab P1 Rankle Discard')).toHaveCount(0);
  await expect(page.getByText(/discards Lab P1 Rankle Discard/i).first()).toBeVisible();
});

test('Rankle attacks with haste and flying, then applies all three modes to every player', async ({
  page,
}) => {
  await runScenario(page, 'Rankle: all four players discard, lose life, draw and sacrifice');
  await castAndResolve(page, 'Rankle, Master of Pranks');
  await expect(permanent(page, 'Rankle, Master of Pranks')).toContainText('haste');
  await expect(permanent(page, 'Rankle, Master of Pranks')).toContainText('flying');
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Rankle, Master of Pranks' })
    .getByRole('button', { name: 'P2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: 'Each player discards a card; Each player loses 1 life and draws a card; Each player sacrifices a creature',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Each player discards a card; Each player loses 1 life and draws a card; Each player sacrifices a creature',
      exact: true,
    })
    .click();
  const sacrifice = page
    .locator('.decision-panel .panel-group')
    .filter({ has: page.getByRole('img', { name: 'Lab P1 Rankle Sacrifice', exact: true }) });
  await expect(sacrifice).toBeVisible();
  await sacrifice.getByRole('button', { name: 'Sacrifice', exact: true }).click();
  await expect(handCard(page, 'Lab P1 Rankle Draw')).toBeVisible();
  await expect(life(page, 'P1')).toHaveText('39');
  await expect(permanent(page, 'Rankle, Master of Pranks')).toBeVisible();
  for (const seat of ['P1', 'P2', 'P3', 'P4']) {
    await expect(permanent(page, `Lab ${seat} Rankle Sacrifice`)).toHaveCount(0);
    const graveyard =
      seat === 'P1'
        ? page.locator('.human-zone .zone').filter({ hasText: 'Graveyard' })
        : opponent(page, seat).locator('.opponent-zones .zone').filter({ hasText: 'Graveyard' });
    await expect(
      graveyard.getByRole('img', { name: `Lab ${seat} Rankle Discard`, exact: true }),
    ).toBeVisible();
    await expect(
      graveyard.getByRole('img', { name: `Lab ${seat} Rankle Sacrifice`, exact: true }),
    ).toBeVisible();
    if (seat !== 'P1') {
      await expect(opponent(page, seat)).toContainText('1 in hand');
      await expect(life(page, seat)).toHaveText(seat === 'P2' ? '36' : '39');
    }
  }
});

test('Tinybones Joins Up: choose multiple players to discard', async ({ page }) => {
  const title = 'Tinybones Joins Up: choose multiple players to discard';
  await runScenario(page, title);
  await castAndResolve(page, 'Tinybones Joins Up');

  await expect(
    page.getByText(/Tinybones Joins Up: choose a target \(0 chosen\), or stop choosing\./).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Target P2', exact: true }).click();
  await expect(
    page
      .getByText(/Tinybones Joins Up: choose another target \(1 chosen\), or stop choosing\./)
      .first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Target P3', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Choose no more targets', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Choose no more targets', exact: true }).click();

  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(opponent(page, 'P3').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(page.getByText(/discards Lab P2 Tinybones Discard/i).first()).toBeVisible();
  await expect(page.getByText(/discards Lab P3 Tinybones Discard/i).first()).toBeVisible();
});

test('Tinybones, Trinket Thief: an opponent discard draws a card at end step', async ({ page }) => {
  const title = 'Tinybones, Trinket Thief: an opponent discard draws a card at end step';
  await runScenario(page, title);
  await castAndResolve(page, 'Tinybones, Trinket Thief');
  await cast(page, 'Duress', 'P2');

  await expect(page.getByText(/discards Lab P2 Tinybones Discard/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await passUntil(page, handCard(page, 'Lab Tinybones End Step Draw'));
  await expect(handCard(page, 'Lab Tinybones End Step Draw')).toBeVisible();
  await expect(life(page, 'P1')).toHaveText('39');
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
});
