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

function opponent(page: Page, seat: string) {
  return page.locator(`.opponent[data-seat="${seat}"]`);
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

test('Library of Leng keeps the normal eight-card hand through cleanup', async ({ page }) => {
  const title = 'Library of Leng: keep eight cards through production cleanup';
  await runScenario(page, title);
  // Player options live in the Settings menu in the top bar.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Land drop reminder').uncheck();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const library = handCard(page, 'Library of Leng');
  await expect(library).toHaveClass(/actionable/, { timeout: 15_000 });
  await library.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect(permanent(page, 'Library of Leng')).toBeVisible({ timeout: 15_000 });
  await passUntil(page, opponent(page, 'P2').getByText(/23 in library/));
  await expect(
    page.locator('.hand-card:not(.hand-card-leave-active)').filter({ hasText: 'Swamp' }),
  ).toHaveCount(8, {
    timeout: 20_000,
  });
  await expect(opponent(page, 'P2')).toContainText('23 in library');
});

test('Tinybones pays its six-mana activation and affects each opponent by hand count', async ({
  page,
}) => {
  const title = 'Tinybones: pay {4}{B}{B} and make empty-handed opponents lose 10 life';
  await runScenario(page, title);

  const tinybonesCard = handCard(page, 'Tinybones, Trinket Thief');
  await expect(tinybonesCard).toHaveClass(/actionable/, { timeout: 15_000 });
  await tinybonesCard.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const tinybonesPermanent = permanent(page, 'Tinybones, Trinket Thief');
  await expect(tinybonesPermanent).toBeVisible({ timeout: 15_000 });

  await expect(opponent(page, 'P2')).toContainText('0 in hand');
  await expect(opponent(page, 'P3')).toContainText('1 in hand');
  await expect(opponent(page, 'P4')).toContainText('0 in hand');

  await expect(tinybonesPermanent).toHaveClass(/actionable/, { timeout: 15_000 });
  await tinybonesPermanent.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect(opponent(page, 'P2').locator('.life-badge')).toHaveText('30', { timeout: 15_000 });
  await expect(opponent(page, 'P3').locator('.life-badge')).toHaveText('40');
  await expect(opponent(page, 'P4').locator('.life-badge')).toHaveText('30');
  await expect(opponent(page, 'P3')).toContainText('1 in hand');
});
