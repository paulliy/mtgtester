import { expect, test, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import { BOSEIJU_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-boseiju-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const titles = [
  'Boseiju, Who Endures: channel and decline the search',
  'Boseiju, Who Endures: legendary discount and search for Forest',
  'Boseiju, Who Endures: play as a land and make green mana',
] as const;

for (const [index, id] of BOSEIJU_SCENARIO_IDS.entries()) {
  const title = titles[index]!;
  test(title, async ({ page }) => {
    await runScenario(page, title);
    if (id === BOSEIJU_SCENARIO_IDS[2]) {
      const boseijuCard = handCard(page, 'Boseiju, Who Endures');
      await expect(boseijuCard).toHaveClass(/actionable/, { timeout: 15_000 });
      await boseijuCard.click();
      const land = humanPermanent(page, 'Boseiju, Who Endures');
      await expect(land).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Land played', { exact: true })).toBeVisible();

      const spell = handCard(page, 'Lab Green Salve');
      await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
      await spell.click();
      await expect(page.getByText(/Auto-pay: Boseiju, Who Endures/)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm' }).click();
      await expect(humanPermanent(page, 'Lab Green Salve')).toHaveCount(0);
      await expect(land.locator('.tile')).toHaveClass(/tapped/);
      await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
      return;
    }
    const source = handCard(page, 'Boseiju, Who Endures');
    await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
    await source.click();
    const channel = page.getByRole('button', { name: /^Channel — destroy an opposing artifact/ });
    await expect(channel).toBeVisible();
    await channel.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    if (id === BOSEIJU_SCENARIO_IDS[1]) {
      await expect(page.getByText(/Auto-pay: Forest/)).toBeVisible();
    } else {
      await expect(page.getByText(/Auto-pay/)).toContainText('Forest');
      await expect(page.getByText(/Auto-pay/)).toContainText('Island');
    }

    const artifact = opponentPermanent(page, 'Lab P2 Artifact');
    await expect(artifact).toBeVisible();
    await artifact.click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(artifact).toHaveCount(0, { timeout: 15_000 });
    await expect(handCard(page, 'Boseiju, Who Endures')).toHaveCount(0);
    await expect(
      page.locator('.human-zone .meta-item').filter({ hasText: 'Graveyard' }),
    ).toContainText('1');
    if (id === BOSEIJU_SCENARIO_IDS[1]) {
      const forest = opponentPermanent(page, 'Forest');
      await expect(forest).toBeVisible({ timeout: 15_000 });
      await expect(forest.locator('.tile')).not.toHaveClass(/tapped/);
      await expect(
        page
          .locator('.opponent[data-seat="P2"] .opponent-zones')
          .getByRole('img', { name: 'Lab P2 Artifact', exact: true }),
      ).toHaveCount(1);
    } else {
      await expect(opponentPermanent(page, 'Forest')).toHaveCount(0);
    }
  });
}

test.afterAll(() => expectLabCoverage(exercised, BOSEIJU_SCENARIO_IDS));

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(BOSEIJU_SCENARIO_IDS).toContain(id);
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

function humanPermanent(page: Page, name: string) {
  return page.locator('.human-zone .object:not(.board-card-leave-active)').filter({
    has: page.getByRole('img', { name, exact: true }),
  });
}

function opponentPermanent(page: Page, name: string) {
  return page.locator('.opponent[data-seat="P2"] .object:not(.board-card-leave-active)').filter({
    has: page.getByRole('img', { name, exact: true }),
  });
}
