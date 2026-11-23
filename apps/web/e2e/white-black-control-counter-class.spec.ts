import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'default' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
  // Player options live in the Settings menu in the top bar.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Land drop reminder').uncheck();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

async function castAndResolve(page: Page, name: string): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  const resolved = page.locator('.log .line').filter({ hasText: `${name} resolves` });
  await expect
    .poll(
      async () => {
        if (await resolved.isVisible()) return true;
        const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
        if (
          (await page.locator('.stack').getByText(name, { exact: true }).isVisible()) &&
          (await pass.isVisible())
        )
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(page.locator('.log .line').filter({ hasText: `${name} resolves` })).toBeVisible();
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

async function levelBandit(page: Page, level: 2 | 3): Promise<void> {
  const activation = page.getByRole('button', { name: "Activate Bandit's Talent" });
  await expect(activation).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('.log .line').count();
  await activation.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await expect
    .poll(async () => (await page.locator('.log .line').count()) > before, { timeout: 15_000 })
    .toBe(true);
  await expect(
    page.locator('.log .line').filter({
      hasText: new RegExp(`Gain Class level ${level} resolves`, 'i'),
    }),
  ).toHaveCount(1);
}

test('Sejiri Glacier enters tapped, then pays for a normal Mother of Runes cast next turn', async ({
  page,
}) => {
  const title =
    'Sejiri Glacier: play the tapped land, untap it next turn, then cast Mother of Runes';
  await runScenario(page, title);

  const source = handCard(page, 'Sejiri Shelter // Sejiri Glacier');
  await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
  await source.click();

  const glacier = permanent(page, 'Sejiri Glacier');
  await expect(glacier).toBeVisible();
  await expect(glacier.getByTitle('Tapped')).toBeVisible();
  const mother = handCard(page, 'Mother of Runes');
  await expect(mother).not.toHaveClass(/actionable/);

  const castableMother = page.locator('.hand-card.actionable:not(.hand-card-leave-active)', {
    hasText: 'Mother of Runes',
  });
  await passUntil(page, castableMother);
  await expect(handCard(page, 'Plains')).toBeVisible();
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Plains', exact: true }) }),
  ).toHaveCount(0);
  await expect(mother).toHaveClass(/actionable/);

  await mother.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await passUntil(page, permanent(page, 'Mother of Runes'));

  await expect(glacier.getByTitle('Tapped')).toBeVisible();
  await expect(handCard(page, 'Plains')).toBeVisible();
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Plains', exact: true }) }),
  ).toHaveCount(0);
  await expect(page.getByText(/Lab Priority Holding Instant resolves/i)).toHaveCount(0);
});

test('Reluctant Role Model transfers all counter types from your destroyed creature', async ({
  page,
}) => {
  const title = 'Reluctant Role Model: destroy your countered creature and transfer its counters';
  await runScenario(page, title);
  await castAndResolve(page, 'Reluctant Role Model');

  const removal = handCard(page, 'Lab Role Model Destroy Spell');
  await expect(removal).toHaveClass(/actionable/, { timeout: 15_000 });
  await removal.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Role Model Countered Target').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
  await passUntil(page, page.getByText('Lab Role Model Destroy Spell resolves').first());
  await expect(permanent(page, 'Lab Role Model Countered Target')).toHaveCount(0);

  const target = page.getByRole('button', {
    name: 'Target Lab Role Model Counter Recipient',
    exact: true,
  });
  await passUntil(page, target);
  await target.click();

  const recipient = permanent(page, 'Lab Role Model Counter Recipient');
  await passUntil(page, recipient.getByText(/flying\s*[\u00d7x]1/i));
  await expect(recipient.getByText(/\+1\/\+1\s*[\u00d7x]2/i)).toBeVisible();
  await expect(recipient).toContainText(/flying/i);
  await expect(
    page.getByText(/Put the counters from the creature that died/i).first(),
  ).toBeVisible();
});

test("Bandit's Talent reaches level 3 and draws once for each low-hand opponent", async ({
  page,
}) => {
  const title = "Bandit's Talent: pay through level 3 and draw for each opponent with one card";
  await runScenario(page, title);
  await castAndResolve(page, "Bandit's Talent");
  await levelBandit(page, 2);
  await levelBandit(page, 3);

  const hand = page.locator('.human-zone .hand-card:not(.hand-card-leave-active)');
  await passUntil(page, hand.nth(3));
  await expect(hand).toHaveCount(4);
  await expect(page.locator('.log .line').filter({ hasText: 'draws Swamp' })).toHaveCount(4);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(
      page.locator(`.opponent[data-seat="${seat}"], .seat[data-seat="${seat}"]`).first(),
    ).toContainText('hand 1');
});

test('Reluctant Role Model attacks, then chooses a flying counter in the second main phase', async ({
  page,
}) => {
  const title =
    'Reluctant Role Model: attack, then choose a flying counter in your second main phase';
  await runScenario(page, title);
  await expect(permanent(page, 'Lab Role Model Haste Witness')).toBeVisible();
  await castAndResolve(page, 'Reluctant Role Model');

  const model = permanent(page, 'Reluctant Role Model');
  await expect(model).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Reluctant Role Model' })
    .getByRole('button', { name: 'P2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  const flyingChoice = page.getByRole('button', { name: /flying/i });
  await expect(flyingChoice).toBeVisible({ timeout: 20_000 });
  await flyingChoice.click();
  await expect(model).toContainText(/flying/i);
  await expect(model).toContainText(/flying×1|flying x1|flying\s*1/i);
});

test("Bandit's Talent normally casts, levels twice, and drains an empty opponent hand at upkeep", async ({
  page,
}) => {
  const title = "Bandit's Talent: normal cast, level 2 and 3, then punish an empty opponent hand";
  await runScenario(page, title);
  await castAndResolve(page, "Bandit's Talent");
  await expect(permanent(page, "Bandit's Talent")).toBeVisible();
  await expect(handCard(page, 'Lab Bandit Nonland Discard')).toHaveCount(0);
  for (const level of [2, 3]) {
    const activation = page.getByRole('button', { name: "Activate Bandit's Talent" });
    await expect(activation).toBeVisible({ timeout: 15_000 });
    const before = await page.locator('.log .line').count();
    await activation.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
    await expect
      .poll(async () => (await page.locator('.log .line').count()) > before, { timeout: 15_000 })
      .toBe(true);
    await expect(
      page.locator('.log .line').filter({
        hasText: new RegExp(`Gain Class level ${level} resolves`, 'i'),
      }),
    ).toHaveCount(1);
  }

  const p2Life = page.locator(
    '.opponent[data-seat="P2"] .life-badge, .seat[data-seat="P2"] .life-badge',
  );
  await expect(p2Life).toHaveText('38');
  await expect(page.locator('.log .line').filter({ hasText: /loses 2 life/i })).toHaveCount(1);
});
