import { expect, test, type Page } from '@playwright/test';

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
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function lifeBadge(page: Page, seat: string) {
  return seat === 'P1'
    ? page.locator('.human-zone .life-badge')
    : page.locator(
        `.opponent[data-seat="${seat}"] .life-badge, .seat[data-seat="${seat}"] .life-badge`,
      );
}

async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

test("Imp's Mischief retargets an opponent's normally cast spell and loses its mana value", async ({
  page,
}) => {
  const title = "Imp's Mischief: redirect a normal single-target spell and lose its mana value";
  await runScenario(page, title);

  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab Prepared Growth Spell', { timeout: 15_000 });
  await expect(handCard(page, "Imp's Mischief")).toHaveClass(/actionable/);
  await handCard(page, "Imp's Mischief").click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await stack.getByText('Lab Prepared Growth Spell', { exact: true }).click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The viewer resolves the retarget and the original spell in the same action
  // flow once the stack target is confirmed. Assert the resulting board/life
  // state instead of waiting for a second modal that is not shown here.
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Lab Prepared Growth Spell resolves' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(lifeBadge(page, 'P1')).toHaveText('38');
  await expect(permanent(page, 'Lab P1 Redirect Target')).toContainText('3/3');
  await expect(permanent(page, 'Lab P2 Growth Target')).toContainText('2/2');
});

test('Restoration Magic casts the Cura tier and protects a chosen permanent', async ({ page }) => {
  const title = 'Restoration Magic: cast Cura to protect a permanent and gain 3 life';
  await runScenario(page, title);

  const spell = handCard(page, 'Restoration Magic');
  await expect(spell).toHaveClass(/actionable/);
  await spell.click();
  const cura = page.getByRole('button', { name: /Cura/ });
  await expect(cura).toBeVisible();
  await cura.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab P1 Cura Target').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  const target = permanent(page, 'Lab P1 Cura Target');
  await expect(target).toContainText(/hexproof/i);
  await expect(target).toContainText(/indestructible/i);
  await expect(lifeBadge(page, 'P1')).toHaveText('38');
  await expect(handCard(page, 'Restoration Magic')).toHaveCount(0);
  await expect(page.getByText(/Cura/).first()).toBeVisible();
});

test('Restoration Magic casts Cure with zero additional mana and no life gain', async ({
  page,
}) => {
  await runScenario(page, 'Restoration Magic: cast Cure for its zero additional cost');
  await handCard(page, 'Restoration Magic').click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab P1 Cura Target').click();
  await confirm(page);
  await expect(permanent(page, 'Lab P1 Cura Target')).toContainText(/indestructible/i);
  await expect(permanent(page, 'Lab P1 Cura Target')).toContainText(/hexproof/i);
  await expect(permanent(page, 'Lab P1 Redirect Target')).not.toContainText(/hexproof/i);
  await expect(lifeBadge(page, 'P1')).toHaveText('35');
  await expect(page.locator('.human-zone').getByTitle('Tapped', { exact: true })).toHaveCount(1);
});

test('Restoration Magic pays Curaga and protects all controlled permanents with 6 life gain', async ({
  page,
}) => {
  await runScenario(
    page,
    'Restoration Magic: pay Curaga to protect all your permanents and gain 6 life',
  );
  await handCard(page, 'Restoration Magic').click();
  await page.getByRole('button', { name: /Curaga/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
  await confirm(page);
  for (const name of ['Lab P1 Cura Target', 'Lab P1 Redirect Target', 'Plains']) {
    await expect(permanent(page, name)).toContainText(/hexproof/i);
    await expect(permanent(page, name)).toContainText(/indestructible/i);
  }
  await expect(lifeBadge(page, 'P1')).toHaveText('41');
  await expect(page.locator('.human-zone').getByTitle('Tapped', { exact: true })).toHaveCount(1);
  await expect(permanent(page, 'Plains')).toContainText('×5');
});
