import { expect, test, type Locator, type Page } from '@playwright/test';
import { PR08_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-scenario-catalog';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
test.afterAll(() => expect([...exercised].sort()).toEqual([...PR08_SCENARIO_IDS].sort()));

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(PR08_SCENARIO_IDS).toContain(id);
  expect(exercised.has(id), `${id} was run more than once`).toBe(false);
  exercised.add(id);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}
async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm' }).click();
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
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function passStackUntil(page: Page, target: Locator): Promise<void> {
  const empty = page.getByText('empty', { exact: true });
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if ((await empty.count()) === 0 && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

for (const mode of ['large', 'small', 'cleanup'] as const) {
  test(`Mob Rule: ${mode === 'cleanup' ? 'temporary control ends at cleanup' : mode === 'large' ? 'steal power 4 or greater' : 'steal power 3 or less'}`, async ({
    page,
  }) => {
    const title = `Mob Rule: ${mode === 'cleanup' ? 'temporary control ends at cleanup' : mode === 'large' ? 'steal power 4 or greater' : 'steal power 3 or less'}`;
    await runScenario(page, title);
    await expect(handCard(page, 'Mob Rule')).toHaveClass(/actionable/);
    await handCard(page, 'Mob Rule').click();
    await page
      .getByRole('button', {
        name:
          mode === 'small'
            ? /Gain control of creatures with power 3 or less/
            : /Gain control of creatures with power 4 or greater/,
      })
      .click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
    const name = mode === 'small' ? 'Lab Servo' : 'Lab Ox';
    const other = mode === 'small' ? 'Lab Ox' : 'Lab Servo';
    const chosen = page
      .locator('.human-zone .tile')
      .filter({ has: page.getByRole('img', { name, exact: true }) });
    await passStackUntil(page, chosen.nth(1));
    await expect(chosen).toHaveCount(2);
    await expect(chosen.locator('.tap-badge')).toHaveCount(0);
    await expect(chosen.locator('.keywords[title*="haste"]')).toHaveCount(2);
    await expect(
      page.locator('.opponent[data-seat="P2"]').getByRole('img', { name, exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .locator('.opponent[data-seat="P2"] .tile')
        .filter({ has: page.getByRole('img', { name: other, exact: true }) }),
    ).toHaveClass(/tapped/);
    await expect(handCard(page, 'Lab Priority Witness')).toBeVisible();
    await passUntil(page, page.getByText(/game over/i).first());
    if (mode === 'cleanup') {
      await expect(
        page.locator('.opponent[data-seat="P2"]').getByRole('img', { name: 'Lab Ox', exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.human-zone').getByRole('img', { name: 'Lab Ox', exact: true }),
      ).toHaveCount(1);
      await expect(page.locator('.human-zone .keywords[title*="haste"]')).toHaveCount(0);
    }
  });
}
