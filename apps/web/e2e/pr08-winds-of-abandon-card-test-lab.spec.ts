import { expect, test, type Page } from '@playwright/test';
import { WINDS_OF_ABANDON_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-winds-of-abandon-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const titles = [
  'Winds of Abandon: exile a target and search for a tapped basic',
  'Winds of Abandon: overload and each opponent searches',
] as const;

for (const [index, id] of WINDS_OF_ABANDON_SCENARIO_IDS.entries()) {
  const title = titles[index]!;
  test(title, async ({ page }) => {
    await runScenario(page, title);
    const source = handCard(page, 'Winds of Abandon');
    await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
    await source.click();
    const overload = id === WINDS_OF_ABANDON_SCENARIO_IDS[1];
    if (overload) {
      const overloadAction = page
        .locator('.source-actions .source-action-row button')
        .filter({ hasText: /overload/i });
      await expect(page.locator('.source-actions .source-action-row button')).toHaveCount(2);
      await overloadAction.click();
    }
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    if (overload) {
      await expect(page.getByText(/Auto-pay: Plains ×2, Forest ×4/)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm' }).click();
      await expect(opponentPermanent(page, 'Lab P2 Creature')).toHaveCount(0, { timeout: 15_000 });
      await expect(opponentPermanent(page, 'Lab P3 Creature')).toHaveCount(0, { timeout: 15_000 });
      await expect(humanPermanent(page, 'Lab P1 Creature')).toBeVisible();
      await expect(tappedOpponentLand(page, 'Plains')).toHaveCount(1, { timeout: 15_000 });
      await expect(tappedOpponentLand(page, 'Forest', 'P3')).toHaveCount(1, { timeout: 15_000 });
      await expect(opponentZoneImage(page, 'Lab P2 Creature', 'Exile', 'P2')).toHaveCount(1);
      await expect(opponentZoneImage(page, 'Lab P3 Creature', 'Exile', 'P3')).toHaveCount(1);
    } else {
      await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
      await opponentPermanent(page, 'Lab P2 Creature').click();
      await expect(page.getByText(/All 1 target selected/)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm' }).click();
      await expect(opponentPermanent(page, 'Lab P2 Creature')).toHaveCount(0, { timeout: 15_000 });
      await expect(tappedOpponentLand(page, 'Plains')).toHaveCount(1, { timeout: 15_000 });
      await expect(opponentZoneImage(page, 'Lab P2 Creature', 'Exile', 'P2')).toHaveCount(1);
    }
  });
}

test.afterAll(() =>
  expect([...exercised].sort()).toEqual([...WINDS_OF_ABANDON_SCENARIO_IDS].sort()),
);

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(WINDS_OF_ABANDON_SCENARIO_IDS).toContain(id);
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

function opponentPermanent(page: Page, name: string, seat = 'P2') {
  return page
    .locator(`.opponent[data-seat="${seat}"] .object:not(.board-card-leave-active)`)
    .filter({
      has: page.getByRole('img', { name, exact: true }),
    });
}

function humanPermanent(page: Page, name: string) {
  return page.locator('.human-zone .object:not(.board-card-leave-active)').filter({
    has: page.getByRole('img', { name, exact: true }),
  });
}

function tappedOpponentLand(page: Page, name: string, seat = 'P2') {
  return opponentPermanent(page, name, seat).filter({ has: page.locator('.tile.tapped') });
}

function opponentZoneImage(page: Page, name: string, zone: 'Exile' | 'Graveyard', seat: string) {
  return page
    .locator(`.opponent[data-seat="${seat}"] .opponent-zones`)
    .locator('.zone')
    .filter({ has: page.getByText(new RegExp(`^${zone} \\(`)) })
    .getByRole('img', { name, exact: true });
}
