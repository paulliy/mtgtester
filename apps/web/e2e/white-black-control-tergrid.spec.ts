import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'default' });
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

function ownPermanent(page: Page, name: string) {
  return page
    .locator('.human-zone')
    .locator('.object:not(.board-card-leave-active)')
    .filter({
      has: page.getByRole('img', { name, exact: true }),
    });
}

function opponent(page: Page, seat: string) {
  return page.locator(`.opponent[data-seat="${seat}"], .seat[data-seat="${seat}"]`).first();
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

async function castFrontTergrid(page: Page): Promise<void> {
  const source = handCard(page, 'Tergrid, God of Fright');
  await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
  await source.click();
  const frontCast = page.getByRole('button', { name: 'Cast {3}{B}{B}', exact: true });
  await expect(frontCast).toBeVisible();
  await frontCast.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await resolveCast(page, 'Tergrid, God of Fright');
  await expect(permanent(page, 'Tergrid, God of Fright')).toBeVisible();
}

async function resolveCast(page: Page, name: string): Promise<void> {
  const resolved = page.locator('.log .line').filter({ hasText: `${name} resolves` });
  await expect(resolved).toBeVisible({ timeout: 20_000 });
}

async function castTargetingOpponent(page: Page, name: string): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await opponent(page, 'P2').locator('> header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function acceptTergridTrigger(page: Page, triggerText: RegExp): Promise<void> {
  await passUntil(page, page.getByText(triggerText).first());
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
}

test('Tergrid returns P2’s real permanent card discarded by a normal Duress cast', async ({
  page,
}) => {
  const title = 'Tergrid: normal front-face cast returns a permanent discarded by Duress';
  await runScenario(page, title);
  await castFrontTergrid(page);
  await castTargetingOpponent(page, 'Duress');

  await acceptTergridTrigger(
    page,
    /Put the discarded permanent card from a graveyard onto the battlefield under your control.*use this ability/i,
  );
  await expect(permanent(page, 'Sol Ring')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/discards Sol Ring/i).first()).toBeVisible();
});

test('Tergrid returns P2’s creature sacrificed by a normal Liliana of the Veil activation', async ({
  page,
}) => {
  const title = 'Tergrid: P2 sacrifices a creature to Liliana and Tergrid may return it';
  await runScenario(page, title);
  await acceptTergridTrigger(
    page,
    /Put the sacrificed card from a graveyard onto the battlefield under your control.*use this ability/i,
  );
  await expect(ownPermanent(page, 'Mother of Runes')).toBeVisible({ timeout: 15_000 });
  await expect(
    opponent(page, 'P2').getByRole('img', { name: 'Mother of Runes', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.log .line').filter({ hasText: 'Liliana of the Veil' }).first(),
  ).toBeVisible();
  await expect(permanent(page, 'Liliana of the Veil')).toBeVisible();
});

test("Tergrid's Lantern resolves P2's discard choice, then pays {3}{B} to untap", async ({
  page,
}) => {
  const title = "Tergrid's Lantern: P2 discards, then pay {3}{B} to untap it";
  await runScenario(page, title);
  const source = handCard(page, 'Tergrid, God of Fright');
  await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
  await source.click();
  const backCast = page.getByRole('button', {
    name: /Play Tergrid, God of Fright.*Tergrid's Lantern/,
  });
  await expect(backCast).toBeVisible();
  await backCast.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await resolveCast(page, "Tergrid's Lantern");

  const lantern = permanent(page, "Tergrid's Lantern");
  await expect(lantern).toBeVisible();
  await expect(
    page.getByRole('button', { name: "Activate Tergrid's Lantern", exact: true }),
  ).toBeVisible();
  await lantern.click();
  const tapChoice = page.getByRole('button', {
    name: /Target player loses 3 life unless they sacrifice a nonland permanent or discard a card/,
  });
  const targetPrompt = page.getByText(/Target 1 of 1/);
  await expect
    .poll(async () => (await tapChoice.isVisible()) || (await targetPrompt.isVisible()))
    .toBe(true);
  if (await tapChoice.isVisible()) await tapChoice.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await opponent(page, 'P2').locator('> header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await passUntil(page, page.getByText(/discards Swamp/i).first());
  await expect(opponent(page, 'P2')).toContainText('hand 0');
  await expect(opponent(page, 'P2').locator('.life-badge')).toHaveText('40');
  await expect(lantern.getByTitle('Tapped', { exact: true })).toBeVisible();

  await lantern.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await passUntil(page, page.getByText("Untap Tergrid's Lantern resolves").first());
  await expect(lantern.getByTitle('Tapped', { exact: true })).toHaveCount(0);
});
