import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR08_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-scenario-catalog';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

for (const mode of ['cast-search-and-gift', 'empty-library'] as const) {
  test(`Wishclaw Talisman: ${mode === 'cast-search-and-gift' ? 'cast, search, then choose the recipient' : 'empty library still gives control'}`, async ({
    page,
  }) => {
    const cast = mode === 'cast-search-and-gift';
    await runScenario(
      page,
      `Wishclaw Talisman: ${cast ? 'cast, search, then choose the recipient' : 'empty library still gives control'}`,
    );
    const source = humanPermanent(page, 'Wishclaw Talisman');
    if (cast) {
      await castPr08Card(page, 'Wishclaw Talisman');
      await passStackUntil(page, source);
    }
    await expect(source.locator('.counters')).toContainText('wish×3');
    await expect(source).toHaveClass(/actionable/);
    await source.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
    await confirm(page);
    const panel = page.locator('.decision-panel');
    if (cast) {
      const find = panel
        .locator('.panel-group')
        .filter({ hasText: 'Lab Wishclaw Beta' })
        .getByRole('button', { name: 'Put into your hand', exact: true });
      await passStackUntil(page, find);
      await expect(page.getByRole('button', { name: 'Find nothing', exact: true })).toHaveCount(0);
      await expect(source.locator('.tile')).toHaveClass(/tapped/);
      await expect(source.locator('.counters')).toContainText('wish×2');
      await find.click();
      await expect(handCard(page, 'Lab Wishclaw Beta')).toBeVisible();
    }
    const gift = panel
      .locator('.panel-group')
      .filter({ hasText: 'P3' })
      .getByRole('button', { name: 'Give control to', exact: true });
    await passStackUntil(page, gift);
    await expect(panel.locator('.group-player')).toHaveText(['P2', 'P3', 'P4']);
    for (const seat of ['P2', 'P3', 'P4'])
      await expect(page.locator(`.opponent[data-seat="${seat}"]`)).not.toHaveClass(/targetable/);
    await expect(source.locator('.counters')).toContainText('wish×2');
    await expect(source.locator('.tile')).toHaveClass(/tapped/);
    await gift.click();
    const given = page
      .locator('.opponent[data-seat="P3"] .object:not(.board-card-leave-active)')
      .filter({ has: page.getByRole('img', { name: 'Wishclaw Talisman', exact: true }) });
    await expect(given).toBeVisible();
    await expect(source).toHaveCount(0);
    await expect(given.locator('.tile')).toHaveClass(/tapped/);
    await expect(given.locator('.counters')).toContainText('wish×2');
    await expect(page.locator('.human-zone .hand-card:not(.hand-card-leave-active)')).toHaveCount(
      cast ? 2 : 1,
    );
    await expect(handCard(page, 'Lab Wishclaw Alpha')).toHaveCount(0);
    const swamp = humanPermanent(page, 'Swamp');
    await expect(swamp.locator('.tile')).toHaveClass(/tapped/);
    if (cast) await expect(swamp.locator('.stack-count-badge')).toHaveText('×3');
  });
}

test('Wishclaw Talisman: cannot activate off your turn', async ({ page }) => {
  await runScenario(page, 'Wishclaw Talisman: cannot activate off your turn');
  await expect(page.locator('.turn-badge')).toContainText('P2');
  await expect(handCard(page, 'Lab Priority Witness')).toHaveClass(/actionable/);
  const source = humanPermanent(page, 'Wishclaw Talisman');
  await expect(source).not.toHaveClass(/actionable/);
  await expect(source.locator('.tile')).not.toHaveClass(/tapped/);
  await expect(source.locator('.counters')).toContainText('wish×3');
});

for (const mode of ['duplicates', 'decline', 'shroud'] as const) {
  test(`Druid of Purification: ${mode === 'duplicates' ? 'choose the same permanent four times' : mode === 'decline' ? 'each player chooses none' : 'choose a permanent with shroud'}`, async ({
    page,
  }) => {
    await runScenario(
      page,
      `Druid of Purification: ${mode === 'duplicates' ? 'choose the same permanent four times' : mode === 'decline' ? 'each player chooses none' : 'choose a permanent with shroud'}`,
    );
    const name = mode === 'shroud' ? 'Lab Shrouded Artifact' : 'Lab Shared Artifact';
    await castPr08Card(page, 'Druid of Purification');
    await passStackUntil(page, page.getByRole('button', { name: 'Choose none', exact: true }));
    await expect(page.locator('.decision .prompt')).toContainText("P1 doesn't control");
    await expect(humanPermanent(page, 'Lab Own Artifact')).not.toHaveClass(/actionable/);
    await expect(opponentPermanent(page, name)).toHaveClass(/actionable/);
    if (mode === 'decline')
      await page.getByRole('button', { name: 'Choose none', exact: true }).click();
    else {
      await opponentPermanent(page, name).click();
      await confirm(page);
    }
    await expect(page.getByRole('button', { name: 'Pass priority', exact: true })).toBeVisible();
    await expect(humanPermanent(page, 'Druid of Purification')).toBeVisible();
    await expect(humanPermanent(page, 'Lab Own Artifact')).toBeVisible();
    await expect(opponentPermanent(page, name)).toHaveCount(mode === 'decline' ? 1 : 0);
    await expect(humanPermanent(page, 'Forest').locator('.tile')).toHaveClass(/tapped/);
    await expect(humanPermanent(page, 'Forest').locator('.stack-count-badge')).toHaveText('×4');
    const publicChoices = page
      .locator('.log .line .text')
      .filter({ hasText: /Druid of Purification.*: chooses / });
    await expect(publicChoices).toHaveCount(4);
    if (mode === 'decline')
      await expect(publicChoices.filter({ hasText: /: chooses no permanent$/ })).toHaveCount(4);
    else
      await expect(publicChoices.filter({ hasText: new RegExp(`: chooses ${name}$`) })).toHaveCount(
        4,
      );
  });
}
test.afterAll(() => expect([...exercised].sort()).toEqual([...PR08_SCENARIO_IDS].sort()));

async function runScenario(page: Page, title: string): Promise<void> {
  const frontier = { requestId: '', stackSize: 0 };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerActionRequired') {
        frontier.requestId = frame.payload.request.requestId;
        frontier.stackSize = frame.payload.state.stack.length;
      } else if (frame.type === 'playerStateSnapshot') {
        frontier.stackSize = frame.payload.state.stack.length;
      }
    }),
  );
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
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const frontier = frontiers.get(page)!;
  let submittedRequestId = '';
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        // A resolving stack may reach a new empty-stack priority request before Vue has rendered
        // the permanent. Never pass that request merely because the old stack DOM is still visible.
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

// --- Coverage PR08.01: Cut a Deal (drawForEachOpponent) ---

async function castCutADeal(page: Page): Promise<void> {
  const deal = handCard(page, 'Cut a Deal');
  await expect(deal).toHaveClass(/actionable/);
  await deal.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
}

async function resolveCutADeal(page: Page): Promise<void> {
  await castCutADeal(page);
  // After the spell resolves you hold priority again with an unused land drop, so the pass
  // raises the land-drop confirmation; the pattern from the Endless Atlas run confirms it.
  await passUntil(page, page.getByRole('button', { name: 'Pass anyway' }));
  await page.getByRole('button', { name: 'Pass anyway' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Cast Cut a Deal/i).first()).toBeVisible();
}

test('Cut a Deal: each opponent draws, then you draw three', async ({ page }) => {
  await runScenario(page, 'Cut a Deal: each opponent draws, then you draw three');
  await resolveCutADeal(page);
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(3);
  for (const seat of ['P2', 'P3', 'P4'] as const)
    await expect(page.locator('.opponent').filter({ hasText: seat })).toContainText('1 in hand');
});

test('Cut a Deal: an empty library draws nothing and you draw two', async ({ page }) => {
  await runScenario(page, 'Cut a Deal: an empty library draws nothing and you draw two');
  await resolveCutADeal(page);
  // P3 has no library when the spell resolves: P3 draws nothing (and loses at the next
  // state-based action), so the caster draws one per opponent who ACTUALLY drew — two.
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(2);
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('1 in hand');
  await expect(page.locator('.opponent').filter({ hasText: 'P4' })).toContainText('1 in hand');
  await expect(page.locator('.opponent').filter({ hasText: 'P3' })).toContainText('0 in hand');
});

function humanPermanent(page: Page, name: string) {
  return page
    .locator('.human-zone .object:not(.board-card-leave-active)')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
function opponentPermanent(page: Page, name: string) {
  return page
    .locator('.opponent[data-seat="P2"] .object:not(.board-card-leave-active)')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
async function castPr08Card(page: Page, name: string) {
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
}

for (const accept of [true, false]) {
  test(`Cytoplast Manipulator: ${accept ? 'cast with two counters and graft one' : 'decline graft and keep two counters'}`, async ({
    page,
  }) => {
    await runScenario(
      page,
      `Cytoplast Manipulator: ${accept ? 'cast with two counters and graft one' : 'decline graft and keep two counters'}`,
    );
    await castPr08Card(page, 'Cytoplast Manipulator');
    const source = humanPermanent(page, 'Cytoplast Manipulator');
    await passStackUntil(page, source);
    await expect(source.getByText('+1/+1×2')).toBeVisible();
    await expect(source.getByText('2/2', { exact: true })).toBeVisible();
    await castPr08Card(page, 'Lab Servo');
    await passUntil(page, page.getByText(/use this ability/i).first());
    await page.getByRole('button', { name: accept ? 'Yes' : 'No', exact: true }).click();
    const servo = humanPermanent(page, 'Lab Servo');
    await expect(source.getByText(`+1/+1×${accept ? 1 : 2}`)).toBeVisible();
    if (accept) await expect(servo.getByText('+1/+1×1')).toBeVisible();
    else await expect(servo.getByText(/\+1\/\+1/)).toHaveCount(0);
    await expect(servo.getByText(accept ? '2/2' : '1/1', { exact: true })).toBeVisible();
  });
}

test('Cytoplast Manipulator: steal a countered creature until the source leaves', async ({
  page,
}) => {
  await runScenario(
    page,
    'Cytoplast Manipulator: steal a countered creature until the source leaves',
  );
  const source = humanPermanent(page, 'Cytoplast Manipulator');
  await expect(source).toHaveClass(/actionable/);
  await source.click();
  const ability = page.getByRole('button', { name: /Gain control of target creature/ });
  if (await ability.isVisible()) await ability.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(opponentPermanent(page, 'Lab Servo')).not.toHaveClass(/targetable/);
  await opponentPermanent(page, 'Lab Ox').click();
  await confirm(page);
  const stolen = humanPermanent(page, 'Lab Ox');
  await passStackUntil(page, stolen);
  await expect(stolen.locator('.tile')).toHaveClass(/tapped/);
  await expect(stolen.locator('.keywords[title*="haste"]')).toHaveCount(0);
  await expect(source.locator('.tile')).toHaveClass(/tapped/);
  await handCard(page, 'Lab Source Recall').click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await source.click();
  await confirm(page);
  await passStackUntil(page, handCard(page, 'Cytoplast Manipulator'));
  await expect(opponentPermanent(page, 'Lab Ox').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(source).toHaveCount(0);
});

test('Humble Defector: draw two and give it to the chosen opponent', async ({ page }) => {
  await runScenario(page, 'Humble Defector: draw two and give it to the chosen opponent');
  const source = humanPermanent(page, 'Humble Defector');
  const before = await page.locator('.human-zone .hand-card:not(.hand-card-leave-active)').count();
  await expect(source).toHaveClass(/actionable/);
  await source.click();
  const ability = page.getByRole('button', { name: /Draw two cards, then target opponent/ });
  if (await ability.isVisible()) await ability.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(page.locator('.human-zone > header')).not.toHaveClass(/targetable/);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).toHaveClass(/targetable/);
  await page.locator('.opponent[data-seat="P3"] > header').click();
  await confirm(page);
  const given = page
    .locator('.opponent[data-seat="P3"] .object:not(.board-card-leave-active)')
    .filter({ has: page.getByRole('img', { name: 'Humble Defector', exact: true }) });
  await passStackUntil(page, given);
  await expect(source).toHaveCount(0);
  await expect(given.locator('.tile')).toHaveClass(/tapped/);
  await expect(page.locator('.human-zone .hand-card:not(.hand-card-leave-active)')).toHaveCount(
    before + 2,
  );
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).toContainText('0 in hand');
});

test('Humble Defector: cannot activate off your turn', async ({ page }) => {
  await runScenario(page, 'Humble Defector: cannot activate off your turn');
  await expect(page.locator('.turn-badge')).toContainText('P2');
  await expect(handCard(page, 'Lab Priority Witness')).toHaveClass(/actionable/);
  const source = humanPermanent(page, 'Humble Defector');
  await expect(source).toBeVisible();
  await expect(source).not.toHaveClass(/actionable/);
  await expect(source.locator('.tap-badge')).toHaveCount(0);
});
