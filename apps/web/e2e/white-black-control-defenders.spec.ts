import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
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

async function castAndResolve(page: Page, name: string): Promise<void> {
  const before = await page.getByText(`${name} resolves`).count();
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect
    .poll(async () => (await page.getByText(`${name} resolves`).count()) > before, {
      timeout: 15_000,
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
      { timeout: 25_000 },
    )
    .toBe(true);
}

async function attackWithOneCreature(
  page: Page,
  attacker: string,
  defender: string,
): Promise<void> {
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 20_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: attacker })
    .getByRole('button', { name: defender, exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
}

test('Archon of Absolution taxes a real attack against your planeswalker', async ({ page }) => {
  const title = 'Archon of Absolution: P2 pays the attack tax to attack your planeswalker';
  await runScenario(page, title);
  await castAndResolve(page, 'Archon of Absolution');
  await expect(permanent(page, 'Archon of Absolution')).toBeVisible();
  const walker = permanent(page, 'Lab P1 Planeswalker Defender');
  const attackingCreature = permanent(page, 'Lab P2 Attacking Creature');
  await expect(attackingCreature).toBeVisible();
  await passUntil(page, attackingCreature.locator('.tap-badge'));
  await expect(attackingCreature.locator('.tap-badge')).toHaveText('TAP');
  const p2Swamps = page
    .locator('.opponent[data-seat="P2"] .object')
    .filter({ has: page.getByRole('img', { name: 'Swamp', exact: true }) });
  await expect(p2Swamps.locator('.tap-badge')).toHaveCount(1);
  await page.getByRole('button', { name: 'No block', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm blocks' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, walker.getByText('loyalty×1', { exact: true }));
  await expect(walker).toContainText('1');
});

test('Soul Snare uses its normal activation to exile an attacker before planeswalker damage', async ({
  page,
}) => {
  const title = 'Soul Snare: pay {W} and sacrifice it to exile a planeswalker attacker';
  await runScenario(page, title);
  await castAndResolve(page, 'Soul Snare');
  await expect(permanent(page, 'Soul Snare')).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: /Activate Soul Snare/ }));
  await page.getByRole('button', { name: /Activate Soul Snare/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab P2 Attacking Creature').click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect(permanent(page, 'Soul Snare')).toHaveCount(0);
  await expect(permanent(page, 'Lab P2 Attacking Creature')).toHaveCount(0);
  await expect(
    page
      .locator('.zones-strip .zone')
      .filter({ hasText: 'Exile' })
      .getByRole('img', { name: 'Lab P2 Attacking Creature', exact: true }),
  ).toBeVisible();
  await expect(permanent(page, 'Lab P1 Planeswalker Defender')).toContainText('4');
  await expect(page.getByText(/Soul Snare.*sacrifices|Soul Snare.*exiles/i).first()).toBeVisible();
});

test('The Haunt of Hightower casts normally, attacks, and makes the planeswalker defender discard', async ({
  page,
}) => {
  const title = 'The Haunt of Hightower: its attack makes the planeswalker defender discard';
  await runScenario(page, title);
  await expect(permanent(page, 'Lab Haste Witness')).toBeVisible();
  await castAndResolve(page, 'The Haunt of Hightower');
  const haunt = permanent(page, 'The Haunt of Hightower');
  await expect(haunt).toBeVisible();
  await expect(haunt).toContainText(/flying/i);
  await expect(haunt).toContainText(/lifelink/i);
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await attackWithOneCreature(page, 'The Haunt of Hightower', 'Lab P2 Planeswalker Defender');

  await expect(page.getByText(/P2.*discards|discard.*P2/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(handCard(page, 'Plains')).toHaveCount(0);
  await expect(haunt).toContainText(/\+1\/\+1/);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const gameOver = page.getByText(/game over/i).first();
  await expect
    .poll(
      async () => {
        if (await gameOver.isVisible()) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(permanent(page, 'Lab P2 Planeswalker Defender')).toHaveCount(0);
});
