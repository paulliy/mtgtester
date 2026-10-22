import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import {
  PR09_SCENARIOS,
  PR09_SCENARIO_IDS,
} from '../../../packages/server/src/cards/pr09-scenario-catalog';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();
const titles = new Map(PR09_SCENARIOS.map((scenario) => [scenario.id, scenario.title]));

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (title === undefined) throw new Error(`Missing PR09 title ${id}`);
  const frontier = { requestId: '', stackSize: 0 };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired') {
          frontier.requestId = frame.payload.request.requestId;
          frontier.stackSize = frame.payload.request.state.stack.length;
        } else if (frame.type === 'playerStateSnapshot')
          frontier.stackSize = frame.payload.state.stack.length;
      } catch {
        /* Ignore non-JSON websocket frames. */
      }
    }),
  );
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await picker.selectOption({ label: title });
  const selected = await picker.inputValue();
  expect(PR09_SCENARIO_IDS).toContain(selected);
  expect(selected).toBe(id);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function hand(page: Page, name: string): Locator {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}
function permanent(page: Page, seat: string, name: string): Locator {
  const zone = seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`;
  return page
    .locator(`${zone} .object:not(.board-card-leave-active)`)
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
async function cast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target \d+ of \d+/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function selectTargetingCast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
}
async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page
    .getByRole('button', { name: 'Pass priority', exact: true })
    .and(page.locator('button:enabled'));
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}
async function passStackUntil(page: Page, target: Locator): Promise<void> {
  const frontier = frontiers.get(page)!;
  const pass = page
    .getByRole('button', { name: 'Pass priority', exact: true })
    .and(page.locator('button:enabled'));
  let submitted = '';
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (
          frontier.stackSize > 0 &&
          frontier.requestId !== submitted &&
          (await pass.isVisible())
        ) {
          const requestId = frontier.requestId;
          try {
            await pass.click({ timeout: 1_000 });
            submitted = requestId;
          } catch {
            // A new decision can replace the button between observing and clicking it.
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}
async function attack(page: Page, attacker: string): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: attacker })
    .getByRole('button', { name: 'P2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
}
async function choosePlayerTarget(page: Page, seat: string): Promise<void> {
  const player = page.locator(`.opponent[data-seat="${seat}"]`);
  await expect(player).toHaveClass(/targetable/);
  await player.click();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}
async function chooseTarget(page: Page, seat: string, name: string): Promise<void> {
  const target = permanent(page, seat, name);
  await expect(target).toHaveClass(/targetable|actionable/);
  await target.click();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}
function recordFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => frames.push(payload.toString())),
  );
  return frames;
}

test('pr09-chaos-warp-viewer-positive', async ({ page }) => {
  await runScenario(page, 'pr09-chaos-warp-viewer-positive');
  await selectTargetingCast(page, 'Chaos Warp');
  await chooseTarget(page, 'P2', 'Lab P2 Artifact');
  await passUntil(page, page.getByText(/reveals Lab (Revealed Sorcery|Shuffle Filler)/i).first());
  await expect(permanent(page, 'P2', 'Lab P2 Artifact')).toHaveCount(0);
  await expect(
    page.getByText(/reveals Lab (Revealed Sorcery|Shuffle Filler)/i).first(),
  ).toBeVisible();
  await expect(page.locator('.log')).toContainText(
    /reveals Lab (Revealed Sorcery|Shuffle Filler)/i,
  );
});

test('pr09-chaos-warp-viewer-negative', async ({ page }) => {
  await runScenario(page, 'pr09-chaos-warp-viewer-negative');
  await selectTargetingCast(page, 'Chaos Warp');
  await chooseTarget(page, 'P2', 'Lab P2 Artifact');
  await passUntil(page, page.getByText(/Chaos Warp.*fizzles|no legal targets/i).first());
  await expect(permanent(page, 'P2', 'Lab P2 Artifact')).toHaveCount(0);
  await expect(page.getByText(/reveals Lab (Revealed Sorcery|Shuffle Filler)/i)).toHaveCount(0);
});

async function castAndEquipOmnitool(page: Page): Promise<void> {
  await cast(page, 'Adaptive Omnitool');
  const tool = permanent(page, 'P1', 'Adaptive Omnitool');
  await passStackUntil(page, tool);
  await tool.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await chooseTarget(page, 'P1', 'Lab Host');
  await passStackUntil(page, permanent(page, 'P1', 'Lab Host').locator('.pt'));
  await expect(permanent(page, 'P1', 'Lab Host').locator('.pt')).toHaveText('4/4');
}

test('pr09-adaptive-omnitool-viewer-positive', async ({ page }) => {
  const frames = recordFrames(page);
  await runScenario(page, 'pr09-adaptive-omnitool-viewer-positive');
  await castAndEquipOmnitool(page);
  await attack(page, 'Lab Host');
  const choice = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab Omnitool Hit' })
    .getByRole('button', { name: /Put into your hand/ });
  await passUntil(page, choice);
  await choice.click();
  await expect(hand(page, 'Lab Omnitool Hit')).toBeVisible();
  await expect(page.getByText(/reveals Lab Omnitool Hit/i).first()).toBeVisible();
  await expect(permanent(page, 'P2', 'Lab Opponent Artifact')).toBeVisible();
  await expect(frames.some((frame) => frame.includes('Lab Private 1'))).toBe(false);
  await expect(frames.some((frame) => frame.includes('Lab Private 2'))).toBe(false);
});

test('pr09-adaptive-omnitool-viewer-negative', async ({ page }) => {
  const frames = recordFrames(page);
  await runScenario(page, 'pr09-adaptive-omnitool-viewer-negative');
  await castAndEquipOmnitool(page);
  await attack(page, 'Lab Host');
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(hand(page, 'Lab Private')).toHaveCount(0);
  for (let n = 1; n <= 5; n++)
    await expect(page.getByText(new RegExp(`reveals Lab Private ${n}`))).toHaveCount(0);
  expect(frames.some((frame) => /Lab Private [1-5]/.test(frame))).toBe(false);
});

async function castSkyhunterAndAttack(page: Page): Promise<void> {
  await cast(page, 'Armored Skyhunter');
  const ready = permanent(page, 'P1', 'Armored Skyhunter').last();
  await passStackUntil(page, ready);
  await expect(ready).toContainText(/flying/i);
  await attack(page, 'Armored Skyhunter');
}

test('pr09-armored-skyhunter-viewer-positive', async ({ page }) => {
  await runScenario(page, 'pr09-armored-skyhunter-viewer-positive');
  await castSkyhunterAndAttack(page);
  const put = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab Equipment' })
    .getByRole('button', { name: /Put onto the battlefield/ });
  await passUntil(page, put);
  await put.click();
  const attachHost = page.locator('.decision-panel .panel-group').filter({ hasText: 'Lab Host' });
  await expect(attachHost).toBeVisible();
  await attachHost.getByRole('button', { name: 'Attach', exact: true }).click();
  await passStackUntil(page, permanent(page, 'P1', 'Lab Equipment'));
  await expect(permanent(page, 'P1', 'Lab Equipment')).toBeVisible();
  await expect(page.getByText(/Equip \{/)).toHaveCount(0);
});

test('pr09-armored-skyhunter-viewer-negative', async ({ page }) => {
  await runScenario(page, 'pr09-armored-skyhunter-viewer-negative');
  await castSkyhunterAndAttack(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'P1', 'Lab Non-Equipment Artifact')).toHaveCount(0);
  await expect(page.getByText(/Lab Non-Equipment Artifact.*battlefield/i)).toHaveCount(0);
});

test('pr09-armored-skyhunter-viewer-aura', async ({ page }) => {
  await runScenario(page, 'pr09-armored-skyhunter-viewer-aura');
  await castSkyhunterAndAttack(page);
  const put = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab Aura' })
    .getByRole('button', { name: /Put onto the battlefield/ });
  await passUntil(page, put);
  await put.click();
  await chooseTarget(page, 'P1', 'Lab Host');
  await passStackUntil(page, permanent(page, 'P1', 'Lab Aura'));
  await expect(permanent(page, 'P1', 'Lab Aura')).toBeVisible();
  await expect(page.locator('.log')).toContainText(/Enchant Lab Host/i);
});

test('pr09-keen-duelist-viewer-positive', async ({ page }) => {
  await runScenario(page, 'pr09-keen-duelist-viewer-positive');
  await choosePlayerTarget(page, 'P2');
  await passUntil(page, page.getByText(/reveals Lab P1 Reveal/i).first());
  await expect(page.getByText(/reveals Lab P2 Reveal/i).first()).toBeVisible();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
  await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('37');
  await expect(hand(page, 'Lab P1 Reveal')).toBeVisible();
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('1 in hand');
});

test('pr09-keen-duelist-viewer-cast', async ({ page }) => {
  await runScenario(page, 'pr09-keen-duelist-viewer-cast');
  await cast(page, 'Keen Duelist');
  await passStackUntil(page, permanent(page, 'P1', 'Keen Duelist'));
  await expect(
    page.locator('.log .line .text').filter({ hasText: /reveals Lab P[12] Reveal/ }),
  ).toHaveCount(0);
});

test('pr09-keen-duelist-viewer-negative', async ({ page }) => {
  await runScenario(page, 'pr09-keen-duelist-viewer-negative');
  await choosePlayerTarget(page, 'P2');
  await passUntil(page, page.getByText(/reveals Lab P2 Reveal/i).first());
  // The prepared lab runner ends every scenario with a neutral game-over sentinel after its
  // finite continuation. An empty-library reveal itself must not add a P1 reveal or a loss.
  await expect(page.getByText(/game over.*winner \(none\)/i)).toBeVisible();
  await expect(page.locator('.log .line .text').filter({ hasText: /P1 reveals/ })).toHaveCount(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
  await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('40');
});

async function attackSzarekh(page: Page): Promise<void> {
  await attack(page, 'Szarekh, the Silent King');
}

test('pr09-szarekh-the-silent-king-viewer-positive', async ({ page }) => {
  await runScenario(page, 'pr09-szarekh-the-silent-king-viewer-positive');
  const szarekh = permanent(page, 'P1', 'Szarekh, the Silent King');
  await expect(szarekh).toContainText(/flying/i);
  await attackSzarekh(page);
  const choice = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab Vehicle' })
    .getByRole('button', { name: /Return/ });
  await passUntil(page, choice);
  await choice.click();
  await expect(hand(page, 'Lab Vehicle')).toBeVisible();
  await expect(
    page.locator('.human-zone .resource').filter({ hasText: 'Graveyard' }),
  ).toContainText('2');
});

test('pr09-szarekh-the-silent-king-viewer-negative', async ({ page }) => {
  await runScenario(page, 'pr09-szarekh-the-silent-king-viewer-negative');
  await attackSzarekh(page);
  await expect(page.getByRole('button', { name: /Lab Old Artifact Creature/ })).toHaveCount(0);
  const decline = page.getByRole('button', { name: /Put no card|decline|do nothing/i });
  if (await decline.isVisible()) await decline.click();
  await expect(permanent(page, 'P1', 'Lab Old Artifact Creature')).toHaveCount(0);
  await expect(
    page.locator('.human-zone .resource').filter({ hasText: 'Graveyard' }),
  ).toContainText('4');
});

test('pr09-szarekh-the-silent-king-viewer-replaced-mill', async ({ page }) => {
  await runScenario(page, 'pr09-szarekh-the-silent-king-viewer-replaced-mill');
  await expect(permanent(page, 'P1', 'Rest in Peace')).toBeVisible();
  const exile = page
    .locator('.human-zone .zone')
    .filter({ has: page.getByRole('heading', { name: /^Exile \(/ }) });
  await expect(
    exile.getByRole('img', { name: 'Lab Old Artifact Creature', exact: true }),
  ).toBeVisible();
  await attackSzarekh(page);
  const panel = page.locator('.decision-panel');
  const choice = panel
    .locator('.panel-group')
    .filter({ hasText: 'Lab Vehicle' })
    .getByRole('button', { name: /Return/ });
  await passUntil(page, choice);
  await expect(
    panel.locator('.panel-group').filter({ hasText: 'Lab Old Artifact Creature' }),
  ).toHaveCount(0);
  await choice.click();
  await expect(hand(page, 'Lab Vehicle')).toBeVisible();
  await expect(
    exile.getByRole('img', { name: 'Lab Old Artifact Creature', exact: true }),
  ).toBeVisible();
  await expect(exile.getByRole('img', { name: 'Lab Milled One', exact: true })).toBeVisible();
  await expect(exile.getByRole('img', { name: 'Lab Milled Three', exact: true })).toBeVisible();
  await expect(exile.getByRole('img', { name: 'Lab Vehicle', exact: true })).toHaveCount(0);
  await expect(
    page.locator('.human-zone .resource').filter({ hasText: 'Graveyard' }),
  ).toContainText('0');
});

test('pr09-szarekh-the-silent-king-viewer-cast', async ({ page }) => {
  await runScenario(page, 'pr09-szarekh-the-silent-king-viewer-cast');
  await cast(page, 'Szarekh, the Silent King');
  const szarekh = permanent(page, 'P1', 'Szarekh, the Silent King');
  await passStackUntil(page, szarekh);
  await expect(szarekh).toContainText(/flying/i);
});

test.afterAll(() => expect([...exercised].sort()).toEqual([...PR09_SCENARIO_IDS].sort()));
