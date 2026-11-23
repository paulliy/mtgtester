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
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

async function castTargetAndResolve(page: Page, name: string, target: Locator): Promise<void> {
  const before = await page.getByText(`${name} resolves`).count();
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Target 1 of 1: click a highlighted card or player\./)).toBeVisible();
  await target.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await passUntil(page, page.getByText(`${name} resolves`).first());
  expect(await page.getByText(`${name} resolves`).count()).toBeGreaterThan(before);
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
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function attack(page: Page, names: string[]): Promise<void> {
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 20_000 });
  await expect(page.getByText(/Click a creature, then its opponent or target/)).toBeVisible();
  for (const name of names) {
    await permanent(page, name).click();
    await page.locator('.opponent[data-seat="P2"], .seat[data-seat="P2"]').click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
}

async function castAndWaitForChoice(page: Page, name: string, prompt: string): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await passUntil(page, page.getByText(prompt, { exact: true }));
}

test('Curse of Disturbance: two attackers on P2 create one controller Zombie', async ({ page }) => {
  const title = 'Curse of Disturbance: two attackers on P2 create one controller Zombie';
  await runScenario(page, title);
  await castTargetAndResolve(
    page,
    'Curse of Disturbance',
    page.locator('.opponent[data-seat="P2"], .seat[data-seat="P2"]'),
  );

  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await attack(page, ['Mother of Runes', 'Archon of Absolution']);
  await expect
    .poll(async () => await page.getByRole('img', { name: /Zombie/i }).count(), { timeout: 15_000 })
    .toBe(1);
  await expect(
    page.locator('.log .line').filter({ hasText: /Curse of Disturbance.*Create a Zombie/i }),
  ).toBeVisible();
});

test('Promise of Loyalty: each creature player keeps one and gets a public vow counter', async ({
  page,
}) => {
  const title = 'Promise of Loyalty: each creature player keeps one and gets a public vow counter';
  await runScenario(page, title);
  await castAndWaitForChoice(
    page,
    'Promise of Loyalty',
    'Choose a creature to keep and put a vow counter on.',
  );
  await page
    .locator('.panel-group')
    .filter({ has: page.getByRole('img', { name: 'Mother of Runes', exact: true }) })
    .getByRole('button', { name: 'Keep', exact: true })
    .click();

  // The scripted opponents choose Mother of Runes as their keep in APNAP order. All four
  // survivors and their vow counters are public on the projected battlefield.
  for (const seat of ['P1', 'P2', 'P3', 'P4']) {
    const kept =
      seat === 'P1' ? page.locator('.human-zone') : page.locator(`.opponent[data-seat="${seat}"]`);
    await expect(kept.getByRole('img', { name: 'Mother of Runes', exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(kept.locator('.counters').filter({ hasText: /vow/i })).toBeVisible();
    await expect(
      kept
        .locator('.object')
        .filter({ has: page.getByRole('img', { name: 'Archon of Absolution', exact: true }) }),
    ).toHaveCount(0);
  }
});

test('Cloak of Confusion: accept no damage and make P2 discard at random', async ({ page }) => {
  const title = 'Cloak of Confusion: accept no combat damage to make P2 discard at random';
  await runScenario(page, title);
  await castTargetAndResolve(page, 'Cloak of Confusion', permanent(page, 'Mother of Runes'));
  await expect(permanent(page, 'Cloak of Confusion')).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await attack(page, ['Mother of Runes']);

  const noDamageChoice = page.getByRole('button', {
    name: /Assign no combat damage; defending player discards at random/i,
  });
  await expect(noDamageChoice).toBeVisible({
    timeout: 15_000,
  });
  await noDamageChoice.click();
  const p2Life = page.locator(
    '.opponent[data-seat="P2"] .life-badge, .seat[data-seat="P2"] .life-badge',
  );
  await expect(p2Life).toHaveText('40');
  const p2 = page.locator('.opponent[data-seat="P2"], .seat[data-seat="P2"]');
  await expect(p2.getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(p2).toContainText('hand 2');
  await expect(page.getByText(/discards (Plains|Swamp|Sol Ring)/i).first()).toBeVisible();
});
