import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PlayerBoardState, ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR08_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-scenario-catalog';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

for (const mode of ['decline', 'pay', 'other-defender'] as const) {
  const title =
    'Kazuul: ' +
    (mode === 'decline'
      ? 'an attacking opponent declines and you create an Ogre before blockers'
      : mode === 'pay'
        ? 'the attacking creature controller pays three and you create no Ogre'
        : 'an attack on another player creates no Ogre');
  test(title, async ({ page }) => {
    const boards = recordPlayerBoards(page);
    await runScenario(page, title);
    await castPr08Card(page, 'Kazuul, Tyrant of the Cliffs');
    await passStackUntil(page, humanPermanent(page, 'Kazuul, Tyrant of the Cliffs'));
    await expect(humanPermanent(page, 'Forest').locator('.tile')).toHaveClass(/tapped/);
    await expect(humanPermanent(page, 'Mountain').locator('.tile')).toHaveClass(/tapped/);
    const log = page.locator('.log .line .text');
    if (mode === 'other-defender') {
      await passUntil(page, page.getByText(/game over/i).first());
      await expect(log.filter({ hasText: /attacks with 1 creature/ })).toHaveCount(1);
      await expect(page.locator('.opponent[data-seat="P3"] .life-badge')).toHaveText('39');
      await expect(log.filter({ hasText: /pay.*for Kazuul/ })).toHaveCount(0);
    } else {
      await passUntil(page, log.filter({ hasText: /create a 3\/3 red Ogre.*resolves$/ }));
      const observed = await wireBoardWhere(
        boards,
        (board) =>
          board.battlefield.filter(
            (entry) => entry.name === 'Forest' && entry.controller === 'P2' && entry.tapped,
          ).length === (mode === 'pay' ? 3 : 0) &&
          board.battlefield.filter((entry) => entry.name === 'Ogre').length ===
            (mode === 'decline' ? 1 : 0),
        'the attacking creature controller paid only when choosing to pay',
      );
      expect(observed.battlefield.filter((entry) => entry.name === 'Ogre')).toHaveLength(
        mode === 'decline' ? 1 : 0,
      );
    }
    await expect(humanPermanent(page, 'Ogre')).toHaveCount(mode === 'decline' ? 1 : 0);
    await expect(opponentPermanent(page, 'Ogre')).toHaveCount(0);
    if (mode === 'decline') {
      await expect(humanPermanent(page, 'Ogre').locator('.pt')).toHaveText('3/3');
      await passUntil(page, page.getByText(/Declare blockers/).first());
    }
    await expect(page.getByRole('button', { name: 'Pay {3}', exact: true })).toHaveCount(0);
  });
}

for (const upkeep of [false, true]) {
  test(`Akroan Horse: ${upkeep ? 'the recipient upkeep gives each opponent a Soldier' : 'cast and choose an opponent to gain control'}`, async ({
    page,
  }) => {
    await runScenario(
      page,
      `Akroan Horse: ${upkeep ? 'the recipient upkeep gives each opponent a Soldier' : 'cast and choose an opponent to gain control'}`,
    );
    await castPr08Card(page, 'Akroan Horse');
    const gift = page
      .locator('.decision-panel .panel-group')
      .filter({ hasText: 'P2' })
      .getByRole('button', { name: 'Give control to', exact: true });
    await passStackUntil(page, gift);
    await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
    await expect(page.locator('.decision-panel .group-player')).toHaveText(['P2', 'P3', 'P4']);
    await expect(humanPermanent(page, 'Swamp').locator('.tile')).toHaveClass(/tapped/);
    await expect(humanPermanent(page, 'Swamp').locator('.stack-count-badge')).toHaveText('×4');
    for (const seat of ['P2', 'P3', 'P4'])
      await expect(page.locator(`.opponent[data-seat="${seat}"]`)).not.toHaveClass(/targetable/);
    await gift.click();
    const horse = page
      .locator('.opponent[data-seat="P2"] .object:not(.board-card-leave-active)')
      .filter({ has: page.getByRole('img', { name: 'Akroan Horse', exact: true }) });
    await expect(horse).toBeVisible();
    await expect(humanPermanent(page, 'Akroan Horse')).toHaveCount(0);
    await expect(horse.locator('.tile')).not.toHaveClass(/tapped/);
    await expect(horse.locator('.keywords[title*="defender"]')).toHaveCount(1);
    await expect(page.getByRole('img', { name: 'Soldier', exact: true })).toHaveCount(0);
    if (upkeep) {
      const mine = humanPermanent(page, 'Soldier');
      await passUntil(page, mine);
      await expect(page.locator('.turn-badge')).toContainText('P2');
      await expect(mine).toHaveCount(1);
      await expect(mine.locator('.tile')).not.toHaveClass(/tapped/);
      for (const seat of ['P3', 'P4']) {
        const soldier = page
          .locator(`.opponent[data-seat="${seat}"] .object`)
          .filter({ has: page.getByRole('img', { name: 'Soldier', exact: true }) });
        await expect(soldier).toHaveCount(1);
        await expect(soldier.locator('.tile')).not.toHaveClass(/tapped/);
      }
      await expect(
        page
          .locator('.opponent[data-seat="P2"] .object')
          .filter({ has: page.getByRole('img', { name: 'Soldier', exact: true }) }),
      ).toHaveCount(0);
    }
  });
}

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

/**
 * Records every server frame the viewing seat receives. Read-only observation of the real socket:
 * used to prove an opponent's private library identity never crosses the wire. No mocking, no
 * routing, no private backend calls.
 */
function recordFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      frames.push(payload.toString());
    }),
  );
  return frames;
}

/** A hand card that is currently castable, so it only matches once priority is really offered. */
function actionableHandCard(page: Page, name: string) {
  return page
    .locator('.human-zone .hand-card.actionable:not(.hand-card-leave-active)')
    .filter({ hasText: name });
}

test('Scheming Symmetry: you and an opponent each search their own library', async ({ page }) => {
  const title = 'Scheming Symmetry: you and an opponent each search their own library';
  const frames = recordFrames(page);
  await runScenario(page, title);
  const panel = page.locator('.decision-panel');

  // Cast through the ordinary menu; the printed {B} really leaves P1's only Swamp tapped.
  await castPr08Card(page, 'Scheming Symmetry');

  // Two ordinary counted target pickers. The first offers every player; the second drops the
  // already-picked seat, so the same player cannot be chosen twice.
  await expect(page.getByText(/Choose target 1 for/)).toBeVisible({ timeout: 15_000 });
  for (const seat of ['P1', 'P2', 'P3', 'P4'])
    await expect(panel.getByRole('button', { name: `Target ${seat}`, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Target P1', exact: true }).click();
  await expect(page.getByText(/Choose target 2 for/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Target P1', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Target P2', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Target P2', exact: true }).click();
  await expect(humanPermanent(page, 'Swamp').locator('.tile')).toHaveClass(/tapped/);

  // Resolving asks P1 for a private choice from P1's OWN library, and only from it.
  const mine = panel
    .locator('.panel-group')
    .filter({ hasText: 'Lab Symmetry P1 Alpha' })
    .getByRole('button', { name: 'Choose', exact: true });
  await passStackUntil(page, mine);
  await expect(panel.getByRole('button', { name: 'Choose', exact: true })).toHaveCount(2);
  await expect(panel).toContainText('Lab Symmetry P1 Beta');
  // An unrestricted search must find a card, so there is no decline option.
  await expect(page.getByRole('button', { name: /Find nothing/ })).toHaveCount(0);
  await mine.click();

  // P2's search is P2's own decision: the scripted seat answers it and P1 sees no such menu.
  await passStackUntil(page, actionableHandCard(page, 'Lab Symmetry Draw Witness'));
  await expect(panel.locator('.panel-group').filter({ hasText: 'P2' })).toHaveCount(0);

  // Prove the chosen card really sits on P1's own top of library by drawing it normally.
  await actionableHandCard(page, 'Lab Symmetry Draw Witness').click();
  await confirm(page);
  await passStackUntil(page, handCard(page, 'Lab Symmetry P1 Alpha'));
  await expect(handCard(page, 'Lab Symmetry P1 Alpha')).toBeVisible();
  await expect(handCard(page, 'Lab Symmetry P1 Beta')).toHaveCount(0);

  // The resolution is narrated publicly, but P2's private choice never appears anywhere.
  await expect(page.getByText(/Scheming Symmetry resolves/i).first()).toBeVisible();
  await expect(page.getByText('Choose Lab Symmetry P1 Alpha').first()).toBeVisible();
  for (const name of ['Lab Symmetry P2 Alpha', 'Lab Symmetry P2 Beta'])
    expect(frames.join('\n'), `${name} leaked over the wire`).not.toContain(name);
  await expect(page.getByText(/Lab Symmetry P2/)).toHaveCount(0);
});

test('Scheming Symmetry: two opponents search, one with an empty library', async ({ page }) => {
  const title = 'Scheming Symmetry: two opponents search, one with an empty library';
  const frames = recordFrames(page);
  await runScenario(page, title);
  const panel = page.locator('.decision-panel');

  await castPr08Card(page, 'Scheming Symmetry');

  // P1 targets two opponents and is not a target itself.
  await expect(page.getByText(/Choose target 1 for/)).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('button', { name: 'Target P2', exact: true }).click();
  await expect(page.getByText(/Choose target 2 for/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Target P2', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Target P3', exact: true }).click();
  await expect(humanPermanent(page, 'Swamp').locator('.tile')).toHaveClass(/tapped/);

  // P1 is never asked to search, so P1 is never offered a search menu at all.
  await passStackUntil(
    page,
    page.locator('.log .line .text').filter({ hasText: /^Scheming Symmetry resolves$/ }),
  );
  await expect(page.locator('.decision-panel')).toHaveCount(0);
  await expect(page.getByText(/choose a card to put on top of your library/i)).toHaveCount(0);

  // The kept witness is still castable in the final priority window, and P1's library is intact.
  await expect(actionableHandCard(page, 'Lab Symmetry Draw Witness')).toHaveCount(1);
  await expect(actionableHandCard(page, 'Lab Priority Witness')).toHaveCount(1);
  await expect(page.getByText(/Scheming Symmetry resolves/i).first()).toBeVisible();

  // P3's private identity never reaches P1's wire or the DOM, and P1's hand is untouched.
  for (const name of ['Lab Symmetry P3 Alpha', 'Lab Symmetry P3 Beta'])
    expect(frames.join('\n'), `${name} leaked over the wire`).not.toContain(name);
  await expect(page.getByText(/Lab Symmetry P3/)).toHaveCount(0);
  await expect(handCard(page, 'Lab Symmetry P1 Alpha')).toHaveCount(0);
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

// --- Coverage PR08.17: Reins of Power (untap both groups, swap until end of turn, haste) ---

/** A seat's permanent strip entry for one card name; `.object` is the actionable wrapper. */
function seatPermanent(page: Page, seat: string, name: string) {
  return page
    .locator(`.opponent[data-seat="${seat}"] .object:not(.board-card-leave-active)`)
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

/**
 * Cast Reins of Power the normal way: pick it out of hand, see the real auto-pay preview, then
 * target P2 through the real player-target chooser. The caster is never a legal target.
 */
async function castReinsOnP2(page: Page): Promise<void> {
  const spell = handCard(page, 'Reins of Power');
  await expect(spell).toHaveClass(/actionable/);
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(page.locator('.human-zone > header')).not.toHaveClass(/targetable/);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).toHaveClass(/targetable/);
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await confirm(page);
}

test('Reins of Power: both groups swap, then control returns at cleanup', async ({ page }) => {
  await runScenario(page, 'Reins of Power: both groups swap, then control returns at cleanup');
  // Pre-cast arrangement: your own 2/2 and P2's 4/4 are both tapped, P3's Servo is tapped too.
  await expect(humanPermanent(page, 'Lab Trader').locator('.tile')).toHaveClass(/tapped/);
  await expect(opponentPermanent(page, 'Lab Ox').locator('.tile')).toHaveClass(/tapped/);
  await expect(seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.tile')).toHaveClass(
    /tapped/,
  );

  await castReinsOnP2(page);
  // The creatures cross zones: P2's Ox is now yours, and your own Trader is now P2's.
  const ox = humanPermanent(page, 'Lab Ox');
  await passStackUntil(page, ox);
  const trader = opponentPermanent(page, 'Lab Trader');
  await expect(ox).toHaveCount(1);
  await expect(trader).toHaveCount(1);
  await expect(humanPermanent(page, 'Lab Trader')).toHaveCount(0);
  await expect(opponentPermanent(page, 'Lab Ox')).toHaveCount(0);

  // Both groups were untapped and given haste; only the two named groups, never P3's creature.
  for (const swapped of [ox, trader]) {
    await expect(swapped.locator('.tile')).not.toHaveClass(/tapped/);
    await expect(swapped.locator('.keywords[title*="haste"]')).toHaveCount(1);
  }
  await expect(seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.tile')).toHaveClass(
    /tapped/,
  );
  await expect(
    seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.keywords[title*="haste"]'),
  ).toHaveCount(0);

  // {2}{U}{U} really left your lands: all four Islands are tapped, stacked as one group.
  await expect(humanPermanent(page, 'Island').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Island').locator('.stack-count-badge')).toHaveText('×4');
  await expect(handCard(page, 'Lab Priority Witness')).toBeVisible();

  // Pass to cleanup: control returns, haste expires, and the untap is not undone by either.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(opponentPermanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(humanPermanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(humanPermanent(page, 'Lab Trader')).toHaveCount(1);
  await expect(opponentPermanent(page, 'Lab Trader')).toHaveCount(0);
  await expect(opponentPermanent(page, 'Lab Ox').locator('.tile')).not.toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Lab Trader').locator('.tile')).not.toHaveClass(/tapped/);
  await expect(page.locator('.human-zone .keywords[title*="haste"]')).toHaveCount(0);
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .object')
      .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
      .locator('.keywords[title*="haste"]'),
  ).toHaveCount(0);
  // P3 was never in either group, so it is still the same tapped creature.
  await expect(seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.tile')).toHaveClass(
    /tapped/,
  );
});

test('Reins of Power: only the opponent group exists when the caster has no creatures', async ({
  page,
}) => {
  await runScenario(
    page,
    'Reins of Power: only the opponent group exists when the caster has no creatures',
  );
  // The caster's own group really is empty: only the stacked Islands sit on your side.
  await expect(page.locator('.human-zone .object:not(.board-card-leave-active)')).toHaveCount(1);
  await expect(opponentPermanent(page, 'Lab Ox').locator('.tile')).toHaveClass(/tapped/);

  await castReinsOnP2(page);
  const ox = humanPermanent(page, 'Lab Ox');
  await passStackUntil(page, ox);
  await expect(ox).toHaveCount(1);
  await expect(ox.locator('.tile')).not.toHaveClass(/tapped/);
  await expect(ox.locator('.keywords[title*="haste"]')).toHaveCount(1);
  await expect(opponentPermanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Trader', exact: true })).toHaveCount(0);
  // The uninvolved third player's creature is still untouched and still tapped.
  await expect(seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.tile')).toHaveClass(
    /tapped/,
  );
  await expect(
    seatPermanent(page, 'P3', 'Lab Uninvolved Servo').locator('.keywords[title*="haste"]'),
  ).toHaveCount(0);
  await expect(humanPermanent(page, 'Island').locator('.stack-count-badge')).toHaveText('×4');
});

// --- Coverage PR08.14: Alicia Masters, Skilled Sculptor ---
//
// One board, two runs. "At the beginning of combat on your turn, if you've cast a noncreature
// spell this turn" is read at the START of combat, so the run that produces a Treasure has to put
// the noncreature spell on the stack while it is still in the main phase. The end-step line has no
// condition at all, so it runs identically either way.
//
// The arrangement under test is ownership vs. holding: P1's creature is held by P2, P2's creature
// is held by P1, P3's NONCREATURE artifact is held by P1, and P3 keeps a bystander nobody holds.
// The browser proves which PANEL each permanent is rendered in — that is the controller, the fact
// the UI actually shows — and the wire frames prove the ownership the panels cannot display.

const ALICIA = 'Alicia Masters, Skilled Sculptor';
const ALICIA_WITNESS = 'Lab Priority Witness';
const ALICIA_TREASURE = 'Treasure';
const ALICIA_P1_OWNED_HELD_BY_P2 = 'Lab Reclaimed Ox';
const ALICIA_P2_OWNED_HELD_BY_P1 = 'Lab Borrowed Golem';
const ALICIA_P3_OWNED_RELIC_HELD_BY_P1 = 'Lab Pledged Relic';
const ALICIA_P3_BYSTANDER = 'Lab Bystander Golem';

/**
 * The real `PlayerBoardState` frames this run received over the wire, in order. Ownership is not
 * drawn on any panel, so it is read from the very frame the panels were rendered from — an
 * observation of the protocol, not a poke at page or engine state, and never a fabricated UI.
 */
function recordPlayerBoards(page: Page): PlayerBoardState[] {
  const boards: PlayerBoardState[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot') boards.push(frame.payload.state);
      else if (frame.type === 'playerActionRequired') boards.push(frame.payload.state);
    }),
  );
  return boards;
}

/** The public action-log lines, in the order the engine emitted them. */
async function logLines(page: Page): Promise<string[]> {
  return page.locator('.log .line .text').allInnerTexts();
}

function indexOfLine(lines: readonly string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

/**
 * The last wire board matching `predicate`, polled so a late frame is never read as a missing one.
 * The panels are rendered from these same frames, so this reads ownership from exactly the state
 * the assertions above are looking at.
 */
async function wireBoardWhere(
  boards: readonly PlayerBoardState[],
  predicate: (board: PlayerBoardState) => boolean,
  what: string,
): Promise<PlayerBoardState> {
  await expect
    .poll(() => boards.filter(predicate).length, { timeout: 15_000, message: what })
    .toBeGreaterThan(0);
  return boards.filter(predicate).at(-1)!;
}

/** The one permanent of that name on a published board, so ownership reads are unambiguous. */
function permanentOn(board: PlayerBoardState, name: string) {
  const found = board.battlefield.filter((entry) => entry.name === name);
  expect(found, `${name} appears once on the published board`).toHaveLength(1);
  return found[0]!;
}

/** The arranged board, asserted before anything is cast: only the HOLDING is unusual. */
async function expectAliciaArrangement(page: Page): Promise<void> {
  await expect(handCard(page, ALICIA)).toBeVisible();
  await expect(handCard(page, ALICIA_WITNESS)).toBeVisible();
  await expect(humanPermanent(page, ALICIA)).toHaveCount(0);
  await expect(opponentPermanent(page, ALICIA_P1_OWNED_HELD_BY_P2)).toHaveCount(1);
  await expect(humanPermanent(page, ALICIA_P2_OWNED_HELD_BY_P1).locator('.tile')).toHaveClass(
    /tapped/,
  );
  await expect(humanPermanent(page, ALICIA_P3_OWNED_RELIC_HELD_BY_P1)).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', ALICIA_P3_BYSTANDER)).toHaveCount(1);
  await expect(page.getByRole('img', { name: ALICIA_TREASURE, exact: true })).toHaveCount(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('20');
}

/** Cast Alicia through the ordinary path: pick her out of hand, read the real payment preview. */
async function castAlicia(page: Page): Promise<void> {
  const card = handCard(page, ALICIA);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  // The ordinary mana selection for the printed {1}{R} over exactly the two untapped Mountains.
  await expect(page.getByText(/Auto-pay: Mountain ×2/)).toBeVisible();
  await confirm(page);
}

test('Alicia Masters: a noncreature spell this turn makes a Treasure, then each player reclaims their own creatures', async ({
  page,
}) => {
  const boards = recordPlayerBoards(page);
  await runScenario(
    page,
    'Alicia Masters: a noncreature spell this turn makes a Treasure, then each player reclaims their own creatures',
  );
  await expectAliciaArrangement(page);

  await castAlicia(page);
  const alicia = humanPermanent(page, ALICIA);
  await passStackUntil(page, alicia);
  await expect(alicia).toHaveCount(1);
  // {1}{R} really left the lands: both Mountains are tapped and stacked as one group.
  await expect(humanPermanent(page, 'Mountain').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Mountain').locator('.stack-count-badge')).toHaveText('×2');

  // The intervening if reads the cast history at the START of combat, so the noncreature spell has
  // to go down while it is still the main phase — after Alicia, and before combat.
  const witness = handCard(page, ALICIA_WITNESS);
  await expect(witness).toHaveClass(/actionable/);
  await witness.click();
  await confirm(page);

  // With nothing left in hand and no permanent to activate, every remaining window is all-pass and
  // the engine resolves it, so this simply waits for the run to finish on its own terms.
  await passUntil(page, page.getByText(/game over/i).first());

  // Exactly one Treasure, on your own board, and it is not one of the creatures.
  await expect(humanPermanent(page, ALICIA_TREASURE)).toHaveCount(1);
  await expect(page.getByRole('img', { name: ALICIA_TREASURE, exact: true })).toHaveCount(1);
  await expect(humanPermanent(page, ALICIA_TREASURE).locator('.tile')).not.toHaveClass(/tapped/);
  // The witness really resolved its printed effect: P1 gained the life the instant prints.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('21');
  await expect(handCard(page, ALICIA_WITNESS)).toHaveCount(0);

  // "each player gains control of all creatures they own": both stolen creatures changed panels,
  // P3's bystander never moved, and P3's NONCREATURE artifact stayed with P1 because it is not a
  // creature.
  await expect(humanPermanent(page, ALICIA_P1_OWNED_HELD_BY_P2)).toHaveCount(1);
  await expect(opponentPermanent(page, ALICIA_P1_OWNED_HELD_BY_P2)).toHaveCount(0);
  await expect(opponentPermanent(page, ALICIA_P2_OWNED_HELD_BY_P1)).toHaveCount(1);
  await expect(humanPermanent(page, ALICIA_P2_OWNED_HELD_BY_P1)).toHaveCount(0);
  await expect(humanPermanent(page, ALICIA)).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', ALICIA_P3_BYSTANDER)).toHaveCount(1);
  await expect(opponentPermanent(page, ALICIA_P3_BYSTANDER)).toHaveCount(0);
  await expect(humanPermanent(page, ALICIA_P3_OWNED_RELIC_HELD_BY_P1)).toHaveCount(1);
  await expect(page.getByRole('img', { name: ALICIA_P3_OWNED_RELIC_HELD_BY_P1 })).toHaveCount(1);

  // The same wire frames the panels were rendered from name the owners the panels cannot show:
  // the Treasure and P2's returned creature are owned by their owners, and P3's noncreature
  // artifact is still owned by P3 while P1 keeps holding it.
  const restored = await wireBoardWhere(
    boards,
    (board) =>
      board.battlefield.some(
        (entry) => entry.name === ALICIA_P2_OWNED_HELD_BY_P1 && entry.controller === 'P2',
      ),
    'the end step returned P2’s creature on a published board',
  );
  expect(permanentOn(restored, ALICIA_TREASURE)).toMatchObject({
    owner: 'P1',
    controller: 'P1',
    tapped: false,
  });
  expect(permanentOn(restored, ALICIA_P1_OWNED_HELD_BY_P2)).toMatchObject({
    owner: 'P1',
    controller: 'P1',
  });
  expect(permanentOn(restored, ALICIA_P2_OWNED_HELD_BY_P1)).toMatchObject({
    owner: 'P2',
    controller: 'P2',
  });
  expect(permanentOn(restored, ALICIA_P3_OWNED_RELIC_HELD_BY_P1)).toMatchObject({
    owner: 'P3',
    controller: 'P1',
  });
  expect(permanentOn(restored, ALICIA_P3_BYSTANDER)).toMatchObject({
    owner: 'P3',
    controller: 'P3',
  });

  // The public log is the timing evidence: both casts, the real life gain, the combat ability and
  // then the end-step ability, in that order.
  const lines = await logLines(page);
  expect(
    indexOfLine(lines, /^Cast Alicia Masters, Skilled Sculptor \(\{1\}\{R\}\)$/),
  ).toBeGreaterThanOrEqual(0);
  expect(indexOfLine(lines, /^Cast Lab Priority Witness \(\{0\}\)$/)).toBeGreaterThanOrEqual(0);
  expect(indexOfLine(lines, /gains 1 life/)).toBeGreaterThanOrEqual(0);
  const combatLine = indexOfLine(lines, /create a Treasure token resolves$/);
  const endStepLine = indexOfLine(
    lines,
    /each player gains control of all creatures they own resolves$/,
  );
  expect(combatLine).toBeGreaterThanOrEqual(0);
  expect(endStepLine).toBeGreaterThan(combatLine);
  // Combat really was combat-free: the 0-power defenders under test can neither attack nor block,
  // so no attack declaration and no combat damage was ever announced.
  expect(indexOfLine(lines, /^attacks with /)).toBe(-1);
  expect(indexOfLine(lines, /combat damage/)).toBe(-1);
});

test('Alicia Masters: no noncreature spell this turn makes no Treasure, but creatures still return to their owners', async ({
  page,
}) => {
  const boards = recordPlayerBoards(page);
  await runScenario(
    page,
    'Alicia Masters: no noncreature spell this turn makes no Treasure, but creatures still return to their owners',
  );
  await expectAliciaArrangement(page);

  await castAlicia(page);
  await passStackUntil(page, humanPermanent(page, ALICIA));
  await expect(humanPermanent(page, ALICIA)).toHaveCount(1);
  await expect(humanPermanent(page, 'Mountain').locator('.tile')).toHaveClass(/tapped/);

  // The witness is deliberately left in hand: casting nothing else is what keeps the intervening
  // if false, and it stays castable the whole way through the combat and end steps.
  await expect(handCard(page, ALICIA_WITNESS)).toHaveClass(/actionable/);
  await passUntil(page, page.getByText(/game over/i).first());

  // No Treasure was ever made. Waiting for the end-step frame FIRST is what makes this a real
  // negative: it proves frames kept arriving through combat and the end step, so "no Treasure in
  // any frame" is an observation of the whole run rather than of its first moment.
  const restored = await wireBoardWhere(
    boards,
    (board) =>
      board.battlefield.some(
        (entry) => entry.name === ALICIA_P2_OWNED_HELD_BY_P1 && entry.controller === 'P2',
      ),
    'the end step returned P2’s creature on a published board',
  );
  await expect(page.getByRole('img', { name: ALICIA_TREASURE, exact: true })).toHaveCount(0);
  expect(
    boards.flatMap((board) => board.battlefield).filter((entry) => entry.name === ALICIA_TREASURE),
  ).toHaveLength(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('20');
  // Still in hand at the end: the run really never cast it, so the intervening if stayed false for
  // the whole turn instead of the replay quietly casting the witness on our behalf.
  await expect(handCard(page, ALICIA_WITNESS)).toHaveCount(1);
  await expect(handCard(page, ALICIA_WITNESS)).toContainText(ALICIA_WITNESS);

  // "Sense the Good" has no condition, so the restoration happened exactly as in the positive run.
  await expect(humanPermanent(page, ALICIA_P1_OWNED_HELD_BY_P2)).toHaveCount(1);
  await expect(opponentPermanent(page, ALICIA_P1_OWNED_HELD_BY_P2)).toHaveCount(0);
  await expect(opponentPermanent(page, ALICIA_P2_OWNED_HELD_BY_P1)).toHaveCount(1);
  await expect(humanPermanent(page, ALICIA_P2_OWNED_HELD_BY_P1)).toHaveCount(0);
  await expect(seatPermanent(page, 'P3', ALICIA_P3_BYSTANDER)).toHaveCount(1);
  await expect(humanPermanent(page, ALICIA_P3_OWNED_RELIC_HELD_BY_P1)).toHaveCount(1);

  expect(permanentOn(restored, ALICIA_P1_OWNED_HELD_BY_P2)).toMatchObject({
    owner: 'P1',
    controller: 'P1',
  });
  expect(permanentOn(restored, ALICIA_P2_OWNED_HELD_BY_P1)).toMatchObject({
    owner: 'P2',
    controller: 'P2',
  });
  expect(permanentOn(restored, ALICIA_P3_OWNED_RELIC_HELD_BY_P1)).toMatchObject({
    owner: 'P3',
    controller: 'P1',
  });

  // Only the end-step ability was ever a public resolution: the combat line never fired and the
  // witness was never cast.
  const lines = await logLines(page);
  expect(indexOfLine(lines, /create a Treasure token resolves$/)).toBe(-1);
  expect(indexOfLine(lines, /^Cast Lab Priority Witness/)).toBe(-1);
  expect(
    indexOfLine(lines, /each player gains control of all creatures they own resolves$/),
  ).toBeGreaterThanOrEqual(0);
});

// --- Coverage PR08.22: Benevolent Offering ---
//
// One board, two runs. The two printed instructions are INDEPENDENT: the first names an opponent
// for the Spirits, the second asks again from scratch and may name the same one. Nothing here is
// arranged after the fact — the browser casts the printed {3}{W} instant out of hand, pays with the
// four real Plains, and answers both questions through the real decision panel.
//
// Both questions are resolution choices, not targets, so the panel must never offer a target slot,
// never highlight a board, and never include the caster in the menu. The board is arranged with
// printed 0/3 Defenders and one printed noncreature artifact so "2 life per creature" reads four
// different numbers: P1 and P2 both hold four creatures once the Spirits exist, P3 holds two, and
// P4 holds none.

const OFFERING = 'Benevolent Offering';
const OFFERING_WITNESS = 'Lab Priority Witness';
const OFFERING_SPIRIT = 'Spirit';
const OFFERING_P1_CREATURE = 'Lab Offering Sentinel';
const OFFERING_P2_CREATURE = 'Lab Offering Wall';
const OFFERING_P3_CREATURE = 'Lab Offering Golem';
const OFFERING_P4_NONCREATURE = 'Lab Silent Relic';
const SPIRIT_PROMPT = 'Benevolent Offering: choose an opponent to create tokens with you';
const LIFE_PROMPT = 'Benevolent Offering: choose an opponent to gain life for their creatures';

/**
 * One seat's Spirit group. Three identical tokens render as ONE tile with a `×3` badge, not three
 * objects — so a count of 1 here is the correct expectation and three would be a false failure.
 */
function seatSpirits(page: Page, seat: 'own' | 'P2' | 'P3' | 'P4') {
  const zone =
    seat === 'own' ? page.locator('.human-zone') : page.locator(`.opponent[data-seat="${seat}"]`);
  return zone
    .locator('.object:not(.board-card-leave-active)')
    .filter({ has: page.getByRole('img', { name: OFFERING_SPIRIT, exact: true }) });
}

/** The real opponent menu: one group per living opponent, one "Choose" button in each. */
function opponentChoice(page: Page, seat: string) {
  return page
    .locator('.decision-panel .panel-group')
    .filter({ has: page.locator('.group-player', { hasText: new RegExp(`^${seat}$`) }) })
    .getByRole('button', { name: 'Choose', exact: true });
}

function seatLife(page: Page, seat: 'own' | 'P2' | 'P3' | 'P4') {
  return seat === 'own'
    ? page.locator('.human-zone .life-badge')
    : page.locator(`.opponent[data-seat="${seat}"] .life-badge`);
}

/** The arranged board, asserted before anything is cast. */
async function expectOfferingArrangement(page: Page): Promise<void> {
  await expect(handCard(page, OFFERING)).toBeVisible();
  await expect(handCard(page, OFFERING_WITNESS)).toBeVisible();
  // Four identical untapped Plains render as one tile with a ×4 badge.
  await expect(humanPermanent(page, 'Plains')).toHaveCount(1);
  await expect(humanPermanent(page, 'Plains').locator('.stack-count-badge')).toHaveText('×4');
  await expect(humanPermanent(page, 'Plains').locator('.tile')).not.toHaveClass(/tapped/);
  await expect(humanPermanent(page, OFFERING_P1_CREATURE)).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', OFFERING_P2_CREATURE)).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', OFFERING_P3_CREATURE)).toHaveCount(1);
  await expect(
    seatPermanent(page, 'P3', OFFERING_P3_CREATURE).locator('.stack-count-badge'),
  ).toHaveText('×2');
  await expect(seatPermanent(page, 'P4', OFFERING_P4_NONCREATURE)).toHaveCount(1);
  for (const seat of ['own', 'P2', 'P3', 'P4'] as const)
    await expect(seatLife(page, seat)).toHaveText('40');
  // Nothing exists yet.
  await expect(page.getByRole('img', { name: OFFERING_SPIRIT, exact: true })).toHaveCount(0);
}

/** Cast the printed instant the ordinary way and pay it with the four Plains. */
async function castOffering(page: Page): Promise<void> {
  const card = handCard(page, OFFERING);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  // The real payment preview for the printed {3}{W}: the multiplication sign is U+00D7.
  await expect(page.getByText(/Auto-pay: Plains ×4/)).toBeVisible();
  // An instant with no "target a player" clause offers no target slot at all.
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  await expect(page.getByText(/All \d+ targets? selected/)).toHaveCount(0);
  await confirm(page);
}

/** Assert one opponent menu: exactly the three opponents, the printed prompt, and no targeting. */
async function expectOpponentMenu(page: Page, prompt: string): Promise<void> {
  await expect(page.locator('.decision-panel .panel-prompt')).toHaveText(prompt);
  // Every living opponent and never the caster.
  await expect(page.locator('.decision-panel .group-player')).toHaveText(['P2', 'P3', 'P4']);
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  await expect(page.locator('.human-zone > header')).not.toHaveClass(/targetable/);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).not.toHaveClass(/targetable/);
}

/** Six Spirits, three for each creator: one tile, three copies, untapped, 1/1, flying. */
async function expectSpiritTriplets(page: Page): Promise<void> {
  for (const seat of ['own', 'P2'] as const) {
    const group = seatSpirits(page, seat);
    await expect(group).toHaveCount(1);
    await expect(group.locator('.stack-count-badge')).toHaveText('×3');
    await expect(group.locator('.tile')).not.toHaveClass(/tapped/);
    await expect(group.locator('.keywords[title*="flying"]')).toHaveCount(1);
    await expect(group.locator('.pt')).toHaveText('1/1');
  }
  // Neither bystander was given a token.
  await expect(seatSpirits(page, 'P3')).toHaveCount(0);
  await expect(seatSpirits(page, 'P4')).toHaveCount(0);
}

test('Benevolent Offering: choose P2 for the Spirits and P3 for the life', async ({ page }) => {
  const boards = recordPlayerBoards(page);
  await runScenario(page, 'Benevolent Offering: choose P2 for the Spirits and P3 for the life');
  await expectOfferingArrangement(page);

  await castOffering(page);

  // The first question, on the board as arranged: no Spirit exists yet.
  const firstChoice = opponentChoice(page, 'P2');
  await passStackUntil(page, firstChoice);
  await expectOpponentMenu(page, SPIRIT_PROMPT);
  await expect(seatSpirits(page, 'own')).toHaveCount(0);

  await firstChoice.click();
  await expectSpiritTriplets(page);

  // {3}{W} really left the lands: all four Plains tapped and stacked as one group.
  await expect(humanPermanent(page, 'Plains').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Plains').locator('.stack-count-badge')).toHaveText('×4');

  // The second question is fresh and independent — and the opponent that just made Spirits with
  // us is still on the menu, because the printed text lets it answer both.
  const secondChoice = opponentChoice(page, 'P3');
  await expect(secondChoice).toBeVisible();
  await expectOpponentMenu(page, LIFE_PROMPT);

  await secondChoice.click();

  // "You gain 2 life for each creature you control": four creatures for you (your own plus the
  // three Spirits just made) and two for P3. P2 and P4 held nobody's choice, so neither moves.
  await expect(seatLife(page, 'own')).toHaveText('48');
  await expect(seatLife(page, 'P2')).toHaveText('40');
  await expect(seatLife(page, 'P3')).toHaveText('44');
  await expect(seatLife(page, 'P4')).toHaveText('40');
  await expectSpiritTriplets(page);

  // The source is an instant: it is gone from hand and never became a permanent, and the run
  // stopped in the precombat priority window it resolved in — the unused witness is still
  // castable there, which is the proof that priority really is still open.
  await expect(handCard(page, OFFERING)).toHaveCount(0);
  await expect(handCard(page, OFFERING_WITNESS)).toHaveClass(/actionable/);
  await expect(humanPermanent(page, OFFERING)).toHaveCount(0);

  // Ownership is not drawn on any panel, so it is read from the very frames the panels were
  // rendered from: each creator owns and controls its own three, and nobody lost.
  const settled = await wireBoardWhere(
    boards,
    (board) =>
      board.battlefield.filter((entry) => entry.name === OFFERING_SPIRIT).length === 6 &&
      board.seats.find((seat) => seat.seat === 'P1')!.life === 48,
    'the published board carries all six Spirits and the settled life totals',
  );
  const spirits = settled.battlefield.filter((entry) => entry.name === OFFERING_SPIRIT);
  expect(
    spirits.map((entry) => `${entry.owner}/${entry.controller}/${entry.tapped}`).sort(),
  ).toEqual([
    'P1/P1/false',
    'P1/P1/false',
    'P1/P1/false',
    'P2/P2/false',
    'P2/P2/false',
    'P2/P2/false',
  ]);
  expect(spirits.every((entry) => entry.power === 1 && entry.toughness === 1)).toBe(true);
  expect(spirits.every((entry) => entry.keywords.includes('flying'))).toBe(true);
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}:${seat.hasLost}`)).toEqual([
    'P1:48:false',
    'P2:40:false',
    'P3:44:false',
    'P4:40:false',
  ]);
  // The pre-existing board never moved: only tokens were added.
  expect(
    settled.battlefield.filter((entry) => entry.name === OFFERING_P4_NONCREATURE),
  ).toHaveLength(1);

  // The public log narrates the cast and both life gains. The two opponent choices themselves have
  // no formatter — they are read from the panel above, never invented as log lines.
  const lines = await logLines(page);
  expect(
    indexOfLine(lines, new RegExp(`^Cast ${OFFERING} \\(\\{3\\}\\{W\\}\\)$`)),
  ).toBeGreaterThanOrEqual(0);
  expect(indexOfLine(lines, /gains 8 life/)).toBeGreaterThanOrEqual(0);
  expect(indexOfLine(lines, /gains 4 life/)).toBeGreaterThanOrEqual(0);
});

test('Benevolent Offering: choose the same opponent twice, for the Spirits and for the life', async ({
  page,
}) => {
  const boards = recordPlayerBoards(page);
  await runScenario(
    page,
    'Benevolent Offering: choose the same opponent twice, for the Spirits and for the life',
  );
  await expectOfferingArrangement(page);

  await castOffering(page);

  const firstChoice = opponentChoice(page, 'P2');
  await passStackUntil(page, firstChoice);
  await expectOpponentMenu(page, SPIRIT_PROMPT);
  await firstChoice.click();
  await expectSpiritTriplets(page);
  await expect(humanPermanent(page, 'Plains').locator('.stack-count-badge')).toHaveText('×4');

  // P2 answers the second question too. That is what the printed text allows, and it is the only
  // difference between this run and the other one.
  const secondChoice = opponentChoice(page, 'P2');
  await expect(secondChoice).toBeVisible();
  await expectOpponentMenu(page, LIFE_PROMPT);
  await secondChoice.click();

  // P2 now holds four creatures too — its own plus the three it just made — so both players gain 8.
  await expect(seatLife(page, 'own')).toHaveText('48');
  await expect(seatLife(page, 'P2')).toHaveText('48');
  await expect(seatLife(page, 'P3')).toHaveText('40');
  await expect(seatLife(page, 'P4')).toHaveText('40');
  await expectSpiritTriplets(page);
  await expect(handCard(page, OFFERING_WITNESS)).toHaveClass(/actionable/);

  const settled = await wireBoardWhere(
    boards,
    (board) =>
      board.battlefield.filter((entry) => entry.name === OFFERING_SPIRIT).length === 6 &&
      board.seats.find((seat) => seat.seat === 'P2')!.life === 48,
    'the published board carries all six Spirits and the settled life totals',
  );
  const spirits = settled.battlefield.filter((entry) => entry.name === OFFERING_SPIRIT);
  expect(spirits.map((entry) => `${entry.owner}/${entry.controller}`).sort()).toEqual([
    'P1/P1',
    'P1/P1',
    'P1/P1',
    'P2/P2',
    'P2/P2',
    'P2/P2',
  ]);
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}:${seat.hasLost}`)).toEqual([
    'P1:48:false',
    'P2:48:false',
    'P3:40:false',
    'P4:40:false',
  ]);
});

// --- Coverage PR08.15: Council's Judgment ---
//
// One board, two runs, and the ONLY difference is how the four votes land. The browser casts the
// printed {1}{W}{W} SORCERY out of hand, pays with the three real Plains, answers its own vote
// through the real decision panel, and the three opponent seats answer theirs through the
// scenario's deterministic seat providers.
//
// Nothing here is arranged after the fact. A vote is NOT a target, so the panel offers no target
// slot and never highlights a board, and that is also why P2's hexproof in the unanimous run costs
// the Sentinel nothing. The candidate pool is fixed when the ability resolves: the three opponents'
// NONLAND permanents, in a fixed order, with the caster's own artifact and every land excluded.

const COUNCIL = "Council's Judgment";
const COUNCIL_WITNESS = 'Lab Priority Witness';
const COUNCIL_ALPHA = 'Lab Council Alpha';
const COUNCIL_BETA = 'Lab Council Beta';
const COUNCIL_GAMMA = 'Lab Council Gamma';
const COUNCIL_RELIC = 'Lab Council Relic';
const COUNCIL_SENTINEL = 'Lab Council Warded Sentinel';
const COUNCIL_VOTE_PROMPT = "Council's Judgment: vote for a permanent P1 doesn't control.";

/** One vote option: the group carrying that permanent's card face, and its "Vote" button. */
function councilVoteOption(page: Page, name: string) {
  return page
    .locator('.decision-panel .panel-group')
    .filter({ has: page.locator('.group-card', { hasText: name }) })
    .getByRole('button', { name: 'Vote', exact: true });
}

/** The public action-log lines the council emitted, in engine order. */
function councilVoteLog(page: Page) {
  return page
    .locator('.log .line .text')
    .filter({ hasText: /^Council's Judgment: P\d votes for / });
}

/** The arranged board, asserted before anything is cast. Both runs share its shape. */
async function expectCouncilArrangement(page: Page, p2Permanent: string): Promise<void> {
  await expect(handCard(page, COUNCIL)).toBeVisible();
  await expect(handCard(page, COUNCIL_WITNESS)).toBeVisible();
  // Three identical untapped Plains render as one tile with a ×3 badge.
  await expect(humanPermanent(page, 'Plains')).toHaveCount(1);
  await expect(humanPermanent(page, 'Plains').locator('.stack-count-badge')).toHaveText('×3');
  await expect(humanPermanent(page, 'Plains').locator('.tile')).not.toHaveClass(/tapped/);
  // The caster's OWN nonland permanent is on the board and is never a legal vote.
  await expect(humanPermanent(page, COUNCIL_RELIC)).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', p2Permanent)).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', 'Forest')).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', COUNCIL_BETA)).toHaveCount(1);
  await expect(seatPermanent(page, 'P4', COUNCIL_GAMMA)).toHaveCount(1);
  for (const seat of ['own', 'P2', 'P3', 'P4'] as const)
    await expect(seatLife(page, seat)).toHaveText('40');
  // The spell starts in hand, never on the battlefield.
  await expect(humanPermanent(page, COUNCIL)).toHaveCount(0);
}

/** Cast the printed sorcery the ordinary way and pay it with the three Plains. */
async function castCouncil(page: Page): Promise<void> {
  const card = handCard(page, COUNCIL);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  // The real payment preview for the printed {1}{W}{W}; the multiplication sign is U+00D7.
  await expect(page.getByText(/Auto-pay: Plains ×3/)).toBeVisible();
  // A non-targeting sorcery offers no target slot at all.
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  await confirm(page);
}

/**
 * The one real vote menu P1 is asked for: exactly the printed prompt, exactly the three opponent
 * nonland permanents, one "Vote" button each, and neither a target slot nor an abstain option.
 */
async function expectCouncilVotePanel(page: Page, candidates: string[]): Promise<void> {
  await expect(page.locator('.decision-panel .panel-prompt')).toHaveText(COUNCIL_VOTE_PROMPT);
  const panel = page.locator('.decision-panel');
  await expect(panel.locator('.panel-group')).toHaveCount(candidates.length);
  await expect(panel.getByRole('button', { name: 'Vote', exact: true })).toHaveCount(
    candidates.length,
  );
  await expect(panel.locator('.group-card')).toHaveCount(candidates.length);
  for (const name of candidates) {
    await expect(panel.locator('.group-card').filter({ hasText: name })).toHaveCount(1);
  }
  // Nobody may abstain and nothing is a target: no such buttons, no target slot, no highlighting.
  await expect(panel.getByRole('button', { name: /abstain|skip|choose none/i })).toHaveCount(0);
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  await expect(page.getByText(/All \d+ targets? selected/)).toHaveCount(0);
  await expect(page.locator('.human-zone > header')).not.toHaveClass(/targetable/);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).not.toHaveClass(/targetable/);
  // The caster's own nonland permanent and every land are absent from the pool.
  await expect(panel.locator('.group-card').filter({ hasText: COUNCIL_RELIC })).toHaveCount(0);
  await expect(panel.locator('.group-card').filter({ hasText: /Plains|Forest/ })).toHaveCount(0);
}

test("Council's Judgment: tied votes exile both winners and spare the unvoted permanent", async ({
  page,
}) => {
  const title = "Council's Judgment: tied votes exile both winners and spare the unvoted permanent";
  const boards = recordPlayerBoards(page);
  await runScenario(page, title);
  await expectCouncilArrangement(page, COUNCIL_ALPHA);

  await castCouncil(page);

  // "Starting with you": P1 is asked FIRST, on the same pool as everybody else, and nothing has
  // left while the question is still open — not even after the earlier seats would have voted.
  const voteForAlpha = councilVoteOption(page, COUNCIL_ALPHA);
  await passStackUntil(page, voteForAlpha);
  await expectCouncilVotePanel(page, [COUNCIL_ALPHA, COUNCIL_BETA, COUNCIL_GAMMA]);
  await expect(councilVoteLog(page)).toHaveCount(0);
  await expect(seatPermanent(page, 'P2', COUNCIL_ALPHA)).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', COUNCIL_BETA)).toHaveCount(1);
  await expect(seatPermanent(page, 'P4', COUNCIL_GAMMA)).toHaveCount(1);
  // {1}{W}{W} really left the lands: all three Plains tapped and stacked as one group.
  await expect(humanPermanent(page, 'Plains').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Plains').locator('.stack-count-badge')).toHaveText('×3');
  await voteForAlpha.click();

  // P2 votes Alpha too and P3/P4 both vote Beta, so the tally is 2:2:0. Every one of the four votes
  // is public and public means public: the whole log is on P1's own screen.
  await expect(councilVoteLog(page)).toHaveText([
    `${COUNCIL}: P1 votes for ${COUNCIL_ALPHA}`,
    `${COUNCIL}: P2 votes for ${COUNCIL_ALPHA}`,
    `${COUNCIL}: P3 votes for ${COUNCIL_BETA}`,
    `${COUNCIL}: P4 votes for ${COUNCIL_BETA}`,
  ]);

  // "or tied for most votes": BOTH tied winners leave. The permanent nobody voted for stays.
  await expect(seatPermanent(page, 'P2', COUNCIL_ALPHA)).toHaveCount(0);
  await expect(seatPermanent(page, 'P3', COUNCIL_BETA)).toHaveCount(0);
  await expect(seatPermanent(page, 'P4', COUNCIL_GAMMA)).toHaveCount(1);
  await expect(humanPermanent(page, COUNCIL_RELIC)).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', 'Forest')).toHaveCount(1);

  // The source is a sorcery: it is gone from hand and never became a permanent, and the run
  // stopped in the priority window it resolved in — the unused witness is still castable there,
  // which is the proof that priority really is still open.
  await expect(handCard(page, COUNCIL)).toHaveCount(0);
  await expect(humanPermanent(page, COUNCIL)).toHaveCount(0);
  await expect(handCard(page, COUNCIL_WITNESS)).toHaveClass(/actionable/);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(seatLife(page, 'P2')).toHaveText('40');
  await expect(seatLife(page, 'P3')).toHaveText('40');
  await expect(seatLife(page, 'P4')).toHaveText('40');

  // The settled board the panels were rendered from carries exactly the two departures, so the
  // exiles are a real published zone change rather than a rendering of a local guess.
  const settled = await wireBoardWhere(
    boards,
    (board) =>
      !board.battlefield.some((entry) => entry.name === COUNCIL_ALPHA) &&
      !board.battlefield.some((entry) => entry.name === COUNCIL_BETA) &&
      board.battlefield.some((entry) => entry.name === COUNCIL_GAMMA),
    'the published board carries both exiled winners and the unvoted bystander',
  );
  expect(permanentOn(settled, COUNCIL_GAMMA)).toMatchObject({ owner: 'P4', controller: 'P4' });
  expect(permanentOn(settled, COUNCIL_RELIC)).toMatchObject({ owner: 'P1', controller: 'P1' });
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}:${seat.hasLost}`)).toEqual([
    'P1:40:false',
    'P2:40:false',
    'P3:40:false',
    'P4:40:false',
  ]);
  expect(
    indexOfLine(await logLines(page), /^Cast Council's Judgment \(\{1\}\{W\}\{W\}\)$/),
  ).toBeGreaterThanOrEqual(0);
});

test("Council's Judgment: unanimous votes exile a creature with hexproof", async ({ page }) => {
  const title = "Council's Judgment: unanimous votes exile a creature with hexproof";
  const boards = recordPlayerBoards(page);
  await runScenario(page, title);
  await expectCouncilArrangement(page, COUNCIL_SENTINEL);

  // The hexproof permanent is a real printed 0/3 with both printed keywords rendered.
  const sentinel = seatPermanent(page, 'P2', COUNCIL_SENTINEL);
  await expect(sentinel).toHaveCount(1);
  await expect(sentinel.locator('.pt')).toHaveText('0/3');
  await expect(sentinel.locator('.keywords[title*="defender"]')).toHaveCount(1);
  await expect(sentinel.locator('.keywords[title*="hexproof"]')).toHaveCount(1);

  await castCouncil(page);

  // A vote is not a target, so hexproof removes no option: the Sentinel is simply on the menu.
  const voteForSentinel = councilVoteOption(page, COUNCIL_SENTINEL);
  await passStackUntil(page, voteForSentinel);
  await expectCouncilVotePanel(page, [COUNCIL_SENTINEL, COUNCIL_BETA, COUNCIL_GAMMA]);
  await expect(councilVoteLog(page)).toHaveCount(0);
  await expect(seatPermanent(page, 'P2', COUNCIL_SENTINEL)).toHaveCount(1);
  await expect(humanPermanent(page, 'Plains').locator('.tile')).toHaveClass(/tapped/);
  await voteForSentinel.click();

  await expect(councilVoteLog(page)).toHaveText([
    `${COUNCIL}: P1 votes for ${COUNCIL_SENTINEL}`,
    `${COUNCIL}: P2 votes for ${COUNCIL_SENTINEL}`,
    `${COUNCIL}: P3 votes for ${COUNCIL_SENTINEL}`,
    `${COUNCIL}: P4 votes for ${COUNCIL_SENTINEL}`,
  ]);

  // 4:0:0 — only the unanimous winner has "the most votes", and only it leaves. Every zero-vote
  // bystander, the caster's own permanent and all four lands stay exactly where they were.
  await expect(seatPermanent(page, 'P2', COUNCIL_SENTINEL)).toHaveCount(0);
  await expect(seatPermanent(page, 'P3', COUNCIL_BETA)).toHaveCount(1);
  await expect(seatPermanent(page, 'P4', COUNCIL_GAMMA)).toHaveCount(1);
  await expect(humanPermanent(page, COUNCIL_RELIC)).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', 'Forest')).toHaveCount(1);
  await expect(handCard(page, COUNCIL)).toHaveCount(0);
  await expect(handCard(page, COUNCIL_WITNESS)).toHaveClass(/actionable/);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');

  const settled = await wireBoardWhere(
    boards,
    (board) =>
      !board.battlefield.some((entry) => entry.name === COUNCIL_SENTINEL) &&
      board.battlefield.some((entry) => entry.name === COUNCIL_BETA),
    'the published board carries the unanimously exiled Sentinel and its zero-vote bystanders',
  );
  expect(permanentOn(settled, COUNCIL_BETA)).toMatchObject({ owner: 'P3', controller: 'P3' });
  expect(permanentOn(settled, COUNCIL_GAMMA)).toMatchObject({ owner: 'P4', controller: 'P4' });
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}:${seat.hasLost}`)).toEqual([
    'P1:40:false',
    'P2:40:false',
    'P3:40:false',
    'P4:40:false',
  ]);
});

// --- Coverage PR08.13: Agitator Ant ---
//
// One board, two runs. "Each player may put two +1/+1 counters on a creature they control. Goad
// each creature that had counters put on it this way." is ONE resolution-time choice set in APNAP
// order, so the board is arranged to make every half of it observable: the browser casts the
// printed {2}{R} creature out of hand and pays it with the Mountain and two Forests; P2 controls
// one ordinary 2/2 Bear, P3 another, and P4 controls nothing at all.
//
// The counters are read from the board itself (a `+1/+1×2` badge and a 4/4 P/T), and the GOAD is
// read from the only place the viewer can show it: on P2's own turn the goaded Bear must attack
// another player, and it does. The published board projection carries no goad field, so nothing
// here asserts one — that would be inventing a wire fact.
//
// The three choice menus are resolution choices, never targets: the panel must offer no target
// slot, must highlight no board panel, and must name only the chooser's OWN creatures.

const ANT = 'Agitator Ant';
const ANT_WITNESS = 'Lab Ant Priority Witness';
const ANT_P2_BEAR = 'Lab Ant Bear';
const ANT_P3_CUB = 'Lab Ant Cub';
const ANT_ASK = 'put 2 +1/+1 counters on a creature you control, or put none.';

/** The arranged board, asserted before anything is cast. */
async function expectAntArrangement(page: Page): Promise<void> {
  await expect(handCard(page, ANT)).toBeVisible();
  await expect(handCard(page, ANT_WITNESS)).toBeVisible();
  await expect(humanPermanent(page, ANT)).toHaveCount(0);
  // Two identical Forests render as one tile with a ×2 badge.
  await expect(humanPermanent(page, 'Forest')).toHaveCount(1);
  await expect(humanPermanent(page, 'Forest').locator('.stack-count-badge')).toHaveText('×2');
  await expect(humanPermanent(page, 'Mountain')).toHaveCount(1);
  await expect(seatPermanent(page, 'P2', ANT_P2_BEAR)).toHaveCount(1);
  await expect(seatPermanent(page, 'P3', ANT_P3_CUB)).toHaveCount(1);
  // P4 deliberately controls no creature.
  await expect(page.locator('.opponent[data-seat="P4"] .object')).toHaveCount(0);
  for (const seat of ['own', 'P2', 'P3', 'P4'] as const)
    await expect(seatLife(page, seat)).toHaveText('40');
}

/** P1's own Ant menu: its own creature only, a decline, and never a target slot. */
async function expectOwnAntMenu(page: Page): Promise<void> {
  const panel = page.locator('.decision-panel');
  await expect(panel.locator('.panel-prompt')).toContainText(ANT_ASK);
  // No target slots and no selection counter: this is a resolution choice, not a target.
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  await expect(page.getByText(/All \d+ targets? selected/)).toHaveCount(0);
  // Nothing on the board is highlighted as a legal target, on either side of the table.
  await expect(page.locator('.human-zone > header')).not.toHaveClass(/targetable/);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(page.locator(`.opponent[data-seat="${seat}"]`)).not.toHaveClass(/targetable/);
  // Only your OWN creatures are named — never an opponent's — plus the printed decline.
  // Read the name label without the card-art fallback's initials.
  await expect(panel.locator('.group-card > span')).toHaveText([ANT]);
  await expect(page.getByRole('button', { name: 'Put no counters', exact: true })).toHaveCount(1);
}

test('Agitator Ant: accepting counters goads the chosen creatures', async ({ page }) => {
  const boards = recordPlayerBoards(page);
  await runScenario(page, 'Agitator Ant: accepting counters goads the chosen creatures');
  await expectAntArrangement(page);

  // Cast the printed {2}{R} creature the ordinary way. It has no targets, so no target slot.
  await castPr08Card(page, ANT);
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  const ant = humanPermanent(page, ANT);
  await passStackUntil(page, ant);
  await expect(humanPermanent(page, 'Mountain').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Forest').locator('.tile')).toHaveClass(/tapped/);
  await expect(humanPermanent(page, 'Forest').locator('.stack-count-badge')).toHaveText('×2');
  // It enters as an ordinary 2/2: no counters and nothing goaded yet.
  await expect(ant.locator('.pt')).toHaveText('2/2');
  await expect(ant.getByText(/\+1\/\+1/)).toHaveCount(0);

  // Your own end step asks you. The trigger reached the menu through the ordinary end step.
  const chooseAnt = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: ANT })
    .getByRole('button', { name: 'Choose', exact: true });
  await passUntil(page, chooseAnt);
  await expectOwnAntMenu(page);
  await expect(ant.getByText(/\+1\/\+1/)).toHaveCount(0);
  await chooseAnt.click();

  // P2's and P3's choices are their own private menus: this seat never sees either, and nothing
  // moves until the last of the three choices exists.
  await expect(ant.locator('.counters')).toHaveText('+1/+1×2');
  // Both placements really landed, and the goad really went on: Agitator Ant and P2's Bear are
  // 4/4s, while P3's declining Cub is untouched.
  await expect(ant.locator('.pt')).toHaveText('4/4');
  await expect(seatPermanent(page, 'P2', ANT_P2_BEAR).locator('.pt')).toHaveText('4/4');
  await expect(seatPermanent(page, 'P2', ANT_P2_BEAR).locator('.counters')).toHaveText('+1/+1×2');
  await expect(seatPermanent(page, 'P3', ANT_P3_CUB).locator('.pt')).toHaveText('2/2');
  await expect(seatPermanent(page, 'P3', ANT_P3_CUB).getByText(/\+1\/\+1/)).toHaveCount(0);
  // No opponent menu was ever shown to this seat: P2 and P3 answered their own choices.
  await expect(page.locator('.decision-panel .group-player')).toHaveCount(0);

  // The choices are public: yours and P2's, each with its own chooser, P3's decline published as
  // a decline. The asking source is the whole stack entry, so the lines are matched on their tail.
  const lines = await logLines(page);
  expect(
    lines.filter((line) =>
      /^Agitator Ant — At the beginning of your end step.*: chooses Agitator Ant$/.test(
        line.trim(),
      ),
    ),
    'your own choice is public',
  ).toHaveLength(1);
  expect(
    lines.filter((line) =>
      new RegExp(
        `^Agitator Ant — At the beginning of your end step.*: chooses ${ANT_P2_BEAR}$`,
      ).test(line.trim()),
    ),
    "P2's choice is public",
  ).toHaveLength(1);
  expect(
    lines.filter((line) =>
      /^Agitator Ant — At the beginning of your end step.*: chooses no permanent$/.test(
        line.trim(),
      ),
    ),
    "P3's decline is public too",
  ).toHaveLength(1);

  // P2's real turn follows: the cleanup step does not end a goad, so its Bear must attack — and
  // it must attack a player other than you.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(seatLife(page, 'own')).toHaveText('40');
  await expect(seatLife(page, 'P2')).toHaveText('40');
  await expect(seatLife(page, 'P3')).toHaveText('36');
  await expect(seatLife(page, 'P4')).toHaveText('40');
  const finished = await logLines(page);
  expect(
    finished.filter((line) => /attacks with 1 creature/.test(line)),
    'exactly one combat, and it was the goaded Bear',
  ).toHaveLength(1);

  // The counters and the 4/4 statistics outlived the cleanup step and the combat.
  await expect(ant.locator('.pt')).toHaveText('4/4');
  await expect(ant.locator('.counters')).toHaveText('+1/+1×2');
  await expect(seatPermanent(page, 'P2', ANT_P2_BEAR).locator('.pt')).toHaveText('4/4');
  // The published board carries the counters and never a goad field; the forced attack above is
  // the goad's public proof.
  const settled = await wireBoardWhere(
    boards,
    (board) => board.battlefield.some((entry) => entry.name === ANT && entry.power === 4),
    'the published board carries the counters as effective statistics',
  );
  expect(
    settled.battlefield
      .filter((entry) => entry.power !== null)
      .map(
        (entry) =>
          `${entry.name}/${entry.controller}/${entry.power}/${entry.counters['+1/+1'] ?? 0}`,
      )
      .sort(),
  ).toEqual([`${ANT}/P1/4/2`, `${ANT_P2_BEAR}/P2/4/2`, `${ANT_P3_CUB}/P3/2/0`].sort());
  // The three arranged lands are still there, still P1's, and still carry no counters.
  expect(settled.battlefield.filter((entry) => entry.name === 'Forest')).toHaveLength(2);
  expect(
    settled.battlefield
      .filter((entry) => entry.name === 'Forest' || entry.name === 'Mountain')
      .every((land) => land.controller === 'P1' && land.power === null),
  ).toBe(true);
  expect(
    settled.battlefield.some((entry) => Object.keys(entry).some((key) => key.includes('goad'))),
  ).toBe(false);
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}`)).toEqual([
    'P1:40',
    'P2:40',
    'P3:36',
    'P4:40',
  ]);
  // Nobody's hidden cards crossed the wire: the only new names are the arranged board's.
  expect(settled.battlefield.some((entry) => entry.name === ANT_WITNESS)).toBe(false);
  // The run finished: nothing is left on offer, and no opponent menu was ever rendered here.
  await expectOwnAntMenuIsGone(page);
  await expect(page.locator('.decision-panel .group-player')).toHaveCount(0);
});

/** After the choice resolves the panel is gone; the next thing on offer is ordinary priority. */
async function expectOwnAntMenuIsGone(page: Page): Promise<void> {
  await expect(page.locator('.decision-panel')).toHaveCount(0);
}

test('Agitator Ant: declining counters leaves its creature ungoaded', async ({ page }) => {
  const boards = recordPlayerBoards(page);
  await runScenario(page, 'Agitator Ant: declining counters leaves its creature ungoaded');
  await expectAntArrangement(page);

  await castPr08Card(page, ANT);
  await expect(page.getByText(/Target \d of \d/)).toHaveCount(0);
  const ant = humanPermanent(page, ANT);
  await passStackUntil(page, ant);
  await expect(ant.locator('.pt')).toHaveText('2/2');

  // The same menu, on the same board: the printed choice is optional, and declining is a real
  // answer to it rather than a skipped screen.
  const decline = page.getByRole('button', { name: 'Put no counters', exact: true });
  await passUntil(page, decline);
  await expectOwnAntMenu(page);
  await decline.click();

  // Nothing was placed and nothing was goaded — including on your own Ant, and including on P2's
  // and P3's creatures, whose own seats declined as well.
  await expect(ant.getByText(/\+1\/\+1/)).toHaveCount(0);
  await expect(ant.locator('.pt')).toHaveText('2/2');
  for (const seat of ['P2', 'P3'] as const) {
    const bystander = seatPermanent(page, seat, seat === 'P2' ? ANT_P2_BEAR : ANT_P3_CUB);
    await expect(bystander.locator('.pt')).toHaveText('2/2');
    await expect(bystander.getByText(/\+1\/\+1/)).toHaveCount(0);
  }
  const lines = await logLines(page);
  expect(
    lines.filter((line) =>
      /^Agitator Ant — At the beginning of your end step.*: chooses no permanent$/.test(
        line.trim(),
      ),
    ),
    'all three declines are public',
  ).toHaveLength(3);

  // P2's turn follows and nothing is forced: an un-goaded Bear may stay home, and nobody loses
  // life. P2's own end step is not "your end step", so the Ant never triggers a second time.
  await passUntil(page, page.getByText(/game over/i).first());
  for (const seat of ['own', 'P2', 'P3', 'P4'] as const)
    await expect(seatLife(page, seat)).toHaveText('40');
  const finished = await logLines(page);
  expect(
    finished.filter((line) => /attacks with/.test(line)),
    'no combat at all',
  ).toHaveLength(0);
  expect(
    finished.filter((line) =>
      /^Agitator Ant — At the beginning of your end step.*resolves$/.test(line.trim()),
    ),
    'the Ant resolved exactly once',
  ).toHaveLength(1);

  const settled = await wireBoardWhere(
    boards,
    (board) => board.seats.find((seat) => seat.seat === 'P3')?.life === 40,
    'the published board carries the settled life totals',
  );
  expect(
    settled.battlefield
      .filter((entry) => entry.power !== null)
      .map(
        (entry) =>
          `${entry.name}/${entry.power}/${entry.toughness}/${entry.counters['+1/+1'] ?? 0}`,
      )
      .sort(),
  ).toEqual([`${ANT}/2/2/0`, `${ANT_P2_BEAR}/2/2/0`, `${ANT_P3_CUB}/2/2/0`].sort());
  expect(settled.seats.map((seat) => `${seat.seat}:${seat.life}`)).toEqual([
    'P1:40',
    'P2:40',
    'P3:40',
    'P4:40',
  ]);
  // The run finished with nothing on offer, and no opponent menu was ever rendered for this seat.
  await expectOwnAntMenuIsGone(page);
  await expect(page.locator('.decision-panel .group-player')).toHaveCount(0);
});
