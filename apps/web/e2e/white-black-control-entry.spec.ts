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

function lifeBadge(page: Page, seat: string) {
  if (seat === 'P1') return page.locator('.human-zone .life-badge');
  return page.locator(
    `.opponent[data-seat="${seat}"] .life-badge, .seat[data-seat="${seat}"] .life-badge`,
  );
}

async function playLand(page: Page, name: string): Promise<void> {
  const land = handCard(page, name);
  await expect(land).toHaveClass(/actionable/, { timeout: 15_000 });
  await land.click();
  await expect(permanent(page, name)).toBeVisible({ timeout: 15_000 });
}

test('Authority of the Consuls casts normally and distinguishes own from opposing creature entry', async ({
  page,
}) => {
  await runScenario(page, 'Authority of the Consuls: opponents enter tapped and gain life');
  await castAndResolve(page, 'Authority of the Consuls');
  await expect(permanent(page, 'Authority of the Consuls')).toBeVisible();

  const opponentCreature = permanent(page, 'Lab Opponent Creature');
  await passUntil(page, opponentCreature);
  const opponentBasicLand = permanent(page, 'Lab Opponent Basic Land');
  await expect(opponentBasicLand).toBeVisible();
  await expect(opponentBasicLand.locator('.tap-badge')).toHaveCount(0);
  await expect(opponentCreature.locator('.tap-badge')).toHaveText('TAP');
  await expect(lifeBadge(page, 'P1')).toHaveText('41');
});

test('Archon of Emeria casts normally and taps only the opponent nonbasic land', async ({
  page,
}) => {
  await runScenario(page, 'Archon of Emeria: opponents’ nonbasic land enters tapped');
  await castAndResolve(page, 'Archon of Emeria');
  const archon = permanent(page, 'Archon of Emeria');
  await expect(archon).toBeVisible();
  await expect(archon).toContainText(/flying/i);

  await playLand(page, 'Lab Own Basic Land');
  await expect(permanent(page, 'Lab Own Basic Land').locator('.tap-badge')).toHaveCount(0);

  const opponentLand = permanent(page, 'Lab Opponent Nonbasic Land');
  await passUntil(page, opponentLand);
  await expect(opponentLand.locator('.tap-badge')).toHaveText('TAP');
});

test('Doorkeeper Thrull casts normally and suppresses an artifact creature trigger', async ({
  page,
}) => {
  await runScenario(page, 'Doorkeeper Thrull: artifact creature entry trigger is suppressed');
  await expect(permanent(page, 'Authority of the Consuls')).toBeVisible();
  await castAndResolve(page, 'Doorkeeper Thrull');
  const thrull = permanent(page, 'Doorkeeper Thrull');
  await expect(thrull).toBeVisible();
  await expect(thrull).toContainText(/flying/i);

  const witness = permanent(page, 'Lab Opponent Artifact Creature');
  await passUntil(page, witness);
  await expect(witness.locator('.tap-badge')).toHaveText('TAP');
  await expect(lifeBadge(page, 'P1')).toHaveText('40');
});

test('Doorkeeper Thrull normally casts on an opponent turn and suppresses the incoming entry trigger', async ({
  page,
}) => {
  await runScenario(page, 'Doorkeeper Thrull: flash in before an opposing creature enters');
  await expect(page.locator('.stack')).toContainText('Lab Opponent Artifact Creature');
  await expect(page.locator('.turn-badge')).toContainText('P2');
  await castAndResolve(page, 'Doorkeeper Thrull');
  await expect(permanent(page, 'Doorkeeper Thrull')).toBeVisible();
  await expect(permanent(page, 'Lab Opponent Artifact Creature')).toBeVisible();
  await expect(lifeBadge(page, 'P1')).toHaveText('40');
  await expect(page.locator('.log .line').filter({ hasText: 'gains 1 life' })).toHaveCount(0);
});

test('Hushbringer casts normally, retains flying and lifelink, and suppresses creature entry triggers', async ({
  page,
}) => {
  await runScenario(page, 'Hushbringer: creature entry trigger is suppressed');
  await expect(permanent(page, 'Authority of the Consuls')).toBeVisible();
  await castAndResolve(page, 'Hushbringer');
  const hushbringer = permanent(page, 'Hushbringer');
  await expect(hushbringer).toBeVisible();
  await expect(hushbringer).toContainText(/flying/i);
  await expect(hushbringer).toContainText(/lifelink/i);

  const witness = permanent(page, 'Lab Opponent Artifact Creature');
  await passUntil(page, witness);
  await expect(witness.locator('.tap-badge')).toHaveText('TAP');
  await expect(lifeBadge(page, 'P1')).toHaveText('40');
});

test('Karn, Argent Defender casts normally and suppresses artifact creature triggers', async ({
  page,
}) => {
  await runScenario(page, 'Karn, Argent Defender: artifact creature entry trigger is suppressed');
  await expect(permanent(page, 'Authority of the Consuls')).toBeVisible();
  await castAndResolve(page, 'Karn, Argent Defender');
  const karn = permanent(page, 'Karn, Argent Defender');
  await expect(karn).toBeVisible();
  await expect(karn).toContainText('1/3');

  const witness = permanent(page, 'Lab Opponent Artifact Creature');
  await passUntil(page, witness);
  await expect(witness.locator('.tap-badge')).toHaveText('TAP');
  await expect(lifeBadge(page, 'P1')).toHaveText('40');
});
