import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR08_REMAINING_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-remaining-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

for (const [index, id] of PR08_REMAINING_SCENARIO_IDS.entries()) {
  const titles = [
    'Tragic Arrogance: keep one artifact creature for both choices',
    'Tragic Arrogance: skip unavailable permanent types',
  ];
  const title = titles[index]!;
  test(title, async ({ page }) => {
    await runScenario(page, title);
    await castCard(page, 'Tragic Arrogance');
    const keeperChoice = page
      .locator('.decision .panel-group')
      .filter({ hasText: 'Lab Keeper' })
      .getByRole('button', { name: 'Keep', exact: true });
    if (id === PR08_REMAINING_SCENARIO_IDS[0]) {
      await expect(keeperChoice).toBeVisible({ timeout: 15_000 });
      await keeperChoice.click();
      await expect(keeperChoice).toBeVisible();
      await keeperChoice.click();
    }
    const resolved = page
      .locator('.log .line .text')
      .filter({ hasText: /^Tragic Arrogance resolves$/ });
    await passStackUntil(page, resolved);
    if (id === PR08_REMAINING_SCENARIO_IDS[0]) {
      await expect(humanPermanent(page, 'Lab Keeper')).toHaveCount(0);
      await expect(opponentPermanent(page, 'Lab Keeper')).toHaveCount(1);
      await expect(opponentPermanent(page, 'Lab Victim')).toHaveCount(0);
      await expect(opponentPermanent(page, 'Lab Spare')).toHaveCount(0);
    } else {
      await expect(opponentPermanent(page, 'Lab Lone Creature')).toHaveCount(1);
    }
    for (const [name, copies] of [
      ['Plains', 2],
      ['Forest', 3],
    ] as const) {
      const land = humanPermanent(page, name);
      await expect(land).toHaveCount(1);
      if (copies > 1) await expect(land.locator('.stack-count-badge')).toHaveText(`×${copies}`);
    }
    await expect(
      page
        .locator('.opponent[data-seat="P2"] .object')
        .filter({ has: page.getByRole('img', { name: 'Forest', exact: true }) }),
    ).toHaveCount(1);
  });
}

test.afterAll(() => expectLabCoverage(exercised, PR08_REMAINING_SCENARIO_IDS));

async function runScenario(page: Page, title: string): Promise<void> {
  const frontier = { requestId: '', stackSize: 0 };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerActionRequired') {
        frontier.requestId = frame.payload.request.requestId;
        frontier.stackSize = frame.payload.state.stack.length;
      } else if (frame.type === 'playerStateSnapshot')
        frontier.stackSize = frame.payload.state.stack.length;
    }),
  );
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(PR08_REMAINING_SCENARIO_IDS).toContain(id);
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

async function castCard(page: Page, name: string): Promise<void> {
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
}

async function passStackUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const frontier = frontiers.get(page)!;
  let submittedRequestId = '';
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (
          frontier.stackSize > 0 &&
          frontier.requestId !== submittedRequestId &&
          (await pass.isVisible()) &&
          (await pass.isEnabled())
        ) {
          submittedRequestId = frontier.requestId;
          await pass.click();
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}
