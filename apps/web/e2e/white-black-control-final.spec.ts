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
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
}

async function castGiftSpell(page: Page, cardName: string, giftLabel: RegExp): Promise<void> {
  const spell = handCard(page, cardName);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  const giftChoice = page.getByRole('button', { name: giftLabel });
  await expect(giftChoice).toBeVisible();
  await giftChoice.click();
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
      { timeout: 60_000 },
    )
    .toBe(true);
}

test('Aven Interrupter lets P2 cast the plotted spell later and pay the exile tax', async ({ page }) => {
  await runScenario(page, 'Aven Interrupter: cast the plotted spell later and pay the exile tax');
  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab Opposing Instant', { timeout: 15_000 });
  await castNormally(page, 'Aven Interrupter');

  const p2 = opponent(page, 'P2');
  await expect(p2.getByRole('img', { name: 'Lab Opposing Instant', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(stack).not.toContainText('Lab Opposing Instant');
  await expect(page.getByText(/Aven Interrupter.*Exile target spell/i)).toBeVisible();

  await passUntil(page, page.getByText('Lab Opposing Instant resolves', { exact: false }).first());
  await expect(page.getByText(/Cast Lab Opposing Instant \(\{2\}\) from exile/i).first()).toBeVisible();
  await expect(p2.getByText('2 in hand')).toBeVisible();
  await expect(p2.getByRole('heading', { name: /^Exile/ })).toHaveCount(0);
  await expect(p2.getByRole('heading', { name: 'Graveyard (1)', exact: true })).toBeVisible();
  const tappedSwamps = p2.locator('.tile.tapped', {
    has: page.getByRole('img', { name: 'Swamp', exact: true }),
  });
  await expect(tappedSwamps).toHaveCount(1);
  await expect(tappedSwamps.locator('.stack-count-badge')).toHaveText('×2');
});

test('Aven Interrupter is cast in response and exiles the normal opposing spell', async ({ page }) => {
  await runScenario(page, 'Aven Interrupter: flash in to exile the opposing spell');
  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab Opposing Instant', { timeout: 15_000 });
  await castNormally(page, 'Aven Interrupter');

  await expect(opponent(page, 'P2').getByRole('img', { name: 'Lab Opposing Instant' })).toBeVisible({ timeout: 15_000 });
  await expect(stack).not.toContainText('Lab Opposing Instant');
  await expect(page.getByText(/Aven Interrupter.*Exile target spell/i)).toBeVisible();
});

test("Tergrid's Lantern is cast from the back face and makes P2 lose 3 life with no alternative", async ({ page }) => {
  await runScenario(page, "Tergrid's Lantern: activate against a player with no discard or sacrifice choice");
  const source = handCard(page, 'Tergrid, God of Fright');
  await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
  await source.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  const lantern = permanent(page, "Tergrid's Lantern");
  await expect(lantern).toBeVisible({ timeout: 15_000 });
  await lantern.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await opponent(page, 'P2').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(opponent(page, 'P2').getByText('37')).toBeVisible({ timeout: 15_000 });
});

test("Bilbo's Gambit gifts P3 a Treasure and returns P2's spell", async ({ page }) => {
  await runScenario(page, "Bilbo's Gambit: gift a Treasure and return a spell to its owner's hand");
  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab Opposing Instant', { timeout: 15_000 });
  const spell = handCard(page, "Bilbo's Gambit");
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await stack.getByText('Lab Opposing Instant', { exact: true }).click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  const giftChoice = page.getByRole('button', { name: /Promise P3 a gift \(treasure\)/i });
  await expect(giftChoice).toBeVisible();
  await giftChoice.click();

  await expect(page.getByRole('img', { name: /Treasure/i })).toBeVisible({ timeout: 15_000 });
  await expect(stack).not.toContainText('Lab Opposing Instant');
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
});

test("Dawn's Truce gifts P2 a card before granting visible protection", async ({ page }) => {
  await runScenario(page, "Dawn's Truce: gift a card for hexproof and indestructible");
  await castGiftSpell(page, "Dawn's Truce", /promise.*P2|P2.*promise/i);

  const creature = permanent(page, 'Lab Visible P1 Creature');
  await expect(creature).toContainText(/hexproof/i);
  await expect(creature).toContainText(/indestructible/i);
  await expect(opponent(page, 'P2')).toContainText('1 in hand');
});
