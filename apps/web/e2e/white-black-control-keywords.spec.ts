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

async function attackP2(page: Page, attackers: string[]): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  for (const name of attackers) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
  await passUntil(page, page.getByText(/game over/i).first());
}

async function assertOtherOpponentsStayedAtForty(page: Page): Promise<void> {
  await expect(life(page, 'P3')).toHaveText('40');
  await expect(life(page, 'P4')).toHaveText('40');
}

test('Breena: flying connects, while equal opponent life prevents her attack trigger', async ({
  page,
}) => {
  const name = 'Breena, the Demagogue';
  await runScenario(page, 'Breena: flying attacker connects past a ground blocker');
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('39');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
  await expect(source).not.toContainText(/\+1\/\+1/);
  await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(0);
});

test('Archfiend of Ifnir: flying attacker deals its printed combat damage', async ({ page }) => {
  const name = 'Archfiend of Ifnir';
  await runScenario(page, 'Archfiend of Ifnir: flying attacker connects past a ground blocker');
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('35');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
});

test('Hypnotic Specter: flying attacker deals its printed combat damage', async ({ page }) => {
  const name = 'Hypnotic Specter';
  await runScenario(page, 'Hypnotic Specter: flying attacker connects past a ground blocker');
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('38');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
});

test('Aven Interrupter: flying attacker deals its printed combat damage', async ({ page }) => {
  const name = 'Aven Interrupter';
  await runScenario(page, 'Aven Interrupter: flying attacker connects past a ground blocker');
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('38');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
});

test('The Haunt of Hightower: flying connects and lifelink gains 3 life', async ({ page }) => {
  const name = 'The Haunt of Hightower';
  await runScenario(
    page,
    'The Haunt of Hightower: flying and lifelink connect past a ground blocker',
  );
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(source).toContainText(/lifelink/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('38');
  await expect(life(page, 'P2')).toHaveText('37');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
});

test('Doorkeeper Thrull: flying attacker deals its printed combat damage', async ({ page }) => {
  const name = 'Doorkeeper Thrull';
  await runScenario(page, 'Doorkeeper Thrull: flying attacker connects past a ground blocker');
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('39');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
});

test('Archon of Absolution: its protection prevents the white flyer blocking it', async ({
  page,
}) => {
  const name = 'Archon of Absolution';
  await runScenario(
    page,
    'Archon of Absolution: protection from white prevents a white flyer from blocking',
  );
  const source = permanent(page, name);
  await expect(source).toContainText(/flying/i);
  await expect(source).toContainText(/protection from white/i);
  await expect(permanent(page, 'Lab P1 Colorless Flying Witness')).toBeVisible();
  await expect(permanent(page, 'Lab P2 White Flying Blocker')).toBeVisible();

  await attackP2(page, [name, 'Lab P1 Colorless Flying Witness']);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('37');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
  await expect(permanent(page, 'Lab P1 Colorless Flying Witness')).toHaveCount(0);
  await expect(permanent(page, 'Lab P2 White Flying Blocker')).toBeVisible();
});

test('Tergrid: menace keeps a single blocker from stopping her attack', async ({ page }) => {
  const name = 'Tergrid, God of Fright';
  await runScenario(
    page,
    'Tergrid: menace prevents a single ground blocker from stopping the attack',
  );
  const source = permanent(page, name);
  await expect(source).toContainText(/menace/i);
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();

  await attackP2(page, [name]);

  await expect(life(page, 'P1')).toHaveText('35');
  await expect(life(page, 'P2')).toHaveText('36');
  await assertOtherOpponentsStayedAtForty(page);
  await expect(source).toBeVisible();
  await expect(permanent(page, 'Lab P2 Ground Blocker')).toBeVisible();
});
