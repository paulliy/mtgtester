import { expect, test, type Page } from '@playwright/test';
import { PR08_MODAL_PLAYER_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-modal-player-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const exercised = new Set<string>();
const titles = [
  'Shadrix Silverquill: choose two combat modes for different players',
  'Shadrix Silverquill: decline the beginning-of-combat modes',
  'Vindictive Lich: remove it, then choose two distinct opponents',
  'Vindictive Lich: all three modes target different opponents',
] as const;

for (const [index, id] of PR08_MODAL_PLAYER_SCENARIO_IDS.entries()) {
  const title = titles[index]!;
  test(title, async ({ page }) => {
    const shadrix = id.startsWith('shadrix-');
    const declined = id === PR08_MODAL_PLAYER_SCENARIO_IDS[1];
    const lichThree = id === PR08_MODAL_PLAYER_SCENARIO_IDS[3];
    await runScenario(page, title);
    await castNormally(page, shadrix ? 'Shadrix Silverquill' : 'Vindictive Lich', shadrix);
    if (shadrix) {
      await waitForDecision(page, /Shadrix Silverquill: choose modes/i);
      if (declined) {
        await page.getByRole('button', { name: 'Choose no modes', exact: true }).click();
        await expect(humanPermanent(page, 'Shadrix Silverquill')).toBeVisible();
        await expect(opponentPermanent(page, /Inkling/, 'P2')).toHaveCount(0);
        await expect(opponent(page, 'P3').locator('.life-badge')).toHaveText('40');
      } else {
        const pair = page.getByRole('button').filter({
          hasText: /Target player creates an Inkling.*Target player draws a card and loses 1 life/,
        });
        await expect(pair).toBeVisible();
        await pair.click();
        await chooseTargetPlayer(page, 'P2');
        await chooseTargetPlayer(page, 'P3');
        await expect(humanPermanent(page, 'Shadrix Silverquill')).toBeVisible();
        await expect(opponentPermanent(page, /Inkling/, 'P2')).toHaveCount(1);
        await expect(opponent(page, 'P3').locator('.life-badge')).toHaveText('39');
      }
    } else {
      await waitForDecision(page, /Vindictive Lich: choose modes/i);
      if (lichThree) {
        const trio = page.getByRole('button').filter({
          hasText:
            /Target opponent sacrifices a creature.*Target opponent discards two cards.*Target opponent loses 5 life/,
        });
        await expect(trio).toBeVisible();
        await trio.click();
        await chooseTargetPlayer(page, 'P2');
        await chooseTargetPlayer(page, 'P3');
        await expect(opponentPermanent(page, 'Lab P2 Sacrifice Creature', 'P2')).toHaveCount(0);
        await expect(opponent(page, 'P3').locator('.opp-meta')).toContainText('0 in hand');
        await expect(opponent(page, 'P4').locator('.life-badge')).toHaveText('35');
      } else {
        const pair = page.getByRole('button').filter({
          hasText: /^Target opponent discards two cards; Target opponent loses 5 life$/,
        });
        await expect(pair).toBeVisible();
        await pair.click();
        await chooseTargetPlayer(page, 'P2');
        await chooseTargetPlayer(page, 'P3');
        await expect(opponent(page, 'P2').locator('.opp-meta')).toContainText('0 in hand');
        await expect(opponent(page, 'P3').locator('.life-badge')).toHaveText('35');
      }
      await expect(humanZoneImage(page, 'Vindictive Lich', 'Graveyard')).toHaveCount(1);
    }
  });
}

test.afterAll(() =>
  expect([...exercised].sort()).toEqual([...PR08_MODAL_PLAYER_SCENARIO_IDS].sort()),
);

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(PR08_MODAL_PLAYER_SCENARIO_IDS).toContain(id);
  expect(exercised.has(id), `${id} was run more than once`).toBe(false);
  exercised.add(id);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

async function castNormally(
  page: Page,
  name: string,
  remainsOnBattlefield: boolean,
): Promise<void> {
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/, { timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  if (remainsOnBattlefield)
    await expect(humanPermanent(page, name)).toBeVisible({ timeout: 15_000 });
}

async function waitForDecision(page: Page, prompt: RegExp): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByText(prompt)
            .isVisible()
            .catch(() => false)
        )
          return true;
        if ((await pass.isVisible()) && (await pass.isEnabled())) await pass.click();
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function chooseTargetPlayer(page: Page, seat: string): Promise<void> {
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  const target = opponent(page, seat);
  await expect(target).toHaveClass(/targetable/);
  // The panel's header: its center may be one of that player's permanents, and clicking a
  // permanent selects it as a source instead.
  await target.locator(':scope > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function opponent(page: Page, seat: string) {
  return page.locator(`.opponent[data-seat="${seat}"]`);
}

function humanPermanent(page: Page, name: string) {
  return page.locator('.human-zone .object:not(.board-card-leave-active)').filter({
    has: page.getByRole('img', { name, exact: true }),
  });
}

function opponentPermanent(page: Page, name: string | RegExp, seat: string) {
  return opponent(page, seat)
    .locator('.object:not(.board-card-leave-active)')
    .filter({ has: page.getByRole('img', { name, exact: typeof name === 'string' }) });
}

function humanZoneImage(page: Page, name: string, zone: 'Graveyard' | 'Exile') {
  return page
    .locator('.human-zone .zones-strip .zone')
    .filter({ has: page.getByText(new RegExp(`^${zone} \\(`)) })
    .getByRole('img', { name, exact: true });
}
