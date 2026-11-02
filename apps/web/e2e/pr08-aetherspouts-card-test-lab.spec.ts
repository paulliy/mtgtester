import { expect, test, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { AETHERSPOUTS_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-remaining-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const titles = [
  'Aetherspouts: owner puts one attacker on top and one on bottom',
  'Aetherspouts: owner reverses the top and bottom choices',
] as const;

for (const [index, id] of AETHERSPOUTS_SCENARIO_IDS.entries()) {
  const title = titles[index]!;
  test(title, async ({ page }) => {
    let p1LibrarySize: number | undefined;
    let postAttackPriority = false;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired' || frame.type === 'playerStateSnapshot') {
          const p1 = frame.payload.state.seats.find((seat) => seat.seat === 'P1');
          if (p1 !== undefined) p1LibrarySize = p1.librarySize;
        }
        if (frame.type === 'playerActionRequired') {
          const request = frame.payload.request;
          if (
            request.decidingPlayer === 'P1' &&
            request.decisionType === 'priority' &&
            request.phase === 'combat' &&
            request.step === 'declareBlockers'
          )
            postAttackPriority = true;
        }
      }),
    );
    await runScenario(page, title);
    await passUntil(page, () => postAttackPriority);
    await castCard(page, 'Aetherspouts');

    const alphaTop = id === AETHERSPOUTS_SCENARIO_IDS[0];
    await chooseLibraryPosition(page, 'Lab P1 Attacker Alpha', alphaTop ? 'Top' : 'Bottom');
    await chooseLibraryPosition(page, 'Lab P1 Attacker Beta', alphaTop ? 'Bottom' : 'Top');

    for (const name of ['Lab P1 Attacker Alpha', 'Lab P1 Attacker Beta', 'Lab P2 Attacker'])
      await expect(opponentPermanent(page, name)).toHaveCount(0);
    const library = page.locator('.human-zone .meta-item').filter({ hasText: 'Library' });
    await expect(library).toHaveText('Library 6');
    await expect.poll(() => p1LibrarySize).toBe(6);
    await expect(page.getByText(/Target \d+ of \d+/)).toHaveCount(0);
  });
}

test.afterAll(() => expectLabCoverage(exercised, AETHERSPOUTS_SCENARIO_IDS));

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(AETHERSPOUTS_SCENARIO_IDS).toContain(id);
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

function opponentPermanent(page: Page, name: string) {
  return page.locator('.opponent[data-seat="P2"] .object:not(.board-card-leave-active)').filter({
    has: page.getByRole('img', { name, exact: true }),
  });
}

async function castCard(page: Page, name: string): Promise<void> {
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/, { timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
}

async function passUntil(page: Page, targetReached: () => boolean): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (targetReached()) return true;
        if ((await pass.isVisible()) && (await pass.isEnabled())) await pass.click();
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function chooseLibraryPosition(page: Page, attacker: string, position: 'Top' | 'Bottom') {
  const prompt = page.getByText(
    new RegExp(`Aetherspouts: put ${attacker} on top or bottom of your library`),
  );
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: position, exact: true }).click();
}
