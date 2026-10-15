import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

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

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function opponent(page: Page, seat: string) {
  return page.locator(`.opponent[data-seat="${seat}"], .seat[data-seat="${seat}"]`).first();
}

async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function castNormally(page: Page, name: string): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await confirm(page);
  await passUntil(page, permanent(page, name));
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
      { timeout: 75_000 },
    )
    .toBe(true);
}

test('Rule of Law blocks each player after one spell but allows a land and activation', async ({
  page,
}) => {
  await runScenario(page, 'Rule of Law: cast one spell, play a land, and activate Mother of Runes');
  await castNormally(page, 'Rule of Law');
  await expect(page.getByText('Rule of Law resolves', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await expect(handCard(page, 'Lab P1 Free Creature')).not.toHaveClass(/actionable/);
  await expect(handCard(page, 'Lab P1 Free Instant')).not.toHaveClass(/actionable/);

  const plains = handCard(page, 'Plains');
  await expect(plains).toHaveClass(/actionable/);
  await plains.click();
  await expect(plains).toHaveCount(0);

  const mother = permanent(page, 'Mother of Runes');
  await mother.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await mother.click();
  await confirm(page);
  await passUntil(page, page.getByRole('button', { name: 'Protection from G', exact: true }));
  await page.getByRole('button', { name: 'Protection from G', exact: true }).click();
  await expect(mother.getByTitle('Tapped', { exact: true })).toBeVisible();

  await passUntil(page, page.locator('.turn-badge').filter({ hasText: 'Turn 3' }));
  await expect(
    page.locator('.log .line').filter({ hasText: 'Lab P2 First Spell resolves' }),
  ).toBeVisible();
  const p2 = opponent(page, 'P2');
  await expect(p2).toContainText('2 in hand');
  await expect(p2.getByRole('heading', { name: 'Graveyard (1)', exact: true })).toBeVisible();
  await expect(p2.getByRole('img', { name: 'Lab P2 First Spell', exact: true })).toBeVisible();
});

test('Deafening Silence blocks a second noncreature spell and allows a creature spell', async ({
  page,
}) => {
  await runScenario(
    page,
    'Deafening Silence: block a second noncreature spell and allow a creature',
  );
  await castNormally(page, 'Deafening Silence');
  await expect(page.getByText('Deafening Silence resolves', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await expect(handCard(page, 'Lab P1 Free Instant')).not.toHaveClass(/actionable/);
  const creatureSpell = handCard(page, 'Lab P1 Free Creature');
  await expect(creatureSpell).toHaveClass(/actionable/);
  await castNormally(page, 'Lab P1 Free Creature');
  await passUntil(page, permanent(page, 'Lab P1 Free Creature'));

  await expect(permanent(page, 'Lab P1 Free Creature')).toBeVisible();
  await expect(handCard(page, 'Lab P1 Free Instant')).not.toHaveClass(/actionable/);
});

test('Archon of Emeria limits both players to one spell while allowing a land', async ({
  page,
}) => {
  await runScenario(page, 'Archon of Emeria: each player may cast only one spell each turn');
  await castNormally(page, 'Archon of Emeria');
  await expect(handCard(page, 'Lab P1 Free Creature')).not.toHaveClass(/actionable/);
  await expect(handCard(page, 'Lab P1 Free Instant')).not.toHaveClass(/actionable/);
  await expect(handCard(page, 'Plains')).toHaveClass(/actionable/);
  await handCard(page, 'Plains').click();
  await expect(handCard(page, 'Plains')).toHaveCount(0);
  await passUntil(page, page.locator('.turn-badge').filter({ hasText: 'Turn 3' }));
  await expect(
    page.locator('.log .line').filter({ hasText: 'Lab P2 First Spell resolves' }),
  ).toBeVisible();
  await expect(opponent(page, 'P2')).toContainText('2 in hand');
  await expect(
    opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.log .line').filter({ hasText: 'Lab P2 Second Spell resolves' }),
  ).toHaveCount(0);
});
