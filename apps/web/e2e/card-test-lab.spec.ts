import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { SPELL_FACE_LAB_EXPECTATIONS } from '../../../packages/server/src/cards/spell-face-lab-expectations';
import { TRANSFORMED_DFC_SCENARIO_IDS } from '../../../packages/server/src/cards/transformed-dfc-scenarios';
import { PR02_FOLLOW_UP_SCENARIO_IDS } from '../../../packages/server/src/cards/pr02-follow-up-scenarios';
import { PR11B_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr11b-scenario-catalog';
import { PR11_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr11-scenario-catalog';
import { PR13_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr13-scenario-catalog';
import { RUNNER_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/runner-scenario-catalog';
import { PR12_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr12-scenario-catalog';
import { PR10_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr10-scenario-catalog';
import { PR09_ALL_SCENARIO_IDS } from '../../../packages/server/src/cards/pr09-scenario-catalog';
import { PR08_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-scenario-catalog';
import { COMBAT_TRIGGER_SCENARIO_IDS } from '../../../packages/server/src/cards/combat-trigger-scenarios';
import { DRAKUSETH_WORDING_SCENARIO_IDS } from '../../../packages/server/src/cards/drakuseth-wording-scenarios';
import { WHITE_BLACK_COMBAT_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-combat-scenarios';
import { WHITE_BLACK_HAND_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-hand-scenarios';
import { WHITE_BLACK_ENTRY_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-entry-scenarios';
import { WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-discard-extension-scenarios';
import { WHITE_BLACK_DEFENDER_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-defender-scenarios';
import { WHITE_BLACK_SPELL_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-spell-scenarios';
import { WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-counter-class-scenarios';
import { WHITE_BLACK_FINAL_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-final-scenarios';
import { WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-perch-scenarios';
import { WHITE_BLACK_PROTECTION_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-protection-scenarios';
import { WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-discard-core-scenarios';
import { WHITE_BLACK_GRAVEYARD_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-graveyard-scenarios';
import { WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-stax-scenarios';
import { WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-replacements-scenarios';
import { WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-liliana-scenarios';
import { WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-remaining-combat-scenarios';
import { WHITE_BLACK_TERGRID_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-tergrid-scenarios';
import { WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-hand-limit-scenarios';
import { WHITE_BLACK_KEYWORD_SCENARIO_IDS } from '../../../packages/server/src/cards/white-black-control-keyword-scenarios';
const SPELL_FACE_VIEWER_PINS = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/selected-spell-faces-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
/**
 * Card Test Lab viewer verification (implementation plan step 12).
 *
 * Unlike the audit smoke spec, nothing here is mocked: the spec drives the real Vite frontend
 * against the real lab backend (`serve.ts --card-test-lab`) over the production WebSocket
 * protocol. Traces and screenshots are retained for every run so the evidence is tied to the
 * tested revision, per docs/guides/card-modeling-and-testing.md.
 *
 * The lab backend holds a single live session, so these tests run serially.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  ServerToClientMessage,
  SpectatorPermanent,
  PlayerBoardState,
  SpectatorState,
} from '@mtg/shared';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const catalogScenarioIds = new Set<string>();
const exercisedScenarioIds = new Set<string>();

test.afterAll(() => {
  expect([...exercisedScenarioIds].sort()).toEqual([...catalogScenarioIds].sort());
});

/** The player options live in the Settings menu: open it, set one, and close it again. */
async function setPlayerOption(page: Page, label: string, checked: boolean): Promise<void> {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  await page.getByLabel(label).setChecked(checked);
  await settings.click();
}

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  const optionIds = await picker
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(optionIds.length).toBeGreaterThan(0);
  if (catalogScenarioIds.size === 0) {
    // These scenarios have independent assertions and retained traces in transformed-dfc-copy.spec.ts.
    for (const scenarioId of optionIds)
      if (
        !PR08_SCENARIO_IDS.includes(scenarioId) &&
        !PR09_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !PR10_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !PR11_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !PR13_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !RUNNER_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !PR12_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !PR11B_ALL_SCENARIO_IDS.includes(scenarioId) &&
        !TRANSFORMED_DFC_SCENARIO_IDS.includes(scenarioId) &&
        !(COMBAT_TRIGGER_SCENARIO_IDS as readonly string[]).includes(scenarioId) &&
        !(DRAKUSETH_WORDING_SCENARIO_IDS as readonly string[]).includes(scenarioId) &&
        !WHITE_BLACK_COMBAT_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_HAND_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_ENTRY_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_DEFENDER_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_SPELL_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_FINAL_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS.some((id) => id === scenarioId) &&
        !WHITE_BLACK_PROTECTION_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_GRAVEYARD_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_TERGRID_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS.includes(scenarioId) &&
        !WHITE_BLACK_KEYWORD_SCENARIO_IDS.includes(scenarioId) &&
        !PR02_FOLLOW_UP_SCENARIO_IDS.includes(
          scenarioId as (typeof PR02_FOLLOW_UP_SCENARIO_IDS)[number],
        )
      )
        catalogScenarioIds.add(scenarioId);
  } else {
    expect(
      optionIds
        .filter(
          (id) =>
            !PR08_SCENARIO_IDS.includes(id) &&
            !PR09_ALL_SCENARIO_IDS.includes(id) &&
            !PR10_ALL_SCENARIO_IDS.includes(id) &&
            !PR11_ALL_SCENARIO_IDS.includes(id) &&
            !PR13_ALL_SCENARIO_IDS.includes(id) &&
            !RUNNER_ALL_SCENARIO_IDS.includes(id) &&
            !PR12_ALL_SCENARIO_IDS.includes(id) &&
            !PR11B_ALL_SCENARIO_IDS.includes(id) &&
            !TRANSFORMED_DFC_SCENARIO_IDS.includes(id) &&
            !(COMBAT_TRIGGER_SCENARIO_IDS as readonly string[]).includes(id) &&
            !(DRAKUSETH_WORDING_SCENARIO_IDS as readonly string[]).includes(id) &&
            !WHITE_BLACK_COMBAT_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_HAND_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_ENTRY_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_DEFENDER_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_SPELL_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_FINAL_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS.some((perchId) => perchId === id) &&
            !WHITE_BLACK_PROTECTION_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_GRAVEYARD_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_TERGRID_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS.includes(id) &&
            !WHITE_BLACK_KEYWORD_SCENARIO_IDS.includes(id) &&
            !PR02_FOLLOW_UP_SCENARIO_IDS.includes(
              id as (typeof PR02_FOLLOW_UP_SCENARIO_IDS)[number],
            ),
        )
        .sort(),
    ).toEqual([...catalogScenarioIds].sort());
  }
  await picker.selectOption({ label: title });
  const scenarioId = await picker.inputValue();
  expect(optionIds).toContain(scenarioId);
  expect(exercisedScenarioIds.has(scenarioId), `${scenarioId} was selected more than once`).toBe(
    false,
  );
  exercisedScenarioIds.add(scenarioId);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function permanent(page: Page, name: string) {
  // Live player chips wrap PermanentChip in `.object`. Game-over swaps to spectator SeatPanel,
  // whose battlefield chips are `.seat .tile` with no `.object` ancestor — so a `.object`-only
  // locator would report 0 after unique-pass even if the permanent was still on the board.
  // Vue retains departed objects during leave transitions. They are no longer current game
  // objects, and can share a card name with a newly returned incarnation.
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm' }).click();
}

async function verifyOptionalLife(
  page: Page,
  title: string,
  life: number,
  counters: number,
  payments: number,
  response: 'Ghostly Flicker' | 'Murder' | null = null,
  decline = false,
) {
  const states: (PlayerBoardState | SpectatorState)[] = [];
  let requestId = '';
  let offeredTypes: string[] = [];
  let offeredDescriptions: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        states.push(frame.payload.state);
      if (frame.type === 'playerActionRequired') {
        requestId = frame.payload.request.requestId;
        offeredTypes = frame.payload.request.legalActions.map((action) => action.type);
        offeredDescriptions = frame.payload.request.legalActions.map(
          (action) => action.description,
        );
        states.push(frame.payload.state);
      }
    }),
  );
  await runScenario(page, title);
  await handCard(page, 'Optional-Life Witness').click();
  const castRequestId = requestId;
  await confirm(page);
  await expect
    .poll(
      async () =>
        requestId !== castRequestId ||
        (await page
          .getByText(/game over/i)
          .first()
          .isVisible()),
    )
    .toBe(true);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
  const over = page.getByText(/game over/i).first();
  const pay = page.getByRole('button', { name: 'Pay 2 life and add 2 counter(s)', exact: true });
  let responded = false;
  let choices = 0;
  let originalId: string | undefined;
  for (let count = 0; count < 24; count++) {
    await expect
      .poll(
        async () =>
          (await over.isVisible()) ||
          (offeredDescriptions.includes('Pay 2 life and add 2 counter(s)') &&
            (await pay.isVisible())) ||
          (offeredTypes.includes('pass') && (await pass.isVisible())),
      )
      .toBe(true);
    if (await over.isVisible()) break;
    const witness = states
      .at(-1)
      ?.battlefield.find((card) => card.name === 'Optional-Life Witness');
    originalId ??= witness?.id;
    if (response !== null && !responded && witness !== undefined && (await pass.isVisible())) {
      await handCard(page, response).click();
      if (response === 'Murder') {
        await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
        await permanent(page, 'Optional-Life Witness').click();
      }
      await confirm(page);
      if (response === 'Ghostly Flicker') {
        await expect(page.getByText('Choose target 1 for ability', { exact: true })).toBeVisible();
        await page
          .getByRole('button', { name: 'Target Optional-Life Witness', exact: true })
          .click();
        await expect(page.getByText('Choose target 2 for ability', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Target Island', exact: true }).first().click();
      }
      responded = true;
      continue;
    }
    const before = requestId;
    if (offeredDescriptions.includes('Pay 2 life and add 2 counter(s)')) {
      choices++;
      await (decline ? page.getByRole('button', { name: 'Decline', exact: true }) : pay).click();
    } else {
      await pass.click();
      await expect
        .poll(
          async () =>
            requestId !== before || (await over.isVisible()) || (await passAnyway.isVisible()),
        )
        .toBe(true);
      if (await passAnyway.isVisible()) await passAnyway.click();
    }
    await expect.poll(async () => requestId !== before || (await over.isVisible())).toBe(true);
  }
  await expect(over).toBeVisible({ timeout: 15_000 });
  expect(choices).toBe(payments);
  expect(responded).toBe(response !== null);
  const final = states.at(-1)!;
  expect(final.seats.find((seat) => seat.seat === 'P1')!.life).toBe(life);
  const witness = final.battlefield.find((card) => card.name === 'Optional-Life Witness');
  if (response === 'Murder') {
    expect(witness).toBeUndefined();
    await expect(permanent(page, 'Optional-Life Witness')).toHaveCount(0);
  } else {
    expect(witness).toBeDefined();
    expect(witness!.counters['+1/+1'] ?? 0).toBe(counters);
    await expect(permanent(page, 'Optional-Life Witness')).toContainText(
      counters === 2 ? '4/4' : '2/2',
    );
    if (response === 'Ghostly Flicker') expect(witness!.id).not.toBe(originalId);
  }
  await expect(permanent(page, 'Madame Null, Power Broker')).toBeVisible();
}

test('Madame Null: pay life for the entering creature', async ({ page }) => {
  await verifyOptionalLife(page, 'Madame Null: pay life for the entering creature', 38, 2, 1);
});
test('Madame Null: decline the life payment', async ({ page }) => {
  await verifyOptionalLife(page, 'Madame Null: decline the life payment', 40, 0, 1, null, true);
});
test('Madame Null: skip an unaffordable life payment', async ({ page }) => {
  await verifyOptionalLife(page, 'Madame Null: skip an unaffordable life payment', 1, 0, 0);
});
test('Madame Null: keep separate blinked incarnations', async ({ page }) => {
  await verifyOptionalLife(
    page,
    'Madame Null: keep separate blinked incarnations',
    36,
    2,
    2,
    'Ghostly Flicker',
  );
});
test("Madame Null: read the departed creature's power", async ({ page }) => {
  await verifyOptionalLife(
    page,
    "Madame Null: read the departed creature's power",
    38,
    0,
    1,
    'Murder',
  );
});

async function verifyFirstZoneReturn(
  page: Page,
  title: string,
  owner: 'P1' | 'P2',
  returns: boolean,
  exile = false,
  batch = false,
) {
  const boards: SpectatorPermanent[][] = [];
  let requestId = '';
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerActionRequired') requestId = frame.payload.request.requestId;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, title);
  await handCard(page, batch ? 'Damn' : 'Murder').click();
  if (batch) {
    await page
      .locator('.source-actions .source-action-row button')
      .filter({ hasText: /overload/i })
      .click();
    await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
  } else {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, 'First-Zone Witness').click();
  }
  await confirm(page);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const over = page.getByText(/game over/i).first();
  const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
  const order = page.getByRole('button', {
    name: /^(Marchesa, the Black Rose: Whenever|Delayed Trigger: Return that creature)/,
  });
  let bog = false;
  let ordered = 0;
  for (let count = 0; count < 16; count++) {
    await expect
      .poll(
        async () =>
          (await over.isVisible()) ||
          (await pass.isVisible()) ||
          (batch && (await order.first().isVisible())),
      )
      .toBe(true);
    if (await over.isVisible()) break;
    if (batch && (await order.first().isVisible())) {
      const before = requestId;
      await order.first().click();
      ordered++;
      await expect.poll(async () => requestId !== before || (await over.isVisible())).toBe(true);
      continue;
    }
    if (
      exile &&
      !bog &&
      !boards.at(-1)?.some((card) => card.name === 'First-Zone Witness') &&
      (await handCard(page, 'Bojuka Bog').evaluate((element) =>
        element.classList.contains('actionable'),
      ))
    ) {
      await handCard(page, 'Bojuka Bog').click();
      await expect(page.locator('.target-instruction')).toHaveText(
        'Target 1 of 1: click a highlighted card or player.',
      );
      await page.locator('.opponent[data-seat="P2"] > header').click();
      await expect(page.getByText(/All 1 target selected/)).toBeVisible();
      await confirm(page);
      bog = true;
      continue;
    }
    const before = boards.length;
    // The game can move on between seeing the button and clicking it; look again if it went.
    const clicked = await pass
      .click({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;
    await expect
      .poll(
        async () =>
          boards.length > before || (await over.isVisible()) || (await passAnyway.isVisible()),
      )
      .toBe(true);
    if (await passAnyway.isVisible()) {
      await passAnyway.click();
      await expect.poll(async () => boards.length > before || (await over.isVisible())).toBe(true);
    }
  }
  await expect(over).toBeVisible({ timeout: 15_000 });
  expect(bog).toBe(exile);
  const returned = boards.at(-1)!.find((card) => card.name === 'First-Zone Witness');
  if (returns) {
    expect(returned).toBeDefined();
    expect(returned!.owner).toBe(owner);
    expect(returned!.controller).toBe('P1');
    expect(returned!.counters).toEqual({});
    await expect(permanent(page, 'First-Zone Witness')).toContainText('2/2');
  } else {
    expect(returned).toBeUndefined();
    await expect(permanent(page, 'First-Zone Witness')).toHaveCount(0);
  }
  await expect(permanent(page, 'Marchesa, the Black Rose')).toBeVisible();
  if (batch) {
    expect(ordered).toBe(2);
    await expect(permanent(page, 'Batch No-Counter Witness')).toHaveCount(0);
    expect(
      boards.at(-1)!.find((card) => card.name === 'Marchesa, the Black Rose')!.counters,
    ).toEqual({});
  }
}

test('Marchesa: return your dead creature', async ({ page }) => {
  await verifyFirstZoneReturn(page, 'Marchesa: return your dead creature', 'P1', true);
});
test('Marchesa: return an opponent-owned creature', async ({ page }) => {
  await verifyFirstZoneReturn(page, 'Marchesa: return an opponent-owned creature', 'P2', true);
});
test('Marchesa: ignore a creature without a +1/+1 counter', async ({ page }) => {
  await verifyFirstZoneReturn(
    page,
    'Marchesa: ignore a creature without a +1/+1 counter',
    'P1',
    false,
  );
});
test('Marchesa: ignore an opponent-controlled creature', async ({ page }) => {
  await verifyFirstZoneReturn(
    page,
    'Marchesa: ignore an opponent-controlled creature',
    'P2',
    false,
  );
});
test('Marchesa: skip the card exiled by Bojuka Bog', async ({ page }) => {
  await verifyFirstZoneReturn(
    page,
    'Marchesa: skip the card exiled by Bojuka Bog',
    'P2',
    false,
    true,
  );
});

test('Tribute Mage: exact mana-value search', async ({ page }) => {
  await runScenario(page, 'Tribute Mage: exact mana-value search');

  // The arranged board offers the cast through the normal player controls: the hand card is
  // highlighted as actionable, and clicking it opens the auto-pay confirmation directly.
  const mage = handCard(page, 'Tribute Mage');
  await expect(mage).toHaveClass(/actionable/);
  await mage.click();
  await expect(page.getByText(/Auto-pay: Island/)).toBeVisible();
  await confirm(page);

  // After priority passes the ETB search offers exactly the two mana-value-2 artifacts.
  await expect(
    page.getByText(/Search for an artifact card with mana value exactly 2/).first(),
  ).toBeVisible();
  const putIntoHand = page.getByRole('button', { name: 'Put into your hand' });
  await expect(putIntoHand).toHaveCount(2);
  await expect(page.getByText('Eligible Talisman').first()).toBeVisible();
  await expect(page.getByText('Eligible Signet').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  // The wrong-mana-value artifact and the nonartifact two-mana card are never offered.
  await expect(page.getByText('Wrong-MV Artifact')).toHaveCount(0);
  await expect(page.getByText('Two-Mana Bear')).toHaveCount(0);

  // First choice is Eligible Talisman (deterministic library order).
  await putIntoHand.first().click();

  // The authoritative log records the cast, resolution, search, and shuffle; the card is in hand.
  await expect(page.getByText('Eligible Talisman').first()).toBeVisible();
  await expect(page.getByText('Cast Tribute Mage ({2}{U})')).toBeVisible();
  await expect(page.getByText('Put Eligible Talisman into your hand')).toBeVisible();

  // The lab run ends once every player passes with an empty stack.
  await expect(page.getByText(/game over/i).first()).toBeVisible();
});

test('Gev, Scaled Scorch: ward — pay 2 life', async ({ page }) => {
  await runScenario(page, 'Gev, Scaled Scorch: ward — pay 2 life');

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Gev, Scaled Scorch').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Ward is paid (or declined) by the controller of the targeting spell, not Gev's controller.
  await expect(
    page.getByText(/ward—pay 2 life: pay 2 life or Lab Doom is countered/i),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Let Lab Doom be countered' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/is countered/i).first()).toBeVisible();
  // Scoped to the battlefield: a lingering hover preview of Gev is a second image with that name.
  await expect(permanent(page, 'Gev, Scaled Scorch')).toBeVisible();
});

test('Nightscape Familiar: regenerate survives destruction', async ({ page }) => {
  await runScenario(page, 'Nightscape Familiar: regenerate survives destruction');

  const familiar = permanent(page, 'Nightscape Familiar');
  await expect(familiar).toHaveClass(/actionable/);
  await familiar.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The regenerate ability must resolve before Lab Doom, otherwise the shield is not yet active
  // and the familiar dies. Casting is still legal, so pass is not auto-forced.
  await expect(page.getByText(/egenerate/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await familiar.click();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible();
  await expect(
    page.getByText('Nightscape Familiar regenerates instead of being destroyed'),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Nightscape Familiar', exact: true }).first(),
  ).toBeVisible();
});

test('Thran Vigil: artifact leaves your graveyard', async ({ page }) => {
  await runScenario(page, 'Thran Vigil: artifact leaves your graveyard');

  const picker = permanent(page, 'Grave Picker');
  await expect(picker).toHaveClass(/actionable/);
  await picker.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const talisman = page.locator('.zone-card-thumb.targetable').filter({
    has: page.getByRole('img', { name: 'Eligible Talisman', exact: true }),
  });
  await expect(talisman).toBeVisible();
  await talisman.click();
  await confirm(page);

  // Grave Picker is the only legal creature, so the leave-graveyard trigger auto-fills its target.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Eligible Talisman').first()).toBeVisible();
  await expect(page.getByText('+1/+1×1')).toBeVisible();
  await expect(
    page.getByText(/Thran Vigil — Once per event during your turn/).first(),
  ).toBeVisible();
});

test('Harmonic Prodigy: Shaman trigger fires twice', async ({ page }) => {
  await runScenario(page, 'Harmonic Prodigy: Shaman trigger fires twice');

  const shaman = handCard(page, 'Lab Shaman');
  await expect(shaman).toHaveClass(/actionable/);
  await shaman.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  const trigger = page.getByRole('button', {
    name: 'Lab Shaman: When this creature enters, you gain 1 life.',
  });
  await expect(trigger).toHaveCount(2);
  await trigger.first().click();
  // The remaining simultaneous trigger is the only legal choice, so the engine auto-orders it.

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('gains 1 life')).toHaveCount(2);
  await expect(page.getByRole('img', { name: 'Lab Shaman' }).first()).toBeVisible();
});

test('Swords to Plowshares: exile and gain life', async ({ page }) => {
  await runScenario(page, 'Swords to Plowshares: exile and gain life');

  const swords = handCard(page, 'Swords to Plowshares');
  await expect(swords).toHaveClass(/actionable/);
  await swords.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  // Scope to the opponent zone: a leftover hover preview also has a Lab Ox image.
  const closeResults = page.getByRole('button', { name: 'Close results' });
  if (await closeResults.isVisible()) {
    await closeResults.click();
  }
  await expect(page.getByText('Lab Ox is exiled by Swords to Plowshares')).toBeVisible();
  await expect(page.getByText(/gains 4 life/i).first()).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  const p2 = page.locator('.opponent[data-seat="P2"]');
  await expect(p2).toContainText('44');
  await expect(
    p2.locator('.zone', { hasText: 'Exile' }).getByRole('img', { name: 'Lab Ox', exact: true }),
  ).toBeVisible();
});

test('Go for the Throat: destroy a nonartifact creature', async ({ page }) => {
  await runScenario(page, 'Go for the Throat: destroy a nonartifact creature');

  const throat = handCard(page, 'Go for the Throat');
  await expect(throat).toHaveClass(/actionable/);
  await throat.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Servo' }).first()).toBeVisible();
});

test('Blossoming Defense: pump and hexproof', async ({ page }) => {
  await runScenario(page, 'Blossoming Defense: pump and hexproof');

  const defense = handCard(page, 'Blossoming Defense');
  await expect(defense).toHaveClass(/actionable/);
  await defense.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('6/6');
  await expect(page.getByText(/Cast Blossoming Defense/i).first()).toBeVisible();
});

test('Bojuka Bog: exile the targeted graveyard', async ({ page }) => {
  await runScenario(page, 'Bojuka Bog: exile the targeted graveyard');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const bog = handCard(page, 'Bojuka Bog');
  await expect(bog).toHaveClass(/actionable/);
  await bog.click();

  await expect(page.locator('.target-instruction')).toHaveText(
    'Target 1 of 1: click a highlighted card or player.',
  );
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Bojuka Bog')).toBeVisible();
  await expect(page.getByText('Lab Servo').first()).toBeVisible();
  await expect(page.getByText(/exile/i).first()).toBeVisible();
});

test('Citywide Bust: destroy toughness 4 or greater', async ({ page }) => {
  await runScenario(page, 'Citywide Bust: destroy toughness 4 or greater');

  const bust = handCard(page, 'Citywide Bust');
  await expect(bust).toHaveClass(/actionable/);
  await bust.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Servo' }).first()).toBeVisible();
  await expect(page.getByText(/Cast Citywide Bust/i).first()).toBeVisible();
});

test('Defile: -1/-1 per Swamp you control', async ({ page }) => {
  await runScenario(page, 'Defile: -1/-1 per Swamp you control');

  const defile = handCard(page, 'Defile');
  await expect(defile).toHaveClass(/actionable/);
  await defile.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('2/2');
  await expect(permanent(page, 'Lab Servo')).toContainText('1/1');
  await expect(page.getByText(/Cast Defile/i).first()).toBeVisible();
});

test('Unleash Fury: double target power', async ({ page }) => {
  await runScenario(page, 'Unleash Fury: double target power');

  const fury = handCard(page, 'Unleash Fury');
  await expect(fury).toHaveClass(/actionable/);
  await fury.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('8/4');
  await expect(page.getByText(/Cast Unleash Fury/i).first()).toBeVisible();
});

test('Aura Mutation: destroy enchantment, make Saprolings', async ({ page }) => {
  await runScenario(page, 'Aura Mutation: destroy enchantment, make Saprolings');

  const mutation = handCard(page, 'Aura Mutation');
  await expect(mutation).toHaveClass(/actionable/);
  await mutation.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page
    .locator('.object')
    .filter({ has: page.getByRole('img', { name: 'Lab Hex', exact: true }) })
    .click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Ox' }).first()).toBeVisible();
  // Identical tokens stack in the player board; three Saprolings render as one chip with ×3.
  await expect(page.getByRole('img', { name: 'Saproling' })).toHaveCount(1);
  await expect(permanent(page, 'Saproling')).toContainText('1/1');
  await expect(permanent(page, 'Saproling')).toContainText('×3');
  await expect(page.getByText(/Cast Aura Mutation/i).first()).toBeVisible();
});

test('Mutilate: -1/-1 per Swamp, all creatures', async ({ page }) => {
  await runScenario(page, 'Mutilate: -1/-1 per Swamp, all creatures');

  const mutilate = handCard(page, 'Mutilate');
  await expect(mutilate).toHaveClass(/actionable/);
  await mutilate.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('2/2');
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(page.getByText(/Cast Mutilate/i).first()).toBeVisible();
});

test('Their Name Is Death: destroy nonartifact creatures', async ({ page }) => {
  await runScenario(page, 'Their Name Is Death: destroy nonartifact creatures');

  const death = handCard(page, 'Their Name Is Death');
  await expect(death).toHaveClass(/actionable/);
  await death.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Servo' }).first()).toBeVisible();
  await expect(page.getByText(/Cast Their Name Is Death/i).first()).toBeVisible();
});

test('Chain Reaction: damage equal to creature count', async ({ page }) => {
  await runScenario(page, 'Chain Reaction: damage equal to creature count');

  const chain = handCard(page, 'Chain Reaction');
  await expect(chain).toHaveClass(/actionable/);
  await chain.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');
  await expect(permanent(page, 'Lab Ox')).toContainText('−2');
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(page.getByText(/Cast Chain Reaction/i).first()).toBeVisible();
});

test('Collective Unconscious: draw for your creatures', async ({ page }) => {
  await runScenario(page, 'Collective Unconscious: draw for your creatures');

  const unconscious = handCard(page, 'Collective Unconscious');
  await expect(unconscious).toHaveClass(/actionable/);
  await unconscious.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(2);
  await expect(page.getByText(/Cast Collective Unconscious/i).first()).toBeVisible();
});

test('Camaraderie: life, cards, and +1/+1', async ({ page }) => {
  await runScenario(page, 'Camaraderie: life, cards, and +1/+1');

  const camaraderie = handCard(page, 'Camaraderie');
  await expect(camaraderie).toHaveClass(/actionable/);
  await camaraderie.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(2);
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) }),
  ).toContainText('5/5');
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Lab Servo', exact: true }) }),
  ).toContainText('2/2');
  await expect(
    page
      .locator('.opponent')
      .filter({ hasText: 'P2' })
      .locator('.object')
      .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) }),
  ).toContainText('4/4');
  await expect(page.getByText(/Cast Camaraderie/i).first()).toBeVisible();
});

test('Shamanic Revelation: draw creatures, life for power 4', async ({ page }) => {
  await runScenario(page, 'Shamanic Revelation: draw creatures, life for power 4');

  const revelation = handCard(page, 'Shamanic Revelation');
  await expect(revelation).toHaveClass(/actionable/);
  await revelation.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.human-zone .life-badge')).toHaveText('44');
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(2);
  await expect(page.getByText(/Cast Shamanic Revelation/i).first()).toBeVisible();
});

test('Flayed One: mill three and lifelink', async ({ page }) => {
  await runScenario(page, 'Flayed One: mill three and lifelink');

  const flayed = handCard(page, 'Flayed One');
  await expect(flayed).toHaveClass(/actionable/);
  await flayed.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Flayed One')).toContainText('4/1');
  await expect(permanent(page, 'Flayed One')).toContainText(/lifelink/i);
  await expect(page.getByText('Graveyard (3)')).toBeVisible();
  await expect(page.getByText(/Cast Flayed One/i).first()).toBeVisible();
});

test('Night Scythe: create a Necron Warrior', async ({ page }) => {
  await runScenario(page, 'Night Scythe: create a Necron Warrior');

  const scythe = handCard(page, 'Night Scythe');
  await expect(scythe).toHaveClass(/actionable/);
  await scythe.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(permanent(page, 'Night Scythe')).toBeVisible();
  await expect(permanent(page, 'Necron Warrior')).toContainText('2/2');
  // Crew 2 remains a legal activation, so unique-pass does not auto-end the run.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Cast Night Scythe/i).first()).toBeVisible();
});

test('Game Trail: reveal a Forest, enter untapped', async ({ page }) => {
  await runScenario(page, 'Game Trail: reveal a Forest, enter untapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const trail = handCard(page, 'Game Trail');
  await expect(trail).toHaveClass(/actionable/);
  await trail.click();

  await expect(
    page.getByRole('button', { name: /Reveal a Mountain or Forest card \(enters untapped\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Reveal a Mountain or Forest card \(enters untapped\)/i })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Game Trail')).toBeVisible();
  await expect(permanent(page, 'Game Trail').locator('.tap-badge')).toHaveCount(0);
  await expect(handCard(page, 'Forest')).toBeVisible();
});

test('Fortified Village: reveal a Plains, enter untapped', async ({ page }) => {
  await runScenario(page, 'Fortified Village: reveal a Plains, enter untapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const village = handCard(page, 'Fortified Village');
  await expect(village).toHaveClass(/actionable/);
  await village.click();

  await expect(
    page.getByRole('button', { name: /Reveal a Forest or Plains card \(enters untapped\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Reveal a Forest or Plains card \(enters untapped\)/i })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Fortified Village')).toBeVisible();
  await expect(permanent(page, 'Fortified Village').locator('.tap-badge')).toHaveCount(0);
  await expect(handCard(page, 'Plains')).toBeVisible();
});

test('Shineshadow Snarl: reveal a Swamp, enter untapped', async ({ page }) => {
  await runScenario(page, 'Shineshadow Snarl: reveal a Swamp, enter untapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const snarl = handCard(page, 'Shineshadow Snarl');
  await expect(snarl).toHaveClass(/actionable/);
  await snarl.click();

  await expect(
    page.getByRole('button', { name: /Reveal a Plains or Swamp card \(enters untapped\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Reveal a Plains or Swamp card \(enters untapped\)/i })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Shineshadow Snarl')).toBeVisible();
  await expect(permanent(page, 'Shineshadow Snarl').locator('.tap-badge')).toHaveCount(0);
  await expect(handCard(page, 'Swamp')).toBeVisible();
});

test('Magmaquake: X damage, spare flying', async ({ page }) => {
  await runScenario(page, 'Magmaquake: X damage, spare flying');

  const quake = handCard(page, 'Magmaquake');
  await expect(quake).toHaveClass(/actionable/);
  await quake.click();
  await expect(page.getByText(/Choose X/)).toBeVisible();
  const xInput = page.locator('.x-group input[type="number"]');
  await xInput.fill('2');
  await page.locator('.x-group button').click();
  const autoPay = page.getByText(/Auto-pay/);
  if (await autoPay.isVisible()) {
    await confirm(page);
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('−2');
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird')).toContainText('1/1');
  await expect(permanent(page, 'Lab Bird')).not.toContainText('−');
  await expect(page.getByText(/Cast Magmaquake/i).first()).toBeVisible();
});

test("Hunter's Prowess: pump and trample", async ({ page }) => {
  await runScenario(page, "Hunter's Prowess: pump and trample");

  const prowess = handCard(page, "Hunter's Prowess");
  await expect(prowess).toHaveClass(/actionable/);
  await prowess.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('7/7');
  await expect(permanent(page, 'Lab Ox')).toContainText(/trample/i);
  await expect(page.getByText(/Cast Hunter's Prowess/i).first()).toBeVisible();
});

test('Royal Warden: two tapped Necron Warriors', async ({ page }) => {
  await runScenario(page, 'Royal Warden: two tapped Necron Warriors');

  const warden = handCard(page, 'Royal Warden');
  await expect(warden).toHaveClass(/actionable/);
  await warden.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Royal Warden')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Necron Warrior' })).toHaveCount(1);
  await expect(permanent(page, 'Necron Warrior')).toContainText('2/2');
  await expect(permanent(page, 'Necron Warrior')).toContainText('×2');
  await expect(permanent(page, 'Necron Warrior').locator('.tap-badge')).toHaveCount(1);
  await expect(page.getByText(/Cast Royal Warden/i).first()).toBeVisible();
});

test('Provoke the Trolls: damage then pump', async ({ page }) => {
  await runScenario(page, 'Provoke the Trolls: damage then pump');

  const provoke = handCard(page, 'Provoke the Trolls');
  await expect(provoke).toHaveClass(/actionable/);
  await provoke.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('9/4');
  await expect(permanent(page, 'Lab Ox')).toContainText('−3');
  await expect(page.getByText(/Cast Provoke the Trolls/i).first()).toBeVisible();
});

test('Hoard-Smelter Dragon: destroy artifact and pump', async ({ page }) => {
  await runScenario(page, 'Hoard-Smelter Dragon: destroy artifact and pump');

  const dragon = permanent(page, 'Hoard-Smelter Dragon');
  await expect(dragon).toHaveClass(/actionable/);
  await dragon.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Wrong-MV Artifact').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Hoard-Smelter Dragon')).toContainText('8/5');
  await expect(permanent(page, 'Wrong-MV Artifact')).toHaveCount(0);
});

test('Loaming Shaman: shuffle a graveyard card', async ({ page }) => {
  await runScenario(page, 'Loaming Shaman: shuffle a graveyard card');

  const shaman = handCard(page, 'Loaming Shaman');
  await expect(shaman).toHaveClass(/actionable/);
  await shaman.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Count-slot choices render as generic action buttons; graveyard cards are named by object id.
  await page.getByRole('button', { name: /^Target / }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Loaming Shaman')).toBeVisible();
  await expect(page.getByText(/shuffle/i).first()).toBeVisible();
});

test('Chronomancer: sacrifice an artifact, draw', async ({ page }) => {
  await runScenario(page, 'Chronomancer: sacrifice an artifact, draw');

  const chrono = permanent(page, 'Chronomancer');
  await expect(chrono).toHaveClass(/actionable/);
  await chrono.click();
  const autoPay = page.getByText(/Auto-pay/);
  if (await autoPay.isVisible()) {
    await confirm(page);
  }
  const servo = page.getByRole('button', { name: /Lab Servo/i });
  if (await servo.isVisible()) {
    await servo.click();
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Chronomancer')).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await expect(page.getByText('Eligible Talisman').first()).toBeVisible();
});

test('Akoum Hellkite: Mountain landfall deals 2', async ({ page }) => {
  await runScenario(page, 'Akoum Hellkite: Mountain landfall deals 2');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const mountain = handCard(page, 'Mountain');
  await expect(mountain).toHaveClass(/actionable/);
  await mountain.click();

  await expect(page.locator('.target-instruction')).toHaveText(
    'Target 1 of 1: click a highlighted card or player.',
  );
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
  await expect(permanent(page, 'Mountain')).toBeVisible();
});

test('Dawn of Hope: create a lifelink Soldier', async ({ page }) => {
  await runScenario(page, 'Dawn of Hope: create a lifelink Soldier');

  const dawn = permanent(page, 'Dawn of Hope');
  await expect(dawn).toHaveClass(/actionable/);
  await dawn.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Soldier')).toContainText('1/1');
  await expect(permanent(page, 'Soldier')).toContainText(/lifelink/i);
});

test('Rootborn Defenses: grant indestructible', async ({ page }) => {
  await runScenario(page, 'Rootborn Defenses: grant indestructible');

  const rootborn = handCard(page, 'Rootborn Defenses');
  await expect(rootborn).toHaveClass(/actionable/);
  await rootborn.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText(/indestructible/i);
  await expect(page.getByText(/Cast Rootborn Defenses/i).first()).toBeVisible();
});

test('Trostani Discordant: two lifelink Soldiers', async ({ page }) => {
  await runScenario(page, 'Trostani Discordant: two lifelink Soldiers');

  const trostani = handCard(page, 'Trostani Discordant');
  await expect(trostani).toHaveClass(/actionable/);
  await trostani.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Trostani Discordant')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Soldier' })).toHaveCount(1);
  await expect(permanent(page, 'Soldier')).toContainText('2/2');
  await expect(permanent(page, 'Soldier')).toContainText('×2');
  await expect(permanent(page, 'Soldier')).toContainText(/lifelink/i);
  await expect(page.getByText(/Cast Trostani Discordant/i).first()).toBeVisible();
});

test('Felidar Retreat: landfall Cat Beast', async ({ page }) => {
  await runScenario(page, 'Felidar Retreat: landfall Cat Beast');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const forest = handCard(page, 'Forest');
  await expect(forest).toHaveClass(/actionable/);
  await forest.click();

  await expect(page.getByRole('button', { name: /Beast/i })).toBeVisible();
  await page.getByRole('button', { name: /Beast/i }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Cat Beast')).toContainText('2/2');
  await expect(permanent(page, 'Forest')).toBeVisible();
});

test('Hornet Nest: damage makes Insects', async ({ page }) => {
  await runScenario(page, 'Hornet Nest: damage makes Insects');

  const shock = handCard(page, 'Lab Shock');
  await expect(shock).toHaveClass(/actionable/);
  await shock.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Hornet Nest').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Hornet Nest')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Insect' })).toHaveCount(1);
  await expect(permanent(page, 'Insect')).toContainText('1/1');
  await expect(permanent(page, 'Insect')).toContainText('×2');
  await expect(permanent(page, 'Insect')).toContainText(/flying/i);
  await expect(permanent(page, 'Insect')).toContainText(/deathtouch/i);
});

test('Slate of Ancestry: discard and draw for creatures', async ({ page }) => {
  await runScenario(page, 'Slate of Ancestry: discard and draw for creatures');

  const slate = permanent(page, 'Slate of Ancestry');
  await expect(slate).toHaveClass(/actionable/);
  await slate.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Discard-your-hand is a count-slot on the normal path. The last remaining card is auto-forced.
  await expect(page.getByText(/Discard a card \(1 of 2\)/i)).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).first().click();

  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  if (await pass.isVisible()) {
    await pass.click();
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(2);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
  await expect(permanent(page, 'Slate of Ancestry').locator('.tap-badge')).toHaveCount(1);
});

test('Canoptek Scarab Swarm: exile graveyard, make Insects', async ({ page }) => {
  await runScenario(page, 'Canoptek Scarab Swarm: exile graveyard, make Insects');

  const scarab = handCard(page, 'Canoptek Scarab Swarm');
  await expect(scarab).toHaveClass(/actionable/);
  await scarab.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Canoptek Scarab Swarm')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Insect' })).toHaveCount(1);
  await expect(permanent(page, 'Insect')).toContainText('1/1');
  await expect(permanent(page, 'Insect')).toContainText('×2');
  await expect(permanent(page, 'Insect')).toContainText(/flying/i);
  await expect(permanent(page, 'Insect')).not.toContainText(/deathtouch/i);
});

test('Great Oak Guardian: pump and untap P2 creatures', async ({ page }) => {
  await runScenario(page, 'Great Oak Guardian: pump and untap P2 creatures');

  const oak = handCard(page, 'Great Oak Guardian');
  await expect(oak).toHaveClass(/actionable/);
  await oak.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Great Oak Guardian')).toContainText('4/5');
  await expect(permanent(page, 'Lab Ox')).toContainText('6/6');
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);
});

test('Frostboil Snarl: reveal an Island, enter untapped', async ({ page }) => {
  await runScenario(page, 'Frostboil Snarl: reveal an Island, enter untapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const snarl = handCard(page, 'Frostboil Snarl');
  await expect(snarl).toHaveClass(/actionable/);
  await snarl.click();

  await expect(
    page.getByRole('button', { name: /Reveal a Island or Mountain card \(enters untapped\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Reveal a Island or Mountain card \(enters untapped\)/i })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Frostboil Snarl')).toBeVisible();
  await expect(permanent(page, 'Frostboil Snarl').locator('.tap-badge')).toHaveCount(0);
  await expect(handCard(page, 'Island')).toBeVisible();
});

test('Vineglimmer Snarl: reveal a Forest, enter untapped', async ({ page }) => {
  await runScenario(page, 'Vineglimmer Snarl: reveal a Forest, enter untapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const snarl = handCard(page, 'Vineglimmer Snarl');
  await expect(snarl).toHaveClass(/actionable/);
  await snarl.click();

  await expect(
    page.getByRole('button', { name: /Reveal a Forest or Island card \(enters untapped\)/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Reveal a Forest or Island card \(enters untapped\)/i })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Vineglimmer Snarl')).toBeVisible();
  await expect(permanent(page, 'Vineglimmer Snarl').locator('.tap-badge')).toHaveCount(0);
  await expect(handCard(page, 'Forest')).toBeVisible();
});

test('Stroke of Midnight: destroy nonland, make a Human', async ({ page }) => {
  await runScenario(page, 'Stroke of Midnight: destroy nonland, make a Human');

  const stroke = handCard(page, 'Stroke of Midnight');
  await expect(stroke).toHaveClass(/actionable/);
  await stroke.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Human' })).toHaveCount(1);
  await expect(permanent(page, 'Human')).toContainText('1/1');
  await expect(page.getByText(/Cast Stroke of Midnight/i).first()).toBeVisible();
});

test('Generous Gift: destroy Lab Ox, make an Elephant', async ({ page }) => {
  await runScenario(page, 'Generous Gift: destroy Lab Ox, make an Elephant');

  const gift = handCard(page, 'Generous Gift');
  await expect(gift).toHaveClass(/actionable/);
  await gift.click();
  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Elephant' })).toHaveCount(1);
  await expect(permanent(page, 'Elephant')).toContainText('3/3');
  await expect(page.getByText(/Cast Generous Gift/i).first()).toBeVisible();
});

test('Boros Garrison: bounce Forest, enter tapped', async ({ page }) => {
  await runScenario(page, 'Boros Garrison: bounce Forest, enter tapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const garrison = handCard(page, 'Boros Garrison');
  await expect(garrison).toHaveClass(/actionable/);
  await garrison.click();

  await expect(page.getByText(/choose a permanent to return/i)).toBeVisible();
  await permanent(page, 'Forest').click();
  const bounceConfirm = page.getByRole('button', { name: 'Confirm' });
  await expect(bounceConfirm).toBeVisible();
  await bounceConfirm.click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Boros Garrison')).toBeVisible();
  await expect(permanent(page, 'Boros Garrison').locator('.tap-badge')).toHaveCount(1);
  await expect(handCard(page, 'Forest')).toBeVisible();
  await expect(permanent(page, 'Forest')).toHaveCount(0);
});

test('Orzhov Basilica: bounce Forest, enter tapped', async ({ page }) => {
  await runScenario(page, 'Orzhov Basilica: bounce Forest, enter tapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const basilica = handCard(page, 'Orzhov Basilica');
  await expect(basilica).toHaveClass(/actionable/);
  await basilica.click();

  await expect(page.getByText(/choose a permanent to return/i)).toBeVisible();
  await permanent(page, 'Forest').click();
  const bounceConfirm = page.getByRole('button', { name: 'Confirm' });
  await expect(bounceConfirm).toBeVisible();
  await bounceConfirm.click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Orzhov Basilica')).toBeVisible();
  await expect(permanent(page, 'Orzhov Basilica').locator('.tap-badge')).toHaveCount(1);
  await expect(handCard(page, 'Forest')).toBeVisible();
  await expect(permanent(page, 'Forest')).toHaveCount(0);
});

test('Pia and Kiran Nalaar: two flying Thopters', async ({ page }) => {
  await runScenario(page, 'Pia and Kiran Nalaar: two flying Thopters');

  const pair = handCard(page, 'Pia and Kiran Nalaar');
  await expect(pair).toHaveClass(/actionable/);
  await pair.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Pia and Kiran Nalaar')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Thopter' })).toHaveCount(1);
  await expect(permanent(page, 'Thopter')).toContainText('1/1');
  await expect(permanent(page, 'Thopter')).toContainText('×2');
  await expect(permanent(page, 'Thopter')).toContainText(/flying/i);
});

test('Crackling Doom: opponents take 2, P2 sacs Lab Ox', async ({ page }) => {
  await runScenario(page, 'Crackling Doom: opponents take 2, P2 sacs Lab Ox');

  const doom = handCard(page, 'Crackling Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
  await expect(page.getByText(/Cast Crackling Doom/i).first()).toBeVisible();
});

test('Rakdos Carnarium: bounce Forest, enter tapped', async ({ page }) => {
  await runScenario(page, 'Rakdos Carnarium: bounce Forest, enter tapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const carnarium = handCard(page, 'Rakdos Carnarium');
  await expect(carnarium).toHaveClass(/actionable/);
  await carnarium.click();

  await expect(page.getByText(/choose a permanent to return/i)).toBeVisible();
  await permanent(page, 'Forest').click();
  const bounceConfirm = page.getByRole('button', { name: 'Confirm' });
  await expect(bounceConfirm).toBeVisible();
  await bounceConfirm.click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Rakdos Carnarium')).toBeVisible();
  await expect(permanent(page, 'Rakdos Carnarium').locator('.tap-badge')).toHaveCount(1);
  await expect(handCard(page, 'Forest')).toBeVisible();
  await expect(permanent(page, 'Forest')).toHaveCount(0);
});

test('Whirler Rogue: two flying Thopters', async ({ page }) => {
  await runScenario(page, 'Whirler Rogue: two flying Thopters');

  const rogue = handCard(page, 'Whirler Rogue');
  await expect(rogue).toHaveClass(/actionable/);
  await rogue.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(permanent(page, 'Whirler Rogue')).toBeVisible();
  await expect(permanent(page, 'Thopter')).toContainText('×2');
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('img', { name: 'Thopter' })).toHaveCount(1);
  await expect(permanent(page, 'Thopter')).toContainText('1/1');
  await expect(permanent(page, 'Thopter')).toContainText(/flying/i);
});

test('Reckless Fireweaver: artifact ETB pings opponents', async ({ page }) => {
  await runScenario(page, 'Reckless Fireweaver: artifact ETB pings opponents');

  const talisman = handCard(page, 'Eligible Talisman');
  await expect(talisman).toHaveClass(/actionable/);
  await talisman.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Eligible Talisman')).toBeVisible();
  await expect(permanent(page, 'Reckless Fireweaver')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('39');
});

test('Spit Flame: 4 damage to Lab Ox', async ({ page }) => {
  await runScenario(page, 'Spit Flame: 4 damage to Lab Ox');

  const spit = handCard(page, 'Spit Flame');
  await expect(spit).toHaveClass(/actionable/);
  await spit.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByText(/Cast Spit Flame/i).first()).toBeVisible();
});

test('Sai, Master Thopterist: artifact makes a Thopter', async ({ page }) => {
  await runScenario(page, 'Sai, Master Thopterist: artifact makes a Thopter');

  const talisman = handCard(page, 'Eligible Talisman');
  await expect(talisman).toHaveClass(/actionable/);
  await talisman.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(permanent(page, 'Sai, Master Thopterist')).toBeVisible();
  await expect(permanent(page, 'Eligible Talisman')).toBeVisible();
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  if (await pass.isVisible()) {
    await pass.click();
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Thopter')).toHaveCount(1);
  await expect(permanent(page, 'Thopter')).toContainText('1/1');
  await expect(permanent(page, 'Thopter')).toContainText(/flying/i);
});

test('Secret Rendezvous: you and P2 each draw three', async ({ page }) => {
  await runScenario(page, 'Secret Rendezvous: you and P2 each draw three');

  const rendezvous = handCard(page, 'Secret Rendezvous');
  await expect(rendezvous).toHaveClass(/actionable/);
  await rendezvous.click();
  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(3);
  await expect(page.getByText(/Cast Secret Rendezvous/i).first()).toBeVisible();
});

test('Demanding Dragon: 5 damage when P2 has no creature', async ({ page }) => {
  await runScenario(page, 'Demanding Dragon: 5 damage when P2 has no creature');

  const dragon = handCard(page, 'Demanding Dragon');
  await expect(dragon).toHaveClass(/actionable/);
  await dragon.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Demanding Dragon')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('35');
  await expect(page.getByText(/Cast Demanding Dragon/i).first()).toBeVisible();
});

test('Cryptothrall: your other artifact creature has hexproof', async ({ page }) => {
  await runScenario(page, 'Cryptothrall: your other artifact creature has hexproof');

  const cryptothrall = handCard(page, 'Cryptothrall');
  await expect(cryptothrall).toHaveClass(/actionable/);
  await cryptothrall.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Lab Servo', exact: true }) }),
  ).toContainText(/hexproof/i);
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Cryptothrall', exact: true }) }),
  ).not.toContainText(/hexproof/i);
  await expect(
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) }),
  ).not.toContainText(/hexproof/i);
  await expect(
    page
      .locator('.opponent')
      .filter({ hasText: 'P2' })
      .locator('.object')
      .filter({ has: page.getByRole('img', { name: 'Lab Servo', exact: true }) }),
  ).not.toContainText(/hexproof/i);
});

test('Boros Charm: 4 damage to P2', async ({ page }) => {
  await runScenario(page, 'Boros Charm: 4 damage to P2');

  const charm = handCard(page, 'Boros Charm');
  await expect(charm).toHaveClass(/actionable/);
  await charm.click();
  await page.getByRole('button', { name: /Deal 4 damage to target player/i }).click();
  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('36');
  await expect(page.getByText(/Cast Boros Charm/i).first()).toBeVisible();
});

test('Rakdos Charm: destroy Wrong-MV Artifact', async ({ page }) => {
  await runScenario(page, 'Rakdos Charm: destroy Wrong-MV Artifact');

  const charm = handCard(page, 'Rakdos Charm');
  await expect(charm).toHaveClass(/actionable/);
  await charm.click();
  await page.getByRole('button', { name: /Destroy target artifact/i }).click();
  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await permanent(page, 'Wrong-MV Artifact').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Wrong-MV Artifact')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Ox' }).first()).toBeVisible();
  await expect(page.getByText(/Cast Rakdos Charm/i).first()).toBeVisible();
});

test('Steel Hellkite: +1/+0 until end of turn', async ({ page }) => {
  await runScenario(page, 'Steel Hellkite: +1/+0 until end of turn');

  const hellkite = permanent(page, 'Steel Hellkite');
  await expect(hellkite).toHaveClass(/actionable/);
  await hellkite.click();
  await page.getByRole('button', { name: /gets \+1\/\+0/i }).click();
  const autoPay = page.getByText(/Auto-pay/);
  if (await autoPay.isVisible()) {
    await confirm(page);
  }

  await expect(page.getByText(/gets \+1\/\+0 until end of turn/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(hellkite).toContainText('6/5');
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(hellkite).toContainText('6/5');
});

test('Rogue Refiner: draw a nonland and get two energy', async ({ page }) => {
  await runScenario(page, 'Rogue Refiner: draw a nonland and get two energy');

  const refiner = handCard(page, 'Rogue Refiner');
  await expect(refiner).toHaveClass(/actionable/);
  await refiner.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Rogue Refiner')).toBeVisible();
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(1);
  await expect(page.getByLabel('Global counters')).toContainText('ENERGY');
  await expect(page.getByLabel('Global counters')).toContainText('2');
  await expect(page.getByText(/Cast Rogue Refiner/i).first()).toBeVisible();
});

test('Whirler Virtuoso: three energy makes a Thopter', async ({ page }) => {
  await runScenario(page, 'Whirler Virtuoso: three energy makes a Thopter');

  const virtuoso = handCard(page, 'Whirler Virtuoso');
  await expect(virtuoso).toHaveClass(/actionable/);
  await virtuoso.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(permanent(page, 'Whirler Virtuoso')).toBeVisible();
  await expect(page.getByLabel('Global counters')).toContainText('3');
  const virtuosoBoard = permanent(page, 'Whirler Virtuoso');
  await expect(virtuosoBoard).toHaveClass(/actionable/);
  await virtuosoBoard.click();
  await expect(page.getByText('Activate Whirler Virtuoso')).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Thopter')).toHaveCount(1);
  await expect(permanent(page, 'Thopter')).toContainText('1/1');
  await expect(permanent(page, 'Thopter')).toContainText(/flying/i);
});

test('Ajani, Caller of the Pride: +1 counter on Lab Ox', async ({ page }) => {
  await runScenario(page, 'Ajani, Caller of the Pride: +1 counter on Lab Ox');

  const ajani = permanent(page, 'Ajani, Caller of the Pride');
  await expect(ajani).toHaveClass(/actionable/);
  await ajani.click();
  await page.getByRole('button', { name: /\+1: Put a \+1\/\+1 counter/i }).click();
  await expect(page.getByText('Activate Ajani, Caller of the Pride')).toBeVisible();
  await confirm(page);
  await page.getByRole('button', { name: /Target Lab Ox/i }).click();

  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  if (await pass.isVisible()) {
    await pass.click();
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
});

test('Terror of the Peaks: entering Bear deals 2 to P2', async ({ page }) => {
  await runScenario(page, 'Terror of the Peaks: entering Bear deals 2 to P2');

  const bear = handCard(page, 'Two-Mana Bear');
  await expect(bear).toHaveClass(/actionable/);
  await bear.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Target 1 of /)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Terror of the Peaks')).toBeVisible();
  await expect(permanent(page, 'Two-Mana Bear')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
  await expect(page.getByText(/Cast Two-Mana Bear/i).first()).toBeVisible();
});

test('Aetherwind Basker: +1/+1 until end of turn', async ({ page }) => {
  await runScenario(page, 'Aetherwind Basker: +1/+1 until end of turn');

  const basker = handCard(page, 'Aetherwind Basker');
  await expect(basker).toHaveClass(/actionable/);
  await basker.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(permanent(page, 'Aetherwind Basker')).toBeVisible();
  await expect(page.getByLabel('Global counters')).toContainText('1');
  const baskerBoard = permanent(page, 'Aetherwind Basker');
  await expect(baskerBoard).toHaveClass(/actionable/);
  await baskerBoard.click();
  await expect(page.getByText('Activate Aetherwind Basker')).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Aetherwind Basker')).toContainText('8/8');
});

test('Zopandrel: indestructible counter grants indestructible', async ({ page }) => {
  await runScenario(page, 'Zopandrel: indestructible counter grants indestructible');

  const zopandrel = permanent(page, 'Zopandrel, Hunger Dominus');
  await expect(zopandrel).toHaveClass(/actionable/);
  await zopandrel.click();
  await expect(page.getByText('Activate Zopandrel, Hunger Dominus')).toBeVisible();
  await confirm(page);
  await permanent(page, 'Two-Mana Bear').click();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Two-Mana Bear')).toHaveCount(0);
  await expect(permanent(page, 'Lab Shaman')).toHaveCount(0);
  const resolvedZopandrel = permanent(page, 'Zopandrel, Hunger Dominus');
  await expect(resolvedZopandrel.locator('.counters')).toContainText(/indestructible.*1/i);
  await expect(resolvedZopandrel.locator('.keywords')).toHaveAttribute('title', /indestructible/i);
});

async function runArcaneDenial(page: Page, drawCount: 0 | 2): Promise<void> {
  await runScenario(page, `Arcane Denial: next-upkeep draw ${drawCount}`);

  const arcane = handCard(page, 'Arcane Denial');
  await expect(arcane).toHaveClass(/actionable/);
  // This scenario casts the response. Declining it via Smart yield is exercised separately
  // in player-smart-yield.spec.ts, where it must advance instead of reoffering the same spell.
  await arcane.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const pending = page.locator('.stack li').filter({ hasText: 'Lab Pending Spell' });
  await expect(pending).toHaveClass(/targetable/);
  await pending.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  const optionalFirst = page.getByRole('button', { name: /targeted spell controller may draw/i });
  await expect(optionalFirst).toBeVisible({ timeout: 15_000 });
  await optionalFirst.click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Caster Secret Draw')).toBeVisible();
  const p4 = page.locator('.opponent').filter({ hasText: 'P4' });
  await expect(p4).toContainText(`${drawCount} in hand`);
  await expect(page.getByText('Target Secret Alpha')).toHaveCount(0);
  await expect(page.getByText('Target Secret Beta')).toHaveCount(0);
  await expect(page.getByText(/Lab Pending Spell is countered by Arcane Denial/i)).toBeVisible();
}

test('Arcane Denial: next-upkeep draw 0', async ({ page }) => {
  await runArcaneDenial(page, 0);
});

test('Arcane Denial: next-upkeep draw 2', async ({ page }) => {
  await runArcaneDenial(page, 2);
});

async function runSmotheringTithe(page: Page, outcome: 'pay' | 'decline'): Promise<void> {
  await runScenario(
    page,
    `Smothering Tithe: opponent draws and ${outcome === 'pay' ? 'pays' : 'declines'}`,
  );

  const drawSpell = handCard(page, 'Lab Pending Spell');
  await expect(drawSpell).toHaveClass(/actionable/);
  await drawSpell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/Smothering Tithe.*pay \{2\}/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', { name: outcome === 'pay' ? 'Pay {2}' : "Don't pay {2}", exact: true })
    .click();

  // The optional-payment decision resolves the trigger, then the human receives the normal
  // post-resolution priority window. Passing it lets the finite prepared scenario conclude.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    handCard(page, `Tithe Secret ${outcome === 'pay' ? 'Pay' : 'Decline'}`),
  ).toBeVisible();
  await expect(permanent(page, 'Smothering Tithe')).toBeVisible();
  await expect(permanent(page, 'Treasure')).toHaveCount(outcome === 'pay' ? 0 : 1);
  await expect(
    page
      .getByText(
        outcome === 'pay'
          ? /pays \{2\} for Smothering Tithe/i
          : /doesn't pay \{2\} for Smothering Tithe/i,
      )
      .first(),
  ).toBeVisible();
}

test('Smothering Tithe: opponent draws and pays', async ({ page }) => {
  await runSmotheringTithe(page, 'pay');
});

test('Smothering Tithe: opponent draws and declines', async ({ page }) => {
  await runSmotheringTithe(page, 'decline');
});

test('Fabled Passage: search, tapped entry, and fourth-land untap', async ({ page }) => {
  await runScenario(page, 'Fabled Passage: search, tapped entry, and fourth-land untap');

  const passage = permanent(page, 'Fabled Passage');
  await expect(passage).toHaveClass(/actionable/);
  await passage.click();
  await expect(page.getByText('Activate Fabled Passage')).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Island').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  await page.getByRole('button', { name: 'Put onto the battlefield tapped' }).click();

  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  if (await pass.isVisible()) await pass.click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Fabled Passage')).toHaveCount(0);
  const island = permanent(page, 'Island');
  await expect(island).toBeVisible();
  await expect(island).not.toHaveClass(/tapped/);
  const forests = permanent(page, 'Forest');
  await expect(forests).toHaveCount(1);
  await expect(forests).toContainText('×3');
  await expect(page.getByText(/Put Island onto the battlefield tapped/i).first()).toBeVisible();
  await expect(page.getByText('Fabled Private Library Secret')).toHaveCount(0);
});

test('Myriad Landscape: normal land play enters tapped', async ({ page }) => {
  await runScenario(page, 'Myriad Landscape: normal land play enters tapped');

  await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
  await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
  const landscape = handCard(page, 'Myriad Landscape');
  await expect(landscape).toHaveClass(/actionable/);
  await landscape.click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Myriad Landscape').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/plays Myriad Landscape/i).first()).toBeVisible();
});

test.describe('land confirmation', () => {
  async function runLandScenario(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const sent: Array<{ type: string }> = [];
      (window as typeof window & { __sentActions: typeof sent }).__sentActions = sent;
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') {
          const message = JSON.parse(data) as { type: string };
          if (message.type === 'submitPlayerAction') sent.push(message);
        }
        originalSend.call(this, data);
      };
    });
    await page.goto('/card-test-lab');
    await page.locator('#scenario-select').selectOption({
      label: 'Myriad Landscape: normal land play enters tapped',
    });
    await page.getByRole('button', { name: 'Run scenario' }).click();
    await expect(page).toHaveURL(/\/game$/);
  }

  async function submissionCount(page: Page): Promise<number> {
    return page.evaluate(
      () =>
        (window as typeof window & { __sentActions: Array<{ type: string }> }).__sentActions.length,
    );
  }

  async function assertLandPlayedOnce(page: Page): Promise<void> {
    await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/plays Myriad Landscape/i).first()).toBeVisible();
    expect(await submissionCount(page)).toBe(1);
  }

  test('a single legal land submits from its hand card when both confirm settings are off', async ({
    page,
  }) => {
    await runLandScenario(page);

    await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
    await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
    const landscape = page.locator('.hand-card', { hasText: 'Myriad Landscape' });
    await expect(landscape).toHaveClass(/actionable/);
    await landscape.click();

    await assertLandPlayedOnce(page);
  });

  test('confirm passes and lands keeps the review step', async ({ page }) => {
    await runLandScenario(page);
    await setPlayerOption(page, 'Confirm passes & lands', true);
    await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
    await page.locator('.hand-card', { hasText: 'Myriad Landscape' }).click();

    await expect(page.getByRole('button', { name: 'Play land', exact: true })).toBeVisible();
    expect(await submissionCount(page)).toBe(0);
    await page.getByRole('button', { name: 'Play land', exact: true }).click();
    await assertLandPlayedOnce(page);
  });

  test('skip confirm submits the land once', async ({ page }) => {
    await runLandScenario(page);
    await setPlayerOption(page, 'Skip confirm step', true);
    await expect(page.getByLabel('Confirm passes & lands')).not.toBeChecked();
    await page.locator('.hand-card', { hasText: 'Myriad Landscape' }).click();

    await assertLandPlayedOnce(page);
  });

  test('the playable list names the land and plays it like its hand card', async ({ page }) => {
    await runLandScenario(page);
    const landscape = page.locator('.hand-card', { hasText: 'Myriad Landscape' });
    await expect(landscape.locator('.play-tag')).toHaveText('Play');
    const listed = page.locator('.playable-now').getByRole('button', {
      name: 'Play Myriad Landscape',
    });
    await expect(listed).toBeVisible();
    await listed.click();

    await assertLandPlayedOnce(page);
  });

  test('passing with a playable land asks before passing', async ({ page }) => {
    await runLandScenario(page);
    const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
    const reminder = page.getByRole('alertdialog', { name: /haven't played a land/ });

    await pass.click();
    await expect(reminder).toBeVisible();
    await page.getByRole('button', { name: 'Play a land' }).click();
    await expect(reminder).toBeHidden();
    expect(await submissionCount(page)).toBe(0);

    // Space on the dialog's focused button answers the dialog; it must not also pass priority.
    await pass.click();
    await expect(reminder).toBeVisible();
    await page.keyboard.press('Space');
    await expect(reminder).toBeHidden();
    expect(await submissionCount(page)).toBe(0);

    await pass.click();
    await page.getByRole('button', { name: 'Pass anyway' }).click();
    await expect(reminder).toBeHidden();
    await expect.poll(() => submissionCount(page)).toBe(1);
  });

  test('the land drop reminder can be turned off', async ({ page }) => {
    await runLandScenario(page);
    await setPlayerOption(page, 'Land drop reminder', false);
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect.poll(() => submissionCount(page)).toBe(1);
  });

  test('confirm passes and lands still reviews when skip confirm is also on', async ({ page }) => {
    await runLandScenario(page);
    await setPlayerOption(page, 'Confirm passes & lands', true);
    await setPlayerOption(page, 'Skip confirm step', true);
    await page.locator('.hand-card', { hasText: 'Myriad Landscape' }).click();

    await expect(page.getByRole('button', { name: 'Play land', exact: true })).toBeVisible();
    expect(await submissionCount(page)).toBe(0);
    await page.getByRole('button', { name: 'Play land', exact: true }).click();
    await assertLandPlayedOnce(page);
  });
});

test('Myriad Landscape: colorless mana pays a spell cost', async ({ page }) => {
  await runScenario(page, 'Myriad Landscape: colorless mana pays a spell cost');

  const sink = handCard(page, 'Myriad Mana Sink');
  await expect(sink).toHaveClass(/actionable/);
  await sink.click();
  await expect(page.getByText(/Auto-pay: Myriad Landscape/i)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Myriad Landscape').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Myriad Mana Sink')).toBeVisible();
  await expect(page.getByText(/Cast Myriad Mana Sink/i).first()).toBeVisible();
});

test('Myriad Landscape: grouped search enforces a shared land type', async ({ page }) => {
  await runScenario(page, 'Myriad Landscape: shared land type grouped search');

  const landscape = permanent(page, 'Myriad Landscape');
  await expect(landscape).toHaveClass(/actionable/);
  await landscape.click();
  await expect(page.getByText('Activate Myriad Landscape')).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/search for up to two basic lands/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: /Find nothing/i })).toBeVisible();
  await page
    .getByRole('button', { name: 'Put onto the battlefield tapped', exact: true })
    .last()
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Myriad Landscape')).toHaveCount(0);
  await expect(permanent(page, 'Island').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Myriad Shared Dual').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText('Myriad Private Library Secret')).toHaveCount(0);
  await expect(
    page.getByText(/Put Island and Myriad Shared Dual onto the battlefield tapped/i).first(),
  ).toBeVisible();
});

function ownDrawLines(page: Page) {
  return page
    .locator('.player-game .log .line')
    .filter({ has: page.locator('.actor', { hasText: /^P1$/ }) })
    .filter({ has: page.locator('.text', { hasText: /^draws / }) });
}

test('War Room: dynamic commander identity life activation', async ({ page }) => {
  await runScenario(page, 'War Room: dynamic commander-identity life activation');
  const life = page.locator('.human-zone .life-badge');
  const hand = page.locator('.human-zone .hand-card');
  await expect(life).toHaveText('40');
  await expect(hand).toHaveCount(2);
  await expect(handCard(page, 'War Room Mana Sink')).toBeVisible();
  await expect(handCard(page, 'War Room Action Witness')).toBeVisible();
  const room = permanent(page, 'War Room');
  await expect(room).toHaveClass(/actionable/);
  // Specs start with the piles open. Closing the lands stacks them into one pile that says how
  // many are untapped, and glows while a land inside can be used.
  await page.getByRole('button', { name: /^▾ Lands/ }).click();
  await expect(room).toHaveCount(0);
  await expect(permanent(page, 'Forest')).toHaveCount(0);
  const lands = page.locator('.human-zone .zone-pile', { hasText: 'Lands' });
  await expect(lands).toHaveAttribute('aria-expanded', 'false');
  await expect(lands).toContainText(/\d+ untapped/);
  await expect(lands).toHaveClass(/actionable/);
  await lands.click();
  await expect(room).toBeVisible();
  await expect(room).toHaveClass(/actionable/);

  // The graveyard pile opens and closes its cards under the hand.
  const graveyard = page.locator('.human-zone .zone-pile', { hasText: 'Graveyard' });
  await expect(graveyard).toHaveAttribute('aria-expanded', 'true');
  await graveyard.click();
  await expect(graveyard).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#player-zones .zone', { hasText: 'Graveyard' })).toHaveCount(0);
  await graveyard.click();
  await expect(graveyard).toHaveAttribute('aria-expanded', 'true');

  // Your resources sit in the top bar.
  await expect(page.locator('#top-bar-status')).toContainText(/Mana ready\s*\d/);

  // Tap a Forest by hand (ADR 0030): its {G} floats, and War Room's {3} spends it first, so only
  // two more Forests tap for it below.
  const untappedForests = page
    .locator('.human-zone .object')
    .filter({ has: page.getByRole('img', { name: 'Forest', exact: true }) })
    .filter({ hasNot: page.locator('.tile.tapped') });
  await expect(untappedForests.locator('.mana-tap')).toHaveCount(1);
  await untappedForests.click();
  await expect(page.locator('#top-bar-status')).toContainText(/Floating\s*1G/);
  await expect(
    page.locator('.player-game .log .line .text', { hasText: 'adds {G} with Forest' }),
  ).toHaveCount(1);
  await expect(room).toHaveClass(/actionable/);

  await room.click();
  await expect(page.getByText('Activate War Room')).toBeVisible();
  await confirm(page);

  await expect(life).toHaveText('37');
  await expect(room.locator('.tap-badge')).toHaveText('TAP');
  const forests = page
    .locator('.human-zone .object')
    .filter({ has: page.getByRole('img', { name: 'Forest', exact: true }) });
  await expect(forests).toHaveCount(1);
  await expect(forests).toBeVisible();
  await expect(forests.locator('.stack-count-badge')).toHaveText('×3');
  await expect(forests.locator('.stack-count-badge')).toHaveAttribute(
    'title',
    '3 copies of Forest',
  );
  await expect(forests.locator('.tap-badge')).toHaveText('TAP');
  await expect(hand).toHaveCount(3);
  await expect(handCard(page, 'War Room Action Witness')).toHaveClass(/actionable/);
  await expect(handCard(page, 'War Room Mana Sink')).toBeVisible();
  await expect(handCard(page, 'Three Color Commander')).toBeVisible();
  await expect(life).toHaveText('37');
  await expect(ownDrawLines(page)).toHaveCount(1);
  await expect(ownDrawLines(page).locator('.text')).toHaveText('draws Three Color Commander');
  await expect(
    page.locator('.player-game .log .line .text').filter({ hasText: /Pay life.*resolves/ }),
  ).toHaveCount(1);
  await expect(page.locator('.stack .empty')).toBeVisible();
  await expect(page.getByText(/game over/i)).toHaveCount(0);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect(pass).toBeEnabled();
  await pass.click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('War Room: colorless mana pays a spell cost', async ({ page }) => {
  await runScenario(page, 'War Room: colorless mana pays a spell cost');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(1);
  const sink = handCard(page, 'War Room Mana Sink');
  await expect(sink).toHaveClass(/actionable/);
  await sink.click();
  await expect(page.getByText(/Auto-pay: War Room/i)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  // The turn cap ends this lab game with no winner, which the runner reports as a draw halt
  // rather than `gameOver`, so the view usually stays in player mode with no results panel.
  const closeResults = page.getByRole('button', { name: 'Close results' });
  if (await closeResults.isVisible()) {
    await closeResults.click();
  }
  await expect(permanent(page, 'War Room').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'War Room Mana Sink')).toBeVisible();
  await expect(
    page.locator('.human-zone .life-badge, .seat[data-seat="P1"] .life-badge'),
  ).toHaveText('40');
  await expect(
    page
      .locator('.log .line')
      .filter({ has: page.locator('.actor', { hasText: /^P1$/ }) })
      .locator('.text')
      .filter({ hasText: /^War Room Mana Sink resolves$/ }),
  ).toHaveCount(1);
  await expect(
    page
      .locator('.log .line')
      .filter({ has: page.locator('.actor', { hasText: /^P1$/ }) })
      .filter({ has: page.locator('.text', { hasText: /^draws / }) }),
  ).toHaveCount(0);
  await expect(page.locator('.stack .empty')).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// Coverage PR01 (docs/plans/card-coverage-chunks.md)
// ---------------------------------------------------------------------------------------------

test('Forum of Amity: surveil 1 through the normal activation', async ({ page }) => {
  await runScenario(page, 'Forum of Amity: surveil 1 through the normal activation');

  const forum = permanent(page, 'Forum of Amity');
  await expect(forum).toHaveClass(/actionable/);
  await forum.click();
  await expect(page.getByText('Activate Forum of Amity')).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/surveil/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Keep on top' })).toBeVisible();
  await page.getByRole('button', { name: 'Put into graveyard' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Forum of Amity').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Forum Surveilled Card/).first()).toBeVisible();
});

test('Attune with Aether: reveal a basic land, then get two energy', async ({ page }) => {
  await runScenario(page, 'Attune with Aether: reveal a basic land, then get two energy');

  const attune = handCard(page, 'Attune with Aether');
  await expect(attune).toHaveClass(/actionable/);
  await attune.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  await page.getByRole('button', { name: 'Put into your hand' }).click();

  // The revealed Island is now a playable land in hand, so passing asks about the land drop.
  await expect(page.getByText('reveals Island').first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Island')).toBeVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: /haven't played a land/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pass anyway' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Attune Private Library Secret')).toHaveCount(0);
});

test('Beacon of Unrest: reanimate a creature card, shuffle Beacon away', async ({ page }) => {
  await runScenario(page, 'Beacon of Unrest: reanimate a creature card, shuffle Beacon away');

  const beacon = handCard(page, 'Beacon of Unrest');
  await expect(beacon).toHaveClass(/actionable/);
  await beacon.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.locator('.target-instruction')).toHaveText(
    'Target 1 of 1: click a highlighted card or player.',
  );
  await page
    .locator('.zone-card-thumb.targetable')
    .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
    .click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(page.getByText(/Graveyard\s*0/).first()).toBeVisible();
  await expect(page.getByText(/Library\s*1/).first()).toBeVisible();
});

test('Canoptek Spyder: a Vehicle entering draws a card', async ({ page }) => {
  await runScenario(page, 'Canoptek Spyder: a Vehicle entering draws a card');

  const skiff = handCard(page, 'Lab Skiff');
  await expect(skiff).toHaveClass(/actionable/);
  await skiff.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Skiff')).toBeVisible();
  await expect(handCard(page, 'Spyder Drawn Card')).toBeVisible();
});

test('Canoptek Wraith: pay, sacrifice, and fetch same-name basics', async ({ page }) => {
  await runScenario(page, 'Canoptek Wraith: pay, sacrifice, and fetch same-name basics');

  // Nothing is castable, so precombat priority passes itself and combat begins.
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Canoptek Wraith' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Combat damage triggers Transdimensional Scout: pay {3} and sacrifice through the normal panel.
  await expect(page.getByText(/pay \{3\} and sacrifice Canoptek Wraith/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay {3} and sacrifice Canoptek Wraith' }).click();

  // Choose a land you control: one option per distinct land name.
  await expect(page.getByText(/choose a land you control/i).first()).toBeVisible();
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Island' })
    .getByRole('button', { name: 'Choose' })
    .click();

  // Only Islands are offered; take two.
  const put = page.getByRole('button', { name: 'Put onto the battlefield tapped' });
  await expect(page.getByText(/search your library/i).first()).toBeVisible();
  await expect(page.locator('.panel-group').filter({ hasText: 'Forest' })).toHaveCount(0);
  await put.first().click();
  await expect(page.getByText(/search your library/i).first()).toBeVisible();
  await put.first().click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Canoptek Wraith')).toHaveCount(0);
  await expect(permanent(page, 'Island')).toContainText('×5');
  await expect(page.getByText(/Graveyard\s*1/).first()).toBeVisible();
});

test("Conjurer's Closet: blink a creature at your end step", async ({ page }) => {
  await runScenario(page, "Conjurer's Closet: blink a creature at your end step");

  // Nothing is castable in the main phase, so the lab moves on to the end step trigger.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Greeter')).not.toHaveClass(/tapped/);
  await expect(page.getByText(/gains 2 life/).first()).toBeVisible();
});

test('Harvest Season: search a basic per tapped creature', async ({ page }) => {
  await runScenario(page, 'Harvest Season: search a basic per tapped creature');

  const harvest = handCard(page, 'Harvest Season');
  await expect(harvest).toHaveClass(/actionable/);
  await harvest.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  const put = (land: string) =>
    page
      .locator('.panel-group')
      .filter({ hasText: land })
      .getByRole('button', { name: 'Put onto the battlefield tapped' });
  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await put('Island').click();
  await expect(page.getByText(/search your library/i).first()).toBeVisible();
  await put('Plains').click();

  // X was 2, so there is no third search.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Island').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Swamp')).toHaveCount(0);
});

test('Land Tax: reveal three basics at your upkeep', async ({ page }) => {
  await runScenario(page, 'Land Tax: reveal three basics at your upkeep');

  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  for (const land of ['Plains', 'Swamp', 'Island']) {
    await expect(page.getByText(/search your library/i).first()).toBeVisible();
    await page
      .locator('.panel-group')
      .filter({ hasText: land })
      .getByRole('button', { name: 'Put into your hand' })
      .click();
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  for (const land of ['Plains', 'Swamp', 'Island']) {
    await expect(page.getByText(`reveals ${land}`).first()).toBeVisible();
    await expect(handCard(page, land)).toBeVisible();
  }
  await expect(page.getByText('Land Tax Private Secret')).toHaveCount(0);
});

test("Mordant Dragon: redirect combat damage to that player's creature", async ({ page }) => {
  await runScenario(page, "Mordant Dragon: redirect combat damage to that player's creature");

  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Mordant Dragon' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The trigger targets a creature P2 controls; Lab Ox and Lab Servo are both legal.
  await expect(page.getByText(/Choose targets for Mordant Dragon/).first()).toBeVisible({
    timeout: 15_000,
  });
  // The target tray opens directly for a triggered ability's target choice.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/use this ability/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('35');
});

test('Necron Deathmark: destroy up to one creature, mill three', async ({ page }) => {
  await runScenario(page, 'Necron Deathmark: destroy up to one creature, mill three');

  // P3's spell is on the stack, so only a spell with flash can be cast now.
  await expect(handCard(page, 'Lab Deathmark Bystander')).not.toHaveClass(/actionable/);
  const deathmark = handCard(page, 'Necron Deathmark');
  await expect(deathmark).toHaveClass(/actionable/);
  await deathmark.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The ordinary player slot opens the target tray; then the up-to-one creature slot asks.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(
    page.getByText(/choose a target \(0\/1 chosen\), or stop choosing/i).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible();
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
  await expect(page.getByText(/mills Forest/).first()).toBeVisible();
});

test('Plasmancer: enters and reveals a basic Swamp', async ({ page }) => {
  await runScenario(page, 'Plasmancer: enters and reveals a basic Swamp');

  const plasmancer = handCard(page, 'Plasmancer');
  await expect(plasmancer).toHaveClass(/actionable/);
  await plasmancer.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The enters trigger searches: only the basic Swamp is offered, never the Forest.
  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  await expect(page.locator('.panel-group').filter({ hasText: 'Forest' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Put into your hand' }).click();

  await expect(page.getByText('reveals Swamp').first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Swamp')).toBeVisible();
  await expect(permanent(page, 'Plasmancer')).toBeVisible();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: /haven't played a land/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pass anyway' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Plasmancer Private Library Secret')).toHaveCount(0);
});

test('Sylvan Reclamation: exile up to two artifacts and/or enchantments', async ({ page }) => {
  await runScenario(page, 'Sylvan Reclamation: exile up to two artifacts and/or enchantments');

  const reclamation = handCard(page, 'Sylvan Reclamation');
  await expect(reclamation).toHaveClass(/actionable/);
  await reclamation.click();
  // The card offers both the spell and basic landcycling, so pick the spell explicitly.
  await expect(page.getByRole('button', { name: /^Basic landcycling \{2\}/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cast {3}{W}{G}' }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Up to two: each target is one choice, and stopping is always allowed.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Lab Ox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Servo' }).click();
  await expect(page.getByRole('button', { name: 'Target Lab Servo' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Hex' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(permanent(page, 'Lab Idol')).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
});

test('Sylvan Reclamation: basic landcycling reveals a basic land', async ({ page }) => {
  await runScenario(page, 'Sylvan Reclamation: basic landcycling reveals a basic land');

  const reclamation = handCard(page, 'Sylvan Reclamation');
  await expect(reclamation).toHaveClass(/actionable/);
  // Two lands cannot cast the spell, so landcycling is the card's only action.
  await reclamation.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The Plains is the only basic land in the library; the search may still find nothing.
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible({
    timeout: 15_000,
  });
  const putIntoHand = page.getByRole('button', { name: 'Put into your hand' });
  await expect(putIntoHand).toHaveCount(1);
  await putIntoHand.click();
  await expect(page.getByText('reveals Plains').first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Plains')).toBeVisible();
  await expect(handCard(page, 'Sylvan Reclamation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: /haven't played a land/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pass anyway' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Reclamation Private Library Secret')).toHaveCount(0);
});

test('Thunderfoot Baloth: lieutenant pumps your creatures', async ({ page }) => {
  await runScenario(page, 'Thunderfoot Baloth: lieutenant pumps your creatures');

  // Before the Baloth: printed stats only.
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');
  const baloth = handCard(page, 'Thunderfoot Baloth');
  await expect(baloth).toHaveClass(/actionable/);
  await baloth.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Thunderfoot Baloth')).toContainText('7/7');
  await expect(permanent(page, 'Lab General')).toContainText('4/4');
  await expect(permanent(page, 'Lab Ox')).toContainText('6/6');
  await expect(permanent(page, 'Lab Servo')).toContainText('1/1');
  await expect(permanent(page, 'Lab Ox')).toContainText(/trample/i);
  await expect(permanent(page, 'Lab Servo')).not.toContainText(/trample/i);
  await expect(permanent(page, 'Lab Relic')).not.toContainText(/trample/i);
});

test('Tomb Fortress: mill four, then return a creature card', async ({ page }) => {
  await runScenario(page, 'Tomb Fortress: mill four, then return a creature card');

  const fortress = permanent(page, 'Tomb Fortress');
  await expect(fortress).toHaveClass(/actionable/);
  await fortress.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The choice comes after the mill, so the just-milled Lab Ox is offered beside Lab Servo.
  await expect(page.getByText(/choose a card to return from your graveyard/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.panel-group').filter({ hasText: 'Lab Servo' })).toBeVisible();
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'Return' })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Tomb Fortress')).toHaveCount(0);
});

test('Voice of Many: draw for each opponent with fewer creatures', async ({ page }) => {
  await runScenario(page, 'Voice of Many: draw for each opponent with fewer creatures');

  const voice = handCard(page, 'Voice of Many');
  await expect(voice).toHaveClass(/actionable/);
  await voice.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Voice of Many')).toBeVisible();
  // Two of the three opponents control fewer creatures, so exactly two cards are drawn.
  await expect(page.getByText(/Hand\s*2/).first()).toBeVisible();
  await expect(page.getByText(/Library\s*1/).first()).toBeVisible();
});

test('Foe-Razer Regent: fight on entry, grow at the end step', async ({ page }) => {
  await runScenario(page, 'Foe-Razer Regent: fight on entry, grow at the end step');

  const regent = handCard(page, 'Foe-Razer Regent');
  await expect(regent).toHaveClass(/actionable/);
  await regent.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Lab Ox is the only creature P1 doesn't control, so the target is forced; the fight is optional.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Foe-Razer Regent')).toContainText('6/7');
});

test('Hunting Wilds: kicked, two Forests become 3/3 haste creatures', async ({ page }) => {
  await runScenario(page, 'Hunting Wilds: kicked, two Forests become 3/3 haste creatures');

  const wilds = handCard(page, 'Hunting Wilds');
  await expect(wilds).toHaveClass(/actionable/);
  await wilds.click();
  // The card offers a plain cast and a kicked one; choose the kicker.
  await expect(page.getByRole('button', { name: 'Cast {3}{G}', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cast with kicker 1 {6}{G}{G}' }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  const put = page.getByRole('button', { name: 'Put onto battlefield tapped' });
  await expect(page.getByText(/search for a Forest card/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await put.first().click();
  await expect(page.getByText(/search for a Forest card/i).first()).toBeVisible();
  await put.first().click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Forest').filter({ hasText: '3/3' })).not.toHaveCount(0);
  await expect(permanent(page, 'Forest').filter({ hasText: /haste/i })).not.toHaveCount(0);
});

test('Loran of the Third Path: destroy up to one artifact or enchantment', async ({ page }) => {
  await runScenario(page, 'Loran of the Third Path: destroy up to one artifact or enchantment');

  const loran = handCard(page, 'Loran of the Third Path');
  await expect(loran).toHaveClass(/actionable/);
  await loran.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Up to one: stopping is allowed, and the creature-only Lab Ox is never offered.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Lab Servo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Target Lab Ox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Hex' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
});

test('Loran of the Third Path: you and target opponent each draw', async ({ page }) => {
  await runScenario(page, 'Loran of the Third Path: you and target opponent each draw');

  const loran = permanent(page, 'Loran of the Third Path');
  await expect(loran).toHaveClass(/actionable/);
  await loran.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent').filter({ hasText: 'P3' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Hand\s*1/).first()).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P3' })).toContainText('1 in hand');
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('0 in hand');
});

test('Rishkar, Peema Renegade: two counters, then countered creatures tap for G', async ({
  page,
}) => {
  await runScenario(
    page,
    'Rishkar, Peema Renegade: two counters, then countered creatures tap for G',
  );

  await expect(page.getByText(/Mana ready\s*3/).first()).toBeVisible();
  const rishkar = handCard(page, 'Rishkar, Peema Renegade');
  await expect(rishkar).toHaveClass(/actionable/);
  await rishkar.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Up to two targets, any controller, one decision each.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  await expect(page.getByRole('button', { name: 'Target Lab Ox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Servo' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
  await expect(permanent(page, 'Lab Servo')).toContainText('2/2');
  // The countered Lab Ox now taps for {G}: one ready source (Rishkar itself is summoning sick).
  await expect(page.getByText(/Mana ready\s*1/).first()).toBeVisible();
});

test('Vastwood Surge: kicked, two basics and counters on your creatures', async ({ page }) => {
  await runScenario(page, 'Vastwood Surge: kicked, two basics and counters on your creatures');

  const surge = handCard(page, 'Vastwood Surge');
  await expect(surge).toHaveClass(/actionable/);
  await surge.click();
  // The card offers a plain cast and a kicked one; choose the kicker.
  await expect(page.getByRole('button', { name: 'Cast {3}{G}', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cast with kicker 1 {7}{G}' }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  const put = (land: string) =>
    page
      .locator('.panel-group')
      .filter({ hasText: land })
      .getByRole('button', { name: 'Put onto the battlefield tapped' });
  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await put('Plains').click();
  await expect(page.getByText(/search your library/i).first()).toBeVisible();
  await put('Island').click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('6/6');
  await expect(permanent(page, 'Lab Servo')).toContainText('1/1');
  await expect(permanent(page, 'Plains')).toBeVisible();
  await expect(permanent(page, 'Island')).toBeVisible();
});

test('Frontier Siege: Khans adds {G}{G} at your next main phase', async ({ page }) => {
  await runScenario(page, 'Frontier Siege: Khans adds {G}{G} at your next main phase');

  const siege = handCard(page, 'Frontier Siege');
  await expect(siege).toHaveClass(/actionable/);
  await siege.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/Choose Khans or Dragons/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Khans —/ }).click();

  // With every land tapped, Lab Wurm only becomes castable from the postcombat {G}{G}.
  const wurm = handCard(page, 'Lab Wurm');
  await expect(wurm).toHaveClass(/actionable/, { timeout: 15_000 });
  await expect(page.getByText(/Main phase\s*2/).first()).toBeVisible();
  await expect(page.getByText(/2G/).first()).toBeVisible();
  await wurm.click();
  // Paid from the floating {G}{G}, so no land is auto-tapped.
  await expect(page.getByText(/Pending\s*Cast Lab Wurm/i)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Wurm')).toBeVisible();
});

test('Frontier Siege: Dragons lets an entering flier fight', async ({ page }) => {
  await runScenario(page, 'Frontier Siege: Dragons lets an entering flier fight');

  const siege = handCard(page, 'Frontier Siege');
  await expect(siege).toHaveClass(/actionable/);
  await siege.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/Choose Khans or Dragons/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Dragons —/ }).click();

  const drake = handCard(page, 'Lab Drake');
  await expect(drake).toHaveClass(/actionable/, { timeout: 15_000 });
  await drake.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Lab Servo is the only creature P1 doesn't control, so the target is forced; the fight is optional.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Drake')).toBeVisible();
});

test('Kairi, the Swirling Sky: dies, bounce up to total mana value 6', async ({ page }) => {
  await runScenario(page, 'Kairi, the Swirling Sky: dies, bounce up to total mana value 6');

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Kairi, the Swirling Sky').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The mode is chosen as the dies trigger is put on the stack.
  await page
    .getByRole('button', { name: /^Return any number of target nonland permanents/ })
    .click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  // Lab Ox spent 4 of the 6: Lab Hex (3) no longer fits, Lab Idol (2) does.
  await expect(page.getByRole('button', { name: 'Target Lab Idol' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Target Lab Hex' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Idol' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Idol')).toHaveCount(0);
  await expect(permanent(page, 'Lab Hex')).toBeVisible();
});

test('Kairi, the Swirling Sky: dies, mill six and return a spell', async ({ page }) => {
  await runScenario(page, 'Kairi, the Swirling Sky: dies, mill six and return a spell');

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Kairi, the Swirling Sky').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await page.getByRole('button', { name: /^Mill six cards/ }).click({ timeout: 15_000 });
  await expect(page.getByText(/choose instant\/sorcery card/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Lab Shock' })
    .getByRole('button', { name: 'Return to hand' })
    .click();
  await expect(page.getByText(/choose instant\/sorcery card/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Done returning spells' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Lab Shock')).toBeVisible();
  await expect(page.getByText(/Library\s*0/).first()).toBeVisible();
});

test('Will of the Mardu: choose both while you control a commander', async ({ page }) => {
  await runScenario(page, 'Will of the Mardu: choose both while you control a commander');

  const will = handCard(page, 'Will of the Mardu');
  await expect(will).toHaveClass(/actionable/);
  await will.click();
  // Controlling a commander unlocks the combined choice beside each single mode.
  await page.getByRole('button', { name: /Warrior.*; Deal damage/ }).click();
  await expect(page.getByText(/Target 1 of 2/)).toBeVisible();
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/Target 2 of 2/)).toBeVisible();
  await permanent(page, 'Lab Brute').click();
  await expect(page.getByText(/All 2 targets selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Brute')).toHaveCount(0);
  await expect(permanent(page, 'Warrior').first()).toBeVisible();
});

test('Aether Channeler: return another target nonland permanent', async ({ page }) => {
  await runScenario(page, 'Aether Channeler: return another target nonland permanent');

  const channeler = handCard(page, 'Aether Channeler');
  await expect(channeler).toHaveClass(/actionable/);
  await channeler.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The mode is chosen first; only the return mode then asks for a target.
  await expect(page.getByRole('button', { name: /^Create a 1\/1 white Bird/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Draw a card', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Return another target nonland permanent/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('1 in hand');
  await expect(permanent(page, 'Aether Channeler')).toBeVisible();
});

test('Aether Channeler: create a 1/1 white Bird with flying', async ({ page }) => {
  await runScenario(page, 'Aether Channeler: create a 1/1 white Bird with flying');

  const channeler = handCard(page, 'Aether Channeler');
  await expect(channeler).toHaveClass(/actionable/);
  await channeler.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await page.getByRole('button', { name: /^Create a 1\/1 white Bird/ }).click({ timeout: 15_000 });

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Bird')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('0 in hand');
  await expect(page.getByText(/Hand\s*0/).first()).toBeVisible();
});

test('Aether Channeler: draw a card', async ({ page }) => {
  await runScenario(page, 'Aether Channeler: draw a card');

  const channeler = handCard(page, 'Aether Channeler');
  await expect(channeler).toHaveClass(/actionable/);
  await channeler.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await page.getByRole('button', { name: 'Draw a card', exact: true }).click({ timeout: 15_000 });

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Hand\s*1/).first()).toBeVisible();
  await expect(permanent(page, 'Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
});

test('Return to Nature: destroy target enchantment', async ({ page }) => {
  await runScenario(page, 'Return to Nature: destroy target enchantment');

  const nature = handCard(page, 'Return to Nature');
  await expect(nature).toHaveClass(/actionable/);
  await nature.click();
  // No artifact is on the battlefield, so that mode is not offered.
  await expect(
    page.getByRole('button', { name: /Exile target card from a graveyard/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Destroy target artifact/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Destroy target enchantment/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Hex').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
});

test('Return to Nature: exile target card from a graveyard', async ({ page }) => {
  await runScenario(page, 'Return to Nature: exile target card from a graveyard');

  const nature = handCard(page, 'Return to Nature');
  await expect(nature).toHaveClass(/actionable/);
  await nature.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page
    .locator('.zone-card-thumb.targetable')
    .filter({ has: page.getByRole('img', { name: 'Lab Servo', exact: true }) })
    .click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Exile\s*1/).first()).toBeVisible();
});

test('Mystic Sanctuary: enters untapped and returns an instant', async ({ page }) => {
  await runScenario(page, 'Mystic Sanctuary: enters untapped and returns an instant');

  const sanctuary = handCard(page, 'Mystic Sanctuary');
  await expect(sanctuary).toHaveClass(/actionable/);
  await sanctuary.click();

  // Three other Islands: it enters untapped, so the trigger fires; Lab Shock is the only target.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Mystic Sanctuary')).not.toHaveClass(/tapped/);
  await expect(page.getByText(/Library\s*1/).first()).toBeVisible();
  await expect(page.getByText(/Graveyard\s*0/).first()).toBeVisible();
});

test('Brokers Hideout: sacrifice it, then search for a basic', async ({ page }) => {
  await runScenario(page, 'Brokers Hideout: sacrifice it, then search for a basic');

  const hideout = handCard(page, 'Brokers Hideout');
  await expect(hideout).toHaveClass(/actionable/);
  await hideout.click();

  // The enters trigger sacrifices it; the search is a separate (reflexive) trigger.
  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.panel-group').filter({ hasText: 'Swamp' })).toHaveCount(0);
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Plains' })
    .getByRole('button', { name: 'Put onto the battlefield tapped' })
    .click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Brokers Hideout')).toHaveCount(0);
  await expect(permanent(page, 'Plains')).toBeVisible();
  await expect(page.getByText('Put Plains onto the battlefield tapped').first()).toBeVisible();
  await expect(page.getByText('gains 1 life').first()).toBeVisible();
});

test('Sweet-Gum Recluse: counters on creatures that entered this turn', async ({ page }) => {
  await runScenario(page, 'Sweet-Gum Recluse: counters on creatures that entered this turn');

  const sprout = handCard(page, 'Lab Sprout');
  await expect(sprout).toHaveClass(/actionable/);
  await sprout.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // The Recluse has flash, so priority comes back with Lab Sprout on the stack; let it resolve.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(permanent(page, 'Lab Sprout')).toBeVisible({ timeout: 15_000 });

  const recluse = handCard(page, 'Sweet-Gum Recluse');
  await expect(recluse).toHaveClass(/actionable/);
  await recluse.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Lab Ox' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Target Lab Sprout' }).click();
  // With both new creatures chosen there is nothing left to offer, so choosing ends there.
  await page.getByRole('button', { name: 'Target Sweet-Gum Recluse' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Sprout')).toContainText('4/4');
  await expect(permanent(page, 'Sweet-Gum Recluse')).toContainText('3/6');
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');
});

test('Sweet-Gum Recluse: flash in response, cascade into a cheaper spell', async ({ page }) => {
  await runScenario(page, 'Sweet-Gum Recluse: flash in response, cascade into a cheaper spell');

  // P2's spell is on the stack, so only a spell with flash can be cast now.
  await expect(handCard(page, 'Lab Bystander')).not.toHaveClass(/actionable/);
  const recluse = handCard(page, 'Sweet-Gum Recluse');
  await expect(recluse).toHaveClass(/actionable/);
  await recluse.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Cascade exiles until Lab Seedling, the first nonland card with lower mana value.
  await page
    .getByRole('button', { name: 'Cast Lab Seedling without paying its mana cost' })
    .click({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Target Lab Seedling' }).click();
  await page.getByRole('button', { name: 'Target Sweet-Gum Recluse' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Seedling')).toContainText('4/4');
  await expect(permanent(page, 'Sweet-Gum Recluse')).toContainText('3/6');
  await expect(permanent(page, 'Lab Bystander')).toHaveCount(0);
});

test('Sweet-Gum Recluse: reach blocks a flier', async ({ page }) => {
  await runScenario(page, 'Sweet-Gum Recluse: reach blocks a flier');

  // P2 attacks with Lab Drake (flying). Only the Recluse, which has reach, may block it.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  const rows = page.locator('.combat-assignment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Lab Ox' })).toHaveCount(0);
  await rows
    .filter({ hasText: 'Sweet-Gum Recluse' })
    .getByRole('button', { name: 'Lab Drake' })
    .click();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Sweet-Gum Recluse')).toBeVisible();
  await expect(permanent(page, 'Lab Drake')).toBeVisible();
  // Blocked, so none of Lab Drake's damage reaches you.
  await expect(
    page.locator('.human-zone .life-badge, .seat[data-seat="P1"] .life-badge'),
  ).toHaveText('40');
});

test('Kogla, the Titan Ape: fight up to one creature on entry', async ({ page }) => {
  await runScenario(page, 'Kogla, the Titan Ape: fight up to one creature on entry');

  const kogla = handCard(page, 'Kogla, the Titan Ape');
  await expect(kogla).toHaveClass(/actionable/);
  await kogla.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Up to one: stopping is allowed, and only creatures P1 doesn't control are offered.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Lab Servo' })).toBeVisible();
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Kogla, the Titan Ape')).toBeVisible();
});

test('Kogla, the Titan Ape: bounce a Human, then attack', async ({ page }) => {
  await runScenario(page, 'Kogla, the Titan Ape: bounce a Human, then attack');

  const kogla = permanent(page, 'Kogla, the Titan Ape');
  await expect(kogla).toHaveClass(/actionable/);
  await kogla.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Squire').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(handCard(page, 'Lab Squire')).toBeVisible({ timeout: 15_000 });
  await expect(kogla).toContainText(/indestructible/i);

  // Both Forests paid for the ability, so nothing is castable and the lab moves on to combat.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Reset declaration' }).click();
  await expect(page.getByRole('button', { name: 'Confirm attacks' })).toBeVisible();
  // Selecting the creature on the actual battlefield focuses its declaration row.
  await kogla.click();
  await expect(page.locator('.combat-assignment-row.focused')).toContainText('Kogla');
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Kogla, the Titan Ape' })
    .getByRole('button', { name: 'P2' })
    .click();
  // Blur the assignment button to exercise the view-level Enter shortcut, not a native click.
  await page.locator('.interaction-tray .tray-heading').click();
  await page.keyboard.press('Enter');

  // Lab Hex is P2's only artifact or enchantment, so the target is forced; P3's Lab Idol is not.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(permanent(page, 'Lab Idol')).toBeVisible();
});

test('Public zones: reanimate an opponent’s creature', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runScenario(page, 'Public zones: reanimate an opponent’s creature');
  const p2 = page.locator('.opponent[data-seat="P2"]');
  const graveyard = p2.locator('.zone', { hasText: 'Graveyard' });
  const ox = graveyard.locator('.zone-card-thumb').filter({
    has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
  });
  const signet = graveyard.locator('.zone-card-thumb').filter({
    has: page.getByRole('img', { name: 'Eligible Signet', exact: true }),
  });
  await expect(ox).not.toHaveClass(/targetable/);
  await handCard(page, 'Lab Reanimation').click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(ox).toHaveClass(/targetable/);
  await expect(signet).not.toHaveClass(/targetable/);
  await signet.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await ox.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await expect(page.locator('.chosen-targets')).toContainText('Lab Ox');
  await expect(p2).not.toHaveClass(/chosen-target/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await confirm(page);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.human-zone .object').filter({
      has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
    }),
  ).toBeVisible();
  await expect(ox).toHaveCount(0);
  await expect(signet).toBeVisible();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
});

test('Chains of Custody: attach before the entry trigger', async ({ page }) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, 'Chains of Custody: attach before the entry trigger');
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Llanowar Elves')?.id).toBeTruthy();
  const hostId = boards.at(-1)!.find((p) => p.name === 'Llanowar Elves')!.id;
  await handCard(page, 'Chains of Custody').click();
  await permanent(page, 'Llanowar Elves').click();
  await confirm(page);
  // The entry trigger has one legal target, so the engine resolves it automatically.
  await expect(
    page.getByText(/Solemn Simulacrum is exiled by Chains of Custody/i).first(),
  ).toBeVisible();
  await expect(permanent(page, 'Chains of Custody')).toBeVisible();
  await expect(permanent(page, 'Llanowar Elves')).toBeVisible();
  await expect(permanent(page, 'Solemn Simulacrum')).toHaveCount(0);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Chains of Custody')?.attachedTo)
    .toBe(hostId);
});

test('Phyrexian Tower: use the Elf before sacrificing it', async ({ page }) => {
  await runScenario(page, 'Phyrexian Tower: use the Elf before sacrificing it');
  const cultivate = handCard(page, 'Cultivate');
  await expect(cultivate).toHaveClass(/actionable/);
  await cultivate.click();
  await expect(page.getByText(/Auto-pay:.*Llanowar Elves.*Phyrexian Tower/i)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/Cultivate: search your library/i).first()).toBeVisible();
  // Declining the search is legal and keeps this payment regression independent of library choices.
  await page.getByRole('button', { name: 'Find nothing', exact: true }).click();
  await expect(permanent(page, 'Llanowar Elves')).toHaveCount(0);
  await expect(permanent(page, 'Phyrexian Tower').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Cultivate resolves/i).first()).toBeVisible();
});

test('Queen Allenal: plain and lifelink Soldiers stay distinct', async ({ page }) => {
  await runScenario(page, 'Queen Allenal: plain and lifelink Soldiers stay distinct');
  await permanent(page, 'Dawn of Hope').click();
  await confirm(page);
  const soldiers = permanent(page, 'Soldier');
  await expect(soldiers).toHaveCount(2);
  await expect(soldiers.nth(0)).toContainText(/lifelink/i);
  await expect(soldiers.nth(1)).not.toContainText(/lifelink/i);
  await expect(soldiers.nth(0)).toContainText('1/1');
  await expect(soldiers.nth(1)).toContainText('1/1');
});

test('Twinflame Tyrant: double damage from your spell', async ({ page }) => {
  await runScenario(page, 'Twinflame Tyrant: double damage from your spell');
  await handCard(page, 'Lightning Bolt').click();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await confirm(page);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('34');
  await expect(page.getByText(/Lightning Bolt deals 6 to P2/i).first()).toBeVisible();
});

// Coverage PR02 (docs/plans/card-coverage-chunks.md).

/** Click a permanent and take the source action whose button label matches `name`. */
async function activate(page: Page, source: string, name: RegExp): Promise<void> {
  const chip = permanent(page, source);
  await expect(chip).toHaveClass(/actionable/, { timeout: 15_000 });
  await chip.click();
  // A source with one legal action goes straight to payment; several open the action menu.
  // A cost with no mana asks only for confirmation.
  const choice = page.getByRole('button', { name });
  const confirmation = page.getByRole('button', { name: 'Confirm' });
  await expect(choice.or(confirmation).first()).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  await confirm(page);
}

/**
 * Activate `source`'s ability labelled `name` and wait until the action log shows `resolves`
 * resolving once more. Passes priority while the stack is non-empty; when passing is the only
 * legal action the viewer passes on its own, so a pass is never forced into an empty stack.
 */
async function activateAndResolve(
  page: Page,
  source: string,
  name: RegExp,
  resolves: string,
): Promise<void> {
  const before = await page.getByText(`${resolves} resolves`).count();
  await activate(page, source, name);
  await awaitResolution(page, resolves, before);
}

test('Retrofitter Foundry: Servo, Thopter, then Construct', async ({ page }) => {
  await runScenario(page, 'Retrofitter Foundry: Servo, Thopter, then Construct');
  const foundry = 'Retrofitter Foundry';
  const untapped = async () =>
    expect(permanent(page, foundry).locator('.tap-badge')).toHaveCount(0, { timeout: 15_000 });

  await activateAndResolve(
    page,
    foundry,
    /Create a 1\/1 colorless Servo/,
    'Servo artifact creature token.',
  );
  await expect(permanent(page, 'Servo')).toBeVisible();
  await activateAndResolve(page, foundry, /Untap this artifact/, 'Untap this artifact.');
  await untapped();
  await activateAndResolve(
    page,
    foundry,
    /Sacrifice a Servo/,
    'Thopter artifact creature token with flying.',
  );
  await expect(permanent(page, 'Thopter')).toBeVisible();
  await expect(permanent(page, 'Servo')).toHaveCount(0);
  await activateAndResolve(page, foundry, /Untap this artifact/, 'Untap this artifact.');
  await untapped();
  await activateAndResolve(
    page,
    foundry,
    /Sacrifice a Thopter/,
    'Construct artifact creature token.',
  );
  await expect(permanent(page, 'Construct')).toBeVisible();
  await expect(permanent(page, 'Thopter')).toHaveCount(0);

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Construct')).toBeVisible();
});

/** Pass priority whenever offered until `target` is visible. */
async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        // The viewer passes on its own when passing is its only legal action, so the button can
        // vanish between the check and the click; never let one click block the poll.
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Like `passUntil`, but passes only while something is on the stack: for a wait whose next step
 * needs the same main phase, where a pass on an empty stack would end it.
 */
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

/** Wait until the action log shows `resolves` resolving more than `before` times. */
async function awaitResolution(page: Page, resolves: string, before: number): Promise<void> {
  const resolved = page.getByText(`${resolves} resolves`);
  const empty = page.getByText('empty', { exact: true });
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if ((await resolved.count()) > before) return true;
        if ((await empty.count()) === 0 && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Cast a hand card with auto-pay and wait for it to resolve. */
async function castAndResolve(page: Page, name: string): Promise<void> {
  const before = await page.getByText(`${name} resolves`).count();
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, name, before);
}

test('Aether Hub: enter for energy, then pay it for green', async ({ page }) => {
  await runScenario(page, 'Aether Hub: enter for energy, then pay it for green');
  await expect(handCard(page, 'Lab Green Bear')).not.toHaveClass(/actionable/);

  await handCard(page, 'Aether Hub').click();
  await awaitResolution(page, 'Enters — gain one energy', 0);
  await expect(permanent(page, 'Aether Hub').locator('.tap-badge')).toHaveCount(0);

  await castAndResolve(page, 'Lab Green Bear');
  await expect(permanent(page, 'Lab Green Bear')).toBeVisible();
  await expect(permanent(page, 'Aether Hub').locator('.tap-badge')).toHaveText('TAP');

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Aether Hub: colorless mana with no energy', async ({ page }) => {
  await runScenario(page, 'Aether Hub: colorless mana with no energy');
  await expect(handCard(page, 'Lab Green Bear')).not.toHaveClass(/actionable/);

  await castAndResolve(page, 'Lab Generic Bear');
  await expect(permanent(page, 'Lab Generic Bear')).toBeVisible();
  await expect(permanent(page, 'Aether Hub').locator('.tap-badge')).toHaveText('TAP');
  await expect(handCard(page, 'Lab Green Bear')).toBeVisible();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Solar Transformer: enter tapped for energy, then pay it for red', async ({ page }) => {
  await runScenario(page, 'Solar Transformer: enter tapped for energy, then pay it for red');
  await expect(handCard(page, 'Lab Red Bear')).not.toHaveClass(/actionable/);

  await castAndResolve(page, 'Solar Transformer');
  await awaitResolution(page, 'Enters — gain three energy', 0);
  const transformers = permanent(page, 'Solar Transformer');
  await expect(transformers.locator('.stack-count-badge')).toHaveCount(0);
  await expect(transformers).toHaveCount(2);

  await castAndResolve(page, 'Lab Red Bear');
  await expect(permanent(page, 'Lab Red Bear')).toBeVisible();
  for (const chip of await transformers.all()) {
    await expect(chip.locator('.tap-badge')).toHaveText('TAP');
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Solar Transformer: colorless mana with no energy', async ({ page }) => {
  await runScenario(page, 'Solar Transformer: colorless mana with no energy');
  await expect(handCard(page, 'Lab Red Bear')).not.toHaveClass(/actionable/);

  await castAndResolve(page, 'Lab Generic Bear');
  await expect(permanent(page, 'Lab Generic Bear')).toBeVisible();
  await expect(permanent(page, 'Solar Transformer').locator('.tap-badge')).toHaveText('TAP');
  await expect(handCard(page, 'Lab Red Bear')).toBeVisible();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Bespoke Battlewagon: tap for energy, then crew 4', async ({ page }) => {
  await runScenario(page, 'Bespoke Battlewagon: tap for energy, then crew 4');
  const wagon = 'Bespoke Battlewagon';

  await activateAndResolve(page, wagon, /You get \{E\}\{E\}/, 'You get {E}{E}.');
  await expect(permanent(page, wagon).locator('.tap-badge')).toHaveText('TAP');
  await activateAndResolve(page, wagon, /Crew 4/, 'Crew 4');
  await expect(permanent(page, 'Lab Giant').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, wagon)).toContainText('5/6');

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Bespoke Battlewagon: pay four energy to animate, then draw', async ({ page }) => {
  await runScenario(page, 'Bespoke Battlewagon: pay four energy to animate, then draw');
  const wagon = 'Bespoke Battlewagon';

  await activateAndResolve(
    page,
    wagon,
    /becomes an artifact creature/,
    'becomes an artifact creature until end of turn.',
  );
  await expect(permanent(page, wagon)).toContainText('5/6');
  await expect(permanent(page, wagon).locator('.tap-badge')).toHaveCount(0);
  await activateAndResolve(page, wagon, /Draw a card/, 'Draw a card.');
  await expect(handCard(page, 'Forest')).toBeVisible();

  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  const skipLand = page.getByRole('button', { name: 'Pass anyway' });
  if (await skipLand.isVisible()) await skipLand.click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test("Bespoke Battlewagon: pay two energy to tap P2's creature", async ({ page }) => {
  await runScenario(page, "Bespoke Battlewagon: pay two energy to tap P2's creature");
  const wagon = permanent(page, 'Bespoke Battlewagon');
  await expect(wagon).toHaveClass(/actionable/);
  await wagon.click();
  await page.getByRole('button', { name: /Tap target creature/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Tap target creature.', 0);
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');
  await expect(wagon.locator('.tap-badge')).toHaveText('TAP');

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Endless Atlas: three Forests unlock the draw', async ({ page }) => {
  await runScenario(page, 'Endless Atlas: three Forests unlock the draw');
  await activateAndResolve(page, 'Endless Atlas', /Draw a card/, 'lands with the same name.');
  await expect(handCard(page, 'Atlas Drawn Page')).toBeVisible();
  await expect(permanent(page, 'Endless Atlas').locator('.tap-badge')).toHaveText('TAP');
  await passUntil(page, page.getByText(/game over/i).first());
});

test('Endless Atlas: two Forests and an Island do not unlock it', async ({ page }) => {
  await runScenario(page, 'Endless Atlas: two Forests and an Island do not unlock it');
  // With no legal action but passing, the viewer passes on its own and the window closes.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Endless Atlas')).toBeVisible();
  await expect(permanent(page, 'Endless Atlas').locator('.tap-badge')).toHaveCount(0);
  await expect(page.getByText('Atlas Drawn Page')).toHaveCount(0);
});

test('Sceptre of Eternal Glory: three Forests unlock {B}{B}{B}', async ({ page }) => {
  await runScenario(page, 'Sceptre of Eternal Glory: three Forests unlock {B}{B}{B}');
  await castAndResolve(page, 'Lab Black Ogre');
  await expect(permanent(page, 'Lab Black Ogre')).toBeVisible();
  await expect(permanent(page, 'Sceptre of Eternal Glory').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Sceptre of Eternal Glory: mixed lands give one mana', async ({ page }) => {
  await runScenario(page, 'Sceptre of Eternal Glory: mixed lands give one mana');
  await expect(handCard(page, 'Lab Black Ogre')).not.toHaveClass(/actionable/);
  await castAndResolve(page, 'Lab Black Bear');
  await expect(permanent(page, 'Lab Black Bear')).toBeVisible();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Lab Black Ogre')).toBeVisible();
});

test('Weathered Wayfarer: behind on lands, reveal a land', async ({ page }) => {
  await runScenario(page, 'Weathered Wayfarer: behind on lands, reveal a land');
  await activate(page, 'Weathered Wayfarer', /Search your library/);
  // The viewer may pass on its own when passing is the only legal action, so never click Pass
  // once unconditionally: pass only while the search prompt has not appeared.
  await passUntil(page, page.getByRole('button', { name: 'Find nothing' }));
  await expect(page.getByText(/search your library/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  await expect(page.locator('.panel-group').filter({ hasText: 'Island' })).toHaveCount(1);
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Wayfarer Revealed Land' })
    .getByRole('button', { name: 'Put into your hand' })
    .click();
  await expect(page.getByText('reveals Wayfarer Revealed Land').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(handCard(page, 'Wayfarer Revealed Land')).toBeVisible();
});

test('Weathered Wayfarer: equal lands do not unlock it', async ({ page }) => {
  await runScenario(page, 'Weathered Wayfarer: equal lands do not unlock it');
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Weathered Wayfarer').locator('.tap-badge')).toHaveCount(0);
  await expect(page.getByText('Wayfarer Revealed Land')).toHaveCount(0);
});

test('Idol of Oblivion: make a token, then draw', async ({ page }) => {
  await runScenario(page, 'Idol of Oblivion: make a token, then draw');
  await expect(permanent(page, 'Idol of Oblivion')).not.toHaveClass(/actionable/);
  await activateAndResolve(
    page,
    'Lab Token Maker',
    /Create a 1\/1 colorless Servo/,
    'Servo artifact creature token.',
  );
  await expect(permanent(page, 'Servo')).toBeVisible();
  await activateAndResolve(page, 'Idol of Oblivion', /Draw a card/, 'created a token this turn.');
  await expect(handCard(page, 'Idol Drawn Page')).toBeVisible();
});

test('Idol of Oblivion: sacrifice it for a 10/10 Eldrazi', async ({ page }) => {
  await runScenario(page, 'Idol of Oblivion: sacrifice it for a 10/10 Eldrazi');
  await activateAndResolve(
    page,
    'Idol of Oblivion',
    /Create a 10\/10 colorless Eldrazi/,
    'Eldrazi creature token.',
  );
  await expect(permanent(page, 'Eldrazi')).toContainText('10/10');
  await expect(permanent(page, 'Idol of Oblivion')).toHaveCount(0);
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Mistveil Plains: put a graveyard card on the bottom', async ({ page }) => {
  await runScenario(page, 'Mistveil Plains: put a graveyard card on the bottom');
  await expect(page.getByText(/Graveyard\s*1/).first()).toBeVisible();
  const chip = permanent(page, 'Mistveil Plains');
  await expect(chip).toHaveClass(/actionable/);
  await chip.click();
  const choice = page.getByRole('button', { name: /on the bottom of your library/ });
  if (await choice.isVisible()) await choice.click();
  const target = page.getByRole('button', { name: /Mistveil Buried Card/ });
  if (await target.isVisible()) await target.click();
  await confirm(page);
  await awaitResolution(page, 'two or more white permanents.', 0);
  await expect(page.getByText(/Graveyard\s*0/).first()).toBeVisible();
  await expect(page.getByText(/Library\s*2/).first()).toBeVisible();
  await expect(chip.locator('.tap-badge')).toHaveText('TAP');
});

test('Mistveil Plains: one white permanent does not unlock it', async ({ page }) => {
  await runScenario(page, 'Mistveil Plains: one white permanent does not unlock it');
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Graveyard\s*1/).first()).toBeVisible();
  await expect(permanent(page, 'Mistveil Plains').locator('.tap-badge')).toHaveCount(0);
});

test('Carrion Feeder: sacrifice another creature, then itself', async ({ page }) => {
  await runScenario(page, 'Carrion Feeder: sacrifice another creature, then itself');
  const feeder = permanent(page, 'Carrion Feeder');

  for (const victim of ['Lab Thrull', 'Carrion Feeder']) {
    await expect(feeder).toHaveClass(/actionable/, { timeout: 15_000 });
    await feeder.click();
    // With two creatures the sacrifice is chosen by clicking a highlighted permanent; once the
    // Feeder is alone, sacrificing it is the only way to pay and needs no choice.
    await confirm(page);
    if (victim === 'Lab Thrull') {
      await expect(page.getByText(/to sacrifice as an activation cost/).first()).toBeVisible();
      await permanent(page, victim).click();
      await confirm(page);
    }
    await awaitResolution(
      page,
      'Put a +1/+1 counter on this creature.',
      victim === 'Lab Thrull' ? 0 : 1,
    );
    if (victim === 'Lab Thrull') {
      await expect(permanent(page, 'Lab Thrull')).toHaveCount(0);
      await expect(feeder).toContainText('2/2');
    }
  }

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Carrion Feeder')).toHaveCount(0);
  await expect(page.getByText(/Graveyard\s*2/).first()).toBeVisible();
});

test("Carrion Feeder: it can't block", async ({ page }) => {
  await runScenario(page, "Carrion Feeder: it can't block");

  // P2 attacks with Lab Ox. The Feeder's instant-speed ability keeps giving you priority, so
  // pass until the block declaration. Only Lab Thrull may block; Carrion Feeder is never offered.
  const declare = page.getByRole('button', { name: /Declare blockers/ });
  await passUntil(page, declare);
  await declare.click();
  const rows = page.locator('.combat-assignment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Carrion Feeder' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Lab Thrull' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Confirm blocks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.human-zone .life-badge, .seat[data-seat="P1"] .life-badge'),
  ).toHaveText('36');
});

test('Nullmage Shepherd: tap itself and three others to destroy an enchantment', async ({
  page,
}) => {
  await runScenario(
    page,
    'Nullmage Shepherd: tap itself and three others to destroy an enchantment',
  );
  const shepherd = permanent(page, 'Nullmage Shepherd');
  await expect(shepherd).toHaveClass(/actionable/);
  await shepherd.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Hex').click();
  await confirm(page);
  // Any remaining tap choices are made by clicking highlighted creatures, then confirming.
  const thrulls = permanent(page, 'Lab Thrull');
  await expect
    .poll(
      async () => {
        if (
          (await page
            .getByText(/Lab Hex resolves|Destroy target artifact or enchantment\. resolves/)
            .count()) > 0
        )
          return true;
        if (
          await page
            .getByText(/to tap as an activation cost/)
            .first()
            .isVisible()
        ) {
          await thrulls
            .filter({ hasNot: page.locator('.tap-badge') })
            .first()
            .click();
          const confirmButton = page.getByRole('button', { name: 'Confirm' });
          if (await confirmButton.isVisible()) await confirmButton.click();
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(shepherd.locator('.tap-badge')).toHaveText('TAP');
});

test('Sage of Fables: a Wizard enters with a counter, then pay it to draw', async ({ page }) => {
  await runScenario(page, 'Sage of Fables: a Wizard enters with a counter, then pay it to draw');
  await expect(permanent(page, 'Sage of Fables')).not.toHaveClass(/actionable/);
  await castAndResolve(page, 'Lab Wizard');
  await expect(permanent(page, 'Lab Wizard')).toContainText('2/2');
  await activateAndResolve(page, 'Sage of Fables', /Draw a card/, 'Draw a card.');
  await expect(handCard(page, 'Sage Drawn Page')).toBeVisible();
  await expect(permanent(page, 'Lab Wizard')).toContainText('1/1');
});

test('Illuminor Szeras: sacrifice a creature for black mana', async ({ page }) => {
  await runScenario(page, 'Illuminor Szeras: sacrifice a creature for black mana');
  await castAndResolve(page, 'Lab Black Ogre');
  await expect(permanent(page, 'Lab Black Ogre')).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Illuminor Szeras').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Graveyard\s*1/).first()).toBeVisible();
});

test('Peema Trailblazer: exhaust for counters and cards', async ({ page }) => {
  await runScenario(page, 'Peema Trailblazer: exhaust for counters and cards');
  await activateAndResolve(
    page,
    'Peema Trailblazer',
    /Exhaust/,
    'greatest power among creatures you control.',
  );
  await expect(permanent(page, 'Peema Trailblazer')).toContainText('5/5');
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(5);
  // Exhausted: the ability is never offered again.
  await expect(permanent(page, 'Peema Trailblazer')).not.toHaveClass(/actionable/);
});

test('Peema Trailblazer: combat damage gives energy', async ({ page }) => {
  await runScenario(page, 'Peema Trailblazer: combat damage gives energy');
  await expect(permanent(page, 'Peema Trailblazer')).toContainText(/trample/i);
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Peema Trailblazer' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('37');
});

test("Soul-Guide Lantern: enter and exile a card from P2's graveyard", async ({ page }) => {
  await runScenario(page, "Soul-Guide Lantern: enter and exile a card from P2's graveyard");
  const lantern = handCard(page, 'Soul-Guide Lantern');
  await expect(lantern).toHaveClass(/actionable/);
  await lantern.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/Choose targets for Soul-Guide Lantern/).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', { name: /Lantern P2 Card/ })
    .first()
    .click();
  const confirmButton = page.getByRole('button', { name: 'Confirm' });
  if (await confirmButton.isVisible()) await confirmButton.click();
  await passUntil(page, page.getByText(/game over/i).first());
  // P2's graveyard card is now in exile; P3's graveyard card is untouched.
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('Exile (1)');
  await expect(page.locator('.opponent[data-seat="P3"]')).not.toContainText('Exile (');
});

test("Soul-Guide Lantern: sacrifice it to exile each opponent's graveyard", async ({ page }) => {
  await runScenario(page, "Soul-Guide Lantern: sacrifice it to exile each opponent's graveyard");
  await activateAndResolve(
    page,
    'Soul-Guide Lantern',
    /Exile each opponent's graveyard/,
    "Exile each opponent's graveyard.",
  );
  await expect(permanent(page, 'Soul-Guide Lantern')).toHaveCount(0);
  await expect(page.getByText(/Graveyard\s*1/).first()).toBeVisible();
});

test('Soul-Guide Lantern: pay {1} and sacrifice it to draw', async ({ page }) => {
  await runScenario(page, 'Soul-Guide Lantern: pay {1} and sacrifice it to draw');
  await activateAndResolve(page, 'Soul-Guide Lantern', /Draw a card/, 'Draw a card.');
  await expect(handCard(page, 'Lantern Drawn Page')).toBeVisible();
  await expect(permanent(page, 'Soul-Guide Lantern')).toHaveCount(0);
});

test('Ghost Ark: crew it, then unearth an artifact creature', async ({ page }) => {
  await runScenario(page, 'Ghost Ark: crew it, then unearth an artifact creature');
  const ark = 'Ghost Ark';
  const graveyard = page.locator('.zones-strip .zone', { hasText: 'Graveyard' });
  const thumb = (name: string) =>
    graveyard.locator('.zone-card-thumb').filter({
      has: page.getByRole('img', { name, exact: true }),
    });

  await expect(permanent(page, ark)).toContainText(/flying/i);
  // No unearth until the Ark becomes crewed.
  await expect(thumb('Lab Ark Thopter')).toBeVisible();
  await expect(thumb('Lab Ark Thopter')).not.toHaveClass(/actionable/);

  const granted = 'gains unearth {3} until end of turn.';
  const before = await page.getByText(`${granted} resolves`).count();
  await activateAndResolve(page, ark, /Crew 2/, 'Crew 2');
  await expect(permanent(page, 'Lab Giant').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, ark)).toContainText('3/3');
  await awaitResolution(page, granted, before);

  // Only the artifact creature card gains unearth.
  await expect(thumb('Lab Ark Thopter')).toHaveClass(/actionable/, { timeout: 15_000 });
  await expect(thumb('Lab Ark Spirit')).not.toHaveClass(/actionable/);
  await thumb('Lab Ark Thopter').click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Unearth {3}', 0);

  await expect(permanent(page, 'Lab Ark Thopter')).toBeVisible();
  await expect(permanent(page, 'Lab Ark Thopter')).toContainText(/haste/i);
  await expect(thumb('Lab Ark Thopter')).toHaveCount(0);
  await expect(thumb('Lab Ark Spirit')).toBeVisible();
  // The Ark can still be crewed again, so the viewer waits for an explicit pass.
  await passUntil(page, page.getByText(/game over/i).first());
});

test("Flare of Denial: sacrifice a blue creature to counter P2's spell", async ({ page }) => {
  await runScenario(page, "Flare of Denial: sacrifice a blue creature to counter P2's spell");
  const flare = handCard(page, 'Flare of Denial');
  await expect(flare).toHaveClass(/actionable/);
  await flare.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const pending = page.locator('.stack li').filter({ hasText: 'Lab Pending Spell' });
  await expect(pending).toHaveClass(/targetable/);
  await pending.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(permanent(page, 'Lab Blue Merfolk')).toHaveCount(0, { timeout: 15_000 });
  await passUntil(page, page.getByText(/Lab Pending Spell is countered by Flare of Denial/i));
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Flare of Malice: sacrifice a black creature; P2 loses its biggest creature', async ({
  page,
}) => {
  await runScenario(
    page,
    'Flare of Malice: sacrifice a black creature; P2 loses its biggest creature',
  );
  const flare = handCard(page, 'Flare of Malice');
  await expect(flare).toHaveClass(/actionable/);
  await flare.click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await confirm(page);
  await expect(permanent(page, 'Lab Black Bear')).toHaveCount(0, { timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Generic Bear')).toBeVisible();
});

test('Blasphemous Edict: pay {B} with thirteen creatures out', async ({ page }) => {
  await runScenario(page, 'Blasphemous Edict: pay {B} with thirteen creatures out');
  const edict = handCard(page, 'Blasphemous Edict');
  await expect(edict).toHaveClass(/actionable/);
  await edict.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Zombie')).toHaveCount(0);
  await expect(permanent(page, 'Swamp')).toBeVisible();
});

test('Dread Return: flash it back by sacrificing three creatures', async ({ page }) => {
  await runScenario(page, 'Dread Return: flash it back by sacrificing three creatures');
  const graveyard = page.locator('.zones-strip .zone', { hasText: 'Graveyard' });
  const thumb = (name: string) =>
    graveyard.locator('.zone-card-thumb').filter({
      has: page.getByRole('img', { name, exact: true }),
    });
  await expect(thumb('Dread Return')).toHaveClass(/actionable/, { timeout: 15_000 });
  await thumb('Dread Return').click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(thumb('Lab Ox')).toHaveClass(/targetable/);
  await thumb('Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(permanent(page, 'Lab Zombie')).toHaveCount(0, { timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
});

test("Raffine's Guidance: cast it from the graveyard for {2}{W}", async ({ page }) => {
  await runScenario(page, "Raffine's Guidance: cast it from the graveyard for {2}{W}");
  const guidance = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: "Raffine's Guidance", exact: true }) });
  await expect(guidance).toHaveClass(/actionable/, { timeout: 15_000 });
  await guidance.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
  await expect(permanent(page, "Raffine's Guidance")).toBeVisible();
});

test('Their Number Is Legion: cast it from the graveyard with X=2', async ({ page }) => {
  await runScenario(page, 'Their Number Is Legion: cast it from the graveyard with X=2');
  const legion = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Their Number Is Legion', exact: true }) });
  await expect(legion).toHaveClass(/actionable/, { timeout: 15_000 });
  await legion.click();
  await expect(page.getByText(/Choose X/)).toBeVisible();
  await page.locator('.x-group input[type="number"]').fill('2');
  await page.locator('.x-group button').click();
  const autoPay = page.getByText(/Auto-pay/);
  if (await autoPay.isVisible()) await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Necron Warrior')).toHaveCount(1);
  await expect(permanent(page, 'Necron Warrior')).toContainText(/×2/);
  await expect(legion).toHaveCount(0);
});

test('Anrakyr the Traveller: attack, then cast an artifact for life', async ({ page }) => {
  await runScenario(page, 'Anrakyr the Traveller: attack, then cast an artifact for life');
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Anrakyr the Traveller' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByRole('button', { name: 'Yes', exact: true }));
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  const golem = page.locator('.panel-group').filter({ hasText: 'Lab Anrakyr Golem' });
  await expect(golem).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.panel-group').filter({ hasText: 'Lab Anrakyr Relic' })).toBeVisible();
  await golem.getByRole('button', { name: 'Cast' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Anrakyr Golem')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('36');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
});

test('Toxic Deluge: pay 2 life for -2/-2', async ({ page }) => {
  await runScenario(page, 'Toxic Deluge: pay 2 life for -2/-2');
  const deluge = handCard(page, 'Toxic Deluge');
  await expect(deluge).toHaveClass(/actionable/);
  await deluge.click();
  await expect(page.getByText(/Choose X/)).toBeVisible();
  await page.locator('.x-group input[type="number"]').fill('2');
  await page.locator('.x-group button').click();
  const autoPay = page.getByText(/Auto-pay/);
  if (await autoPay.isVisible()) await confirm(page);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('38', { timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Zombie')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Lab Giant')).toBeVisible();
});

test('Conclave Tribunal: convoke with three creatures', async ({ page }) => {
  await runScenario(page, 'Conclave Tribunal: convoke with three creatures');
  const tribunal = handCard(page, 'Conclave Tribunal');
  await expect(tribunal).toHaveClass(/actionable/);
  await tribunal.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Conclave Tribunal')).toBeVisible();
  await expect(permanent(page, 'Lab Anrakyr Relic')).toHaveCount(0);
  for (const name of ['Lab Ox', 'Lab Generic Bear', 'Lab Zombie']) {
    await expect(permanent(page, name).locator('.tap-badge')).toHaveText('TAP');
  }
});

test('Hour of Reckoning: three Plains and four convoked creatures', async ({ page }) => {
  await runScenario(page, 'Hour of Reckoning: three Plains and four convoked creatures');
  const hour = handCard(page, 'Hour of Reckoning');
  await expect(hour).toHaveClass(/actionable/);
  await hour.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  for (const name of [
    'Lab Ox',
    'Lab Generic Bear',
    'Lab Zombie',
    'Lab Giant',
    'Lab Anrakyr Golem',
  ]) {
    await expect(permanent(page, name)).toHaveCount(0);
  }
});

test('Killian, Ink Duelist: a {2}{R} bolt at a creature for {R}', async ({ page }) => {
  await runScenario(page, 'Killian, Ink Duelist: a {2}{R} bolt at a creature for {R}');
  const bolt = handCard(page, 'Lab Killian Bolt');
  await expect(bolt).toHaveClass(/actionable/);
  await bolt.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Mountain').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Lab Killian Bolt.*resolves/).first()).toBeVisible();
});

test('Dragonkin Berserker: attack, then Boast for {2}{R}', async ({ page }) => {
  await runScenario(page, 'Dragonkin Berserker: attack, then Boast for {2}{R}');
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Dragonkin Berserker' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await activate(page, 'Dragonkin Berserker', /Create a 5\/5 red Dragon/);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Dragon')).toBeVisible();
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
});

test('Convergence of Dominion: Unearth {3} for {1}', async ({ page }) => {
  await runScenario(page, 'Convergence of Dominion: Unearth {3} for {1}');
  const warrior = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Lab Unearth Warrior', exact: true }) });
  await expect(warrior).toHaveClass(/actionable/, { timeout: 15_000 });
  // By keyboard: the key acts on the card only, so the board's Enter shortcut must not also
  // confirm the payment before it is reviewed. (Other graveyard tests click.)
  await warrior.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
  // Nothing was submitted: give a stray confirm time to reach the server, then check.
  await page.waitForTimeout(1_000);
  await expect(page.locator('.log .line', { hasText: 'Unearth' })).toHaveCount(0);
  await expect(warrior).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Unearth Warrior')).toBeVisible();
  await expect(permanent(page, 'Forest').locator('.tap-badge')).toHaveText('TAP');
});

test("Kogla and Yidaro: enter and fight P2's Lab Ox", async ({ page }) => {
  await runScenario(page, "Kogla and Yidaro: enter and fight P2's Lab Ox");
  const kogla = handCard(page, 'Kogla and Yidaro');
  await expect(kogla).toHaveClass(/actionable/);
  await kogla.click();
  // Six lands pay for both the spell and the hand ability, so pick the spell explicitly.
  await expect(
    page.getByRole('button', { name: /^Destroy up to one target artifact/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cast {2}{R}{R}{G}{G}' }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await page
    .getByRole('button', { name: /^It fights target creature you don't control/ })
    .click({ timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Kogla and Yidaro')).toBeVisible();
});

test("Kogla and Yidaro: discard it to destroy P2's artifact", async ({ page }) => {
  await runScenario(page, "Kogla and Yidaro: discard it to destroy P2's artifact");
  const kogla = handCard(page, 'Kogla and Yidaro');
  await expect(kogla).toHaveClass(/actionable/);
  // Four lands cannot cast the spell, so the hand ability is the card's only action.
  await kogla.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await page.getByRole('button', { name: 'Target Lab Anrakyr Relic' }).click({ timeout: 15_000 });
  // Before the shuffle the library holds a Mountain, a Forest and Lab Zombie; Kogla and Yidaro
  // joins them. Whichever card is drawn, the ability has resolved. Passing now would stop at the
  // land-drop reminder, so stop here.
  await expect(page.getByText(/Kogla and Yidaro.*resolves/).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(permanent(page, 'Lab Anrakyr Relic')).toHaveCount(0);
  await expect(
    page.getByText(/draws (Forest|Mountain|Lab Zombie|Kogla and Yidaro)/).first(),
  ).toBeVisible();
});

test("Changing Loyalty: replicate once onto both of P2's creatures", async ({ page }) => {
  await runScenario(page, "Changing Loyalty: replicate once onto both of P2's creatures");
  const loyalty = handCard(page, 'Changing Loyalty');
  await expect(loyalty).toHaveClass(/actionable/);
  await loyalty.click();
  // The plain cast and the replicated one are separate choices.
  await expect(page.getByRole('button', { name: 'Cast {1}{B}', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cast with replicate 1 {3}{B}' }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // The replicate trigger asks for each copy's target: keep Lab Ox or choose another creature.
  await expect(page.getByRole('button', { name: 'Keep Lab Ox as the target' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Target Lab Generic Bear' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/copies Changing Loyalty/).first()).toBeVisible();
  await expect(page.getByText(/Copy of Changing Loyalty resolves/).first()).toBeVisible();
  // The original and its token copy share one stacked chip on your side of the board.
  await expect(permanent(page, 'Changing Loyalty')).toContainText('×2');
});

test("Changing Loyalty: enchant P2's Lab Ox, destroy it, and take it", async ({ page }) => {
  await runScenario(page, "Changing Loyalty: enchant P2's Lab Ox, destroy it, and take it");
  const loyalty = handCard(page, 'Changing Loyalty');
  await expect(loyalty).toHaveClass(/actionable/);
  await loyalty.click();
  await page.getByRole('button', { name: 'Cast {1}{B}', exact: true }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await confirm(page);
  await awaitResolution(page, 'Changing Loyalty', 0);
  await expect(permanent(page, 'Changing Loyalty')).toBeVisible();

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await confirm(page);
  const stolen = page.locator('.human-zone').getByRole('img', { name: 'Lab Ox', exact: true });
  await passUntil(page, stolen);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).getByRole('img', { name: 'Lab Ox' }),
  ).toHaveCount(0);
  await expect(permanent(page, 'Changing Loyalty')).toHaveCount(0);
});

test('Grim Haruspex: cast it face down, turn it face up, then draw', async ({ page }) => {
  await runScenario(page, 'Grim Haruspex: cast it face down, turn it face up, then draw');
  const haruspex = handCard(page, 'Grim Haruspex');
  await expect(haruspex).toHaveClass(/actionable/);
  await haruspex.click();
  // Its normal cast and the face-down morph cast are separate choices.
  await expect(page.getByRole('button', { name: 'Cast {2}{B}', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Cast Grim Haruspex face down for \{3\}/ }).click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Face-down creature spell', 0);

  // You see your own face-down permanent; turning it face up is a special action.
  await activate(page, 'Grim Haruspex', /Turn face up/);
  await expect(page.getByText(/turns Grim Haruspex face up/).first()).toBeVisible({
    timeout: 15_000,
  });

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Zombie').click();
  await confirm(page);
  // The draw is a Swamp, so passing on would stop at the land-drop reminder: stop at the draw.
  await passUntil(page, page.getByText(/Grim Haruspex.*draw a card.*resolves/).first());
  await expect(permanent(page, 'Lab Zombie')).toHaveCount(0);
  await expect(handCard(page, 'Swamp')).toBeVisible();
});

test('Dream Devourer: foretell a card for {2}', async ({ page }) => {
  await runScenario(page, 'Dream Devourer: foretell a card for {2}');
  const bolt = handCard(page, 'Lab Foretell Bolt');
  await expect(bolt).toHaveClass(/actionable/);
  // Foretelling is a special action with no ability to yield.
  await expect(page.getByRole('button', { name: 'Smart yield Lab Foretell Bolt' })).toHaveCount(0);
  // Two Mountains cannot cast it, so foretelling is the card's only action.
  await bolt.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yield always' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Smart yield', exact: true })).toHaveCount(0);
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Foretell Lab Foretell Bolt/).first()).toBeVisible();
  await expect(page.getByText(/Dream Devourer.*resolves/).first()).toBeVisible();
  await expect(handCard(page, 'Lab Foretell Bolt')).toHaveCount(0);
});

test('Dream Devourer: cast a foretold card for {R}', async ({ page }) => {
  await runScenario(page, 'Dream Devourer: cast a foretold card for {R}');
  const foretold = page
    .locator('.zones-strip .zone', { hasText: 'Exile' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Lab Foretell Bolt', exact: true }) });
  await expect(foretold).toHaveClass(/actionable/, { timeout: 15_000 });
  await foretold.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
});

async function runMosswortCasting(page: Page, hiddenLand: boolean): Promise<void> {
  await runScenario(
    page,
    hiddenLand
      ? 'Mosswort Bridge: a hidden land still needs a land play'
      : 'Mosswort Bridge: cast a hidden permanent on the spell stack',
  );
  await handCard(page, 'Mosswort Bridge').click();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await page
    .getByRole('button', { name: 'Exile face down', exact: true })
    .first()
    .click({ timeout: 15_000 });
  await handCard(page, 'Lab Wake').click();
  await permanent(page, 'Mosswort Bridge').click();
  await confirm(page);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  const activation = page
    .locator('.playable-now')
    .getByRole('button', { name: 'Activate Mosswort Bridge', exact: true });
  await expect(activation).toBeVisible({ timeout: 15_000 });
  await activation.click();
  await confirm(page);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  if (!hiddenLand) {
    await page
      .getByRole('button', { name: 'Play Lab Hidden Titan', exact: true })
      .click({ timeout: 15_000 });
    await expect(permanent(page, 'Lab Hidden Titan')).toHaveCount(0);
    await expect(page.locator('.stack')).toContainText('Lab Hidden Titan');
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
    await expect(permanent(page, 'Lab Hidden Titan')).toContainText('7/7', { timeout: 15_000 });
  }
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.log .line', { hasText: 'plays Mosswort Bridge' })).toHaveCount(1);
  if (hiddenLand)
    await expect(page.locator('.log .line', { hasText: 'plays Forest' })).toHaveCount(0);
  else
    await expect(page.locator('.log .line', { hasText: 'casts Lab Hidden Titan' })).toHaveCount(1);
}

test('Mosswort Bridge: cast a hidden permanent on the spell stack', async ({ page }) => {
  await runMosswortCasting(page, false);
});

test('Mosswort Bridge: a hidden land still needs a land play', async ({ page }) => {
  await runMosswortCasting(page, true);
});

async function verifyTargetUntap(
  page: Page,
  name: string,
  pt: string,
  keyword: string | undefined,
  counters: number,
): Promise<void> {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, `${name}: affect and untap one target`);
  const chosen = permanent(page, 'Chosen Untap Bear');
  const other = permanent(page, 'Other Tapped Bear');
  await expect(chosen.locator('.tile')).toHaveClass(/tapped/);
  await expect(other.locator('.tile')).toHaveClass(/tapped/);
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/);
  await spell.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await chosen.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(chosen).toContainText(pt);
  if (keyword) await expect(chosen).toContainText(keyword);
  await expect(chosen.locator('.tap-badge')).toHaveCount(0);
  await expect(other.locator('.tap-badge')).toHaveCount(1);
  await expect(other).toContainText('2/2');
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Chosen Untap Bear')?.counters['+1/+1'] ?? 0)
    .toBe(counters);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Other Tapped Bear')?.tapped)
    .toBe(true);
  await expect(
    page.getByText(new RegExp(`Cast ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')).first(),
  ).toBeVisible();
}

test('Arachnoid Adaptation: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Arachnoid Adaptation', '4/4', 'reach', 0);
});

test("Riverguard's Reflexes: affect and untap one target", async ({ page }) => {
  await verifyTargetUntap(page, "Riverguard's Reflexes", '4/4', 'first strike', 0);
});

test('Acrobatic Leap: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Acrobatic Leap', '3/5', 'flying', 0);
});

test('Burst of Strength: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Burst of Strength', '3/3', undefined, 1);
});

test('Vines of the Recluse: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Vines of the Recluse', '3/4', 'reach', 0);
});

test('Dragonscale Boon: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Dragonscale Boon', '4/4', undefined, 2);
});

test("Witch's Web: affect and untap one target", async ({ page }) => {
  await verifyTargetUntap(page, "Witch's Web", '5/5', 'reach', 0);
});

test('Pillar Launch: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Pillar Launch', '4/4', 'reach', 0);
});

test("Bull's Strength: affect and untap one target", async ({ page }) => {
  await verifyTargetUntap(page, "Bull's Strength", '4/4', 'trample', 0);
});

test('High Stride: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'High Stride', '3/5', 'reach', 0);
});

test('Wings of the Cosmos: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Wings of the Cosmos', '3/5', 'flying', 0);
});

test("Tethermage's Advantage: affect and untap one target", async ({ page }) => {
  await verifyTargetUntap(page, "Tethermage's Advantage", '4/4', 'reach', 0);
});

test('Vault Skyward: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Vault Skyward', '2/2', 'flying', 0);
});

test('Leaping Ambush: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Leaping Ambush', '3/5', 'reach', 0);
});

test('Escape from Orthanc: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Escape from Orthanc', '3/5', 'flying', 0);
});

test('Soldier On: affect and untap one target', async ({ page }) => {
  await verifyTargetUntap(page, 'Soldier On', '4/4', undefined, 2);
});

async function runSelectedFaceViewer(
  page: Page,
  name: string,
  half: boolean,
  commander = false,
  impulse = false,
): Promise<void> {
  const expected = SPELL_FACE_LAB_EXPECTATIONS.find((entry) => entry.name === name)!;
  const pin = SPELL_FACE_VIEWER_PINS.cards.find(
    ({ card }) => card.name.split(' // ')[0] === name,
  )!.card;
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    impulse
      ? `${pin.backFace!.name}: cast the spell face from temporary exile`
      : commander
        ? 'Easy Pickings: cast an Adventure commander from the command zone'
        : half
          ? `${pin.backFace!.name}: cast the selected spell face`
          : `${name}: play the ordinary front`,
  );
  if (impulse) {
    await handCard(page, 'Independent Impulse Permission').click();
    await confirm(page);
    await expect(page.locator('.stack')).toContainText('Independent Impulse Permission');
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
    const castFace = page
      .locator('.playable-now')
      .getByRole('button', { name: `Cast ${pin.name}`, exact: true });
    const reminder = page.getByRole('button', { name: 'Pass anyway', exact: true });
    await expect
      .poll(async () => (await castFace.isVisible()) || (await reminder.isVisible()))
      .toBe(true);
    if (await reminder.isVisible()) await reminder.click();
    await expect(castFace).toBeVisible();
    await castFace.click();
  } else if (commander) await page.locator('.command-zone .commander-card').click();
  else await handCard(page, name).click();
  if (half && expected.x !== undefined)
    await page.locator('.source-actions input[type="number"]').fill(String(expected.x));
  const buttons = page.locator('.source-actions .source-action-row button');
  if (half) await buttons.filter({ hasText: /\((adventure|omen)\)/i }).click();
  else
    await buttons.filter({ has: page.locator('span', { hasText: /^(Cast|Play land)$/ }) }).click();
  const targeted =
    half &&
    (expected.pt !== undefined ||
      expected.keyword !== undefined ||
      expected.counters !== undefined ||
      expected.bounce ||
      expected.destroyArtifact ||
      (expected.damage !== undefined && !expected.opponentsOnly));
  if (targeted) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(
      page,
      expected.bounce
        ? 'Own Face Bear'
        : expected.destroyArtifact
          ? 'Chosen Face Artifact'
          : 'Chosen Face Bear',
    ).click();
  }
  if (!half && pin.types.includes('Land'))
    await page.getByRole('button', { name: 'Play land', exact: true }).click();
  else await confirm(page);
  if (commander) await expect(page.locator('.stack')).toContainText('Easy Pickings');
  if (impulse) {
    await expect(page.locator('.stack')).toContainText(pin.backFace!.name);
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  }
  if (!half && name === 'An Unexpected Party')
    await page.getByRole('button', { name: 'Giant', exact: true }).click();
  if (half && expected.scry !== undefined) {
    for (let index = 0; index < expected.scry; index++) {
      const keep = page.getByRole('button', { name: /^Keep .+ on top$/ });
      await expect(keep).toBeVisible();
      const previousChoice = await keep.innerText();
      await keep.click();
      await expect(page.getByRole('button', { name: previousChoice, exact: true })).toBeHidden();
    }
    if (expected.scry > 1)
      await page.getByRole('button', { name: 'Keep current order', exact: true }).click();
  }
  if (half && expected.discard)
    await page.getByRole('button', { name: 'Discard', exact: true }).first().click();
  if (half && expected.search)
    await page.getByRole('button', { name: 'Put into your hand', exact: true }).first().click();
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const over = page.getByText(/game over/i).first();
  const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
  for (let count = 0; count < 12; count++) {
    await expect.poll(async () => (await over.isVisible()) || (await pass.isVisible())).toBe(true);
    if (await over.isVisible()) break;
    const before = boards.length;
    // The viewer passes on its own when passing is its only legal action, so the game can end
    // and the button vanish between the check and the click; never let that click block.
    await pass.click({ timeout: 1_000 }).catch(() => undefined);
    await expect
      .poll(
        async () =>
          boards.length > before || (await over.isVisible()) || (await passAnyway.isVisible()),
      )
      .toBe(true);
    if (await passAnyway.isVisible()) {
      await passAnyway.click();
      await expect.poll(async () => boards.length > before || (await over.isVisible())).toBe(true);
    }
  }
  await expect(over).toBeVisible({ timeout: 15_000 });
  const board = boards.at(-1)!;
  if (!half) {
    const front = board.find((card) => card.name === pin.name)!;
    expect(front).toBeDefined();
    expect(front.typeLine).toBe(pin.typeLine);
    if (pin.power !== null)
      expect(front.power).toBe(Number(pin.power) + (name === "Imodane's Recruiter" ? 1 : 0));
    if (pin.toughness !== null) expect(front.toughness).toBe(Number(pin.toughness));
    if (name === 'Lindblum, Industrial Regency') expect(front.tapped).toBe(true);
    if (name === 'Gingerbread Hunter')
      expect(board.some((card) => card.name === 'Food')).toBe(true);
    if (name === 'An Unexpected Party')
      expect(board.find((card) => card.name === 'Face Giant Witness')!.power).toBe(5);
    if (name === "Imodane's Recruiter") {
      const own = board.find((card) => card.name === 'Own Face Bear')!;
      expect([own.power, own.toughness]).toEqual([3, 2]);
      expect(own.keywords).toContain('haste');
    }
    return;
  }
  expect(board.some((card) => card.name === pin.name)).toBe(false);
  const chosen = board.find((card) => card.name === 'Chosen Face Bear');
  const own = board.find((card) => card.name === 'Own Face Bear');
  if (
    expected.destroyNonGiants ||
    name === 'Gingerbread Hunter' ||
    name === 'Smaug, the Great Calamity'
  )
    expect(chosen).toBeUndefined();
  else {
    expect(chosen).toBeDefined();
    if (expected.pt) expect([chosen!.power, chosen!.toughness]).toEqual(expected.pt);
    if (expected.keyword) expect(chosen!.keywords).toContain(expected.keyword);
    if (expected.counters !== undefined) expect(chosen!.counters['+1/+1']).toBe(expected.counters);
    if (expected.damage !== undefined) expect(chosen!.damageMarked).toBe(expected.damage);
    if (expected.untap) expect(chosen!.tapped).toBe(false);
  }
  if (expected.bounce || expected.destroyNonGiants) expect(own).toBeUndefined();
  else expect([own!.power, own!.toughness]).toEqual([2, 2]);
  expect(board.some((card) => card.name === 'Face Giant Witness')).toBe(true);
  if (expected.ownKeyword) expect(own!.keywords).toContain(expected.ownKeyword);
  if (expected.destroyArtifact)
    expect(board.some((card) => card.name === 'Chosen Face Artifact')).toBe(false);
  if (expected.tokens !== undefined) {
    const tokens = board.filter((card) => card.name === expected.tokenName);
    expect(tokens).toHaveLength(expected.tokens);
    for (const token of tokens) {
      if (expected.tokenPt) expect([token.power, token.toughness]).toEqual(expected.tokenPt);
      if (expected.tokenKeyword) expect(token.keywords).toContain(expected.tokenKeyword);
    }
  }
  if (expected.opponentsOnly) expect(own!.damageMarked).toBe(0);
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(
    (commander || impulse ? 1 : 0) +
      (expected.draw ?? 0) -
      (expected.discard ?? 0) +
      (expected.search || expected.bounce ? 1 : 0),
  );
}

test('Faerie Guidemother: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Faerie Guidemother', false);
});

test('Gift of the Fae: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Faerie Guidemother', true);
});

test('Tuinvale Treefolk: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Tuinvale Treefolk', false);
});

test('Oaken Boon: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Tuinvale Treefolk', true);
});

test('Two-Headed Hunter: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Two-Headed Hunter', false);
});

test('Twice the Rage: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Two-Headed Hunter', true);
});

test('Foulmire Knight: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Foulmire Knight', false);
});

test('Profane Insight: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Foulmire Knight', true);
});

test('An Unexpected Party: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'An Unexpected Party', false);
});

test('At the Door: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'An Unexpected Party', true);
});

test("Obyra's Attendants: play the ordinary front", async ({ page }) => {
  await runSelectedFaceViewer(page, "Obyra's Attendants", false);
});

test('Desperate Parry: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, "Obyra's Attendants", true);
});

test('Garenbrig Carver: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Garenbrig Carver', false);
});

test("Shield's Might: cast the selected spell face", async ({ page }) => {
  await runSelectedFaceViewer(page, 'Garenbrig Carver', true);
});

test('Lindblum, Industrial Regency: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Lindblum, Industrial Regency', false);
});

test('Mage Siege: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Lindblum, Industrial Regency', true);
});

test('Tempest Hart: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Tempest Hart', false);
});

test('Scan the Clouds: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Tempest Hart', true);
});

test("Imodane's Recruiter: play the ordinary front", async ({ page }) => {
  await runSelectedFaceViewer(page, "Imodane's Recruiter", false);
});

test('Train Troops: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, "Imodane's Recruiter", true);
});

test('Embereth Shieldbreaker: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Embereth Shieldbreaker', false);
});

test('Battle Display: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Embereth Shieldbreaker', true);
});

test('Gl\u00f3in the Mighty: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Gl\u00f3in the Mighty', false);
});

test('Easy Pickings: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Gl\u00f3in the Mighty', true);
});

test('Shepherd of the Flock: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Shepherd of the Flock', false);
});

test('Usher to Safety: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Shepherd of the Flock', true);
});

test('Sagu Wildling: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Sagu Wildling', false);
});

test('Roost Seek: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Sagu Wildling', true);
});

test('Silverflame Squire: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Silverflame Squire', false);
});

test('On Alert: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Silverflame Squire', true);
});

test('Oakhame Ranger: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Oakhame Ranger', false);
});

test('Bring Back: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Oakhame Ranger', true);
});

test('Realm-Cloaked Giant: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Realm-Cloaked Giant', false);
});

test('Cast Off: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Realm-Cloaked Giant', true);
});

test('Frolicking Familiar: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Frolicking Familiar', false);
});

test('Blow Off Steam: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Frolicking Familiar', true);
});

test('Lonesome Unicorn: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Lonesome Unicorn', false);
});

test('Rider in Need: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Lonesome Unicorn', true);
});

test('Topaz Dragon: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Topaz Dragon', false);
});

test('Entropic Cloud: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Topaz Dragon', true);
});

test('Horn of Valhalla: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Horn of Valhalla', false);
});

test("Ysgard's Call: cast the selected spell face", async ({ page }) => {
  await runSelectedFaceViewer(page, 'Horn of Valhalla', true);
});

test('Minecart Daredevil: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Minecart Daredevil', false);
});

test('Ride the Rails: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Minecart Daredevil', true);
});

test('Curious Pair: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Curious Pair', false);
});

test('Treats to Share: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Curious Pair', true);
});

test('Gingerbread Hunter: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Gingerbread Hunter', false);
});

test('Puny Snack: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Gingerbread Hunter', true);
});

test('Bilbo Baggins, Burglar: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Bilbo Baggins, Burglar', false);
});

test('Take a Glance: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Bilbo Baggins, Burglar', true);
});

test('Smaug, the Great Calamity: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Smaug, the Great Calamity', false);
});

test('Spew Flame: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Smaug, the Great Calamity', true);
});

test('Young Blue Dragon: play the ordinary front', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Young Blue Dragon', false);
});

test('Sand Augury: cast the selected spell face', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Young Blue Dragon', true);
});

async function runCounterController(page: Page, name: string, own: boolean): Promise<void> {
  await runScenario(page, `${name}: counter ${own ? 'your own' : "an opponent's"} spell`);
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const pending = page.locator('.stack li').filter({ hasText: 'Independent Pending Spell' });
  await expect(pending).toHaveClass(/targetable/);
  await pending.click();
  await confirm(page);
  if (own && (name === 'Mana Leak' || name === 'Stubborn Denial')) {
    await page
      .getByRole('button', { name: /Let .*Independent Pending Spell.* be countered/ })
      .click();
  }
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(new RegExp(`Independent Pending Spell is countered by ${name}`, 'i')),
  ).toBeVisible();
  await expect(page.getByText(/gains 3 life/i)).toHaveCount(0);
}

async function runOverloadViewer(page: Page, name: string, overload: boolean): Promise<void> {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    `${name}: ${overload ? 'overload without targets' : 'one normal target'}`,
  );
  const card = handCard(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  const actions = page.locator('.source-actions .source-action-row button');
  await expect(actions).toHaveCount(2);
  const overloaded = actions.filter({ hasText: /overload/i });
  if (overload) await overloaded.click();
  else await actions.filter({ hasNotText: /overload/i }).click();
  if (overload) {
    await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
  } else {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await expect(permanent(page, 'Chosen Overload Witness')).toHaveClass(/targetable/);
    await permanent(page, 'Chosen Overload Witness').click();
  }
  await confirm(page);
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Chosen Overload Witness')).toHaveCount(0);
  if (name === 'Damn') {
    await expect(permanent(page, 'Granted Indestructible Knight')).toHaveCount(1);
    await expect(permanent(page, 'Knight Exemplar')).toHaveCount(overload ? 0 : 1);
  }
  expect(boards.at(-1)!.filter((card) => card.name === 'Forest')).toHaveLength(3);
  for (const witness of ['Other Overload Witness', 'Protected Overload Witness']) {
    await expect(permanent(page, witness)).toHaveCount(overload ? 0 : 1);
  }
  await expect(permanent(page, 'Own Overload Witness')).toHaveCount(
    overload && name === 'Damn' ? 0 : 1,
  );
  await expect(permanent(page, 'Indestructible Overload Witness')).toHaveCount(
    overload && name === 'Cyclonic Rift' ? 0 : 1,
  );
}

test('Counterspell: counter your own spell', async ({ page }) => {
  await runCounterController(page, 'Counterspell', true);
});
test("Counterspell: counter an opponent's spell", async ({ page }) => {
  await runCounterController(page, 'Counterspell', false);
});
test('Negate: counter your own spell', async ({ page }) => {
  await runCounterController(page, 'Negate', true);
});
test("Negate: counter an opponent's spell", async ({ page }) => {
  await runCounterController(page, 'Negate', false);
});
test('Mana Leak: counter your own spell', async ({ page }) => {
  await runCounterController(page, 'Mana Leak', true);
});
test("Mana Leak: counter an opponent's spell", async ({ page }) => {
  await runCounterController(page, 'Mana Leak', false);
});
test('Stubborn Denial: counter your own spell', async ({ page }) => {
  await runCounterController(page, 'Stubborn Denial', true);
});
test("Stubborn Denial: counter an opponent's spell", async ({ page }) => {
  await runCounterController(page, 'Stubborn Denial', false);
});
test('Cyclonic Rift: one normal target', async ({ page }) => {
  await runOverloadViewer(page, 'Cyclonic Rift', false);
});
test('Cyclonic Rift: overload without targets', async ({ page }) => {
  await runOverloadViewer(page, 'Cyclonic Rift', true);
});
test('Vandalblast: one normal target', async ({ page }) => {
  await runOverloadViewer(page, 'Vandalblast', false);
});
test('Vandalblast: overload without targets', async ({ page }) => {
  await runOverloadViewer(page, 'Vandalblast', true);
});
test('Damn: one normal target', async ({ page }) => {
  await runOverloadViewer(page, 'Damn', false);
});
test('Damn: overload without targets', async ({ page }) => {
  await runOverloadViewer(page, 'Damn', true);
});

test('Force of Negation: counter your own spell', async ({ page }) => {
  await runCounterController(page, 'Force of Negation', true);
});
test("Force of Negation: counter an opponent's spell", async ({ page }) => {
  await runCounterController(page, 'Force of Negation', false);
});

test('Easy Pickings: cast an Adventure commander from the command zone', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Glóin the Mighty', true, true);
  await expect(
    page.locator('.log .line', {
      hasText: 'Cast Easy Pickings ({2}{R}) via Adventure from the command zone',
    }),
  ).toHaveCount(1);
});
test('Mosswort Bridge: cast a hidden Adventure spell face', async ({ page }) => {
  await runScenario(page, 'Mosswort Bridge: cast a hidden Adventure spell face');
  await handCard(page, 'Mosswort Bridge').click();
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await page.getByRole('button', { name: 'Exile face down', exact: true }).first().click();
  await handCard(page, 'Lab Wake').click();
  await permanent(page, 'Mosswort Bridge').click();
  await confirm(page);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await page
    .locator('.playable-now')
    .getByRole('button', { name: 'Activate Mosswort Bridge', exact: true })
    .click();
  await confirm(page);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await page
    .getByRole('button', { name: 'Play Foulmire Knight // Profane Insight', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cast Profane Insight', exact: true }).click();
  await expect(page.locator('.stack')).toContainText('Profane Insight');
  await expect(permanent(page, 'Foulmire Knight // Profane Insight')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible();
  await expect(page.locator('.log .line', { hasText: 'casts Profane Insight' })).toHaveCount(1);
});

test('Profane Insight: cast the spell face from temporary exile', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Foulmire Knight', true, false, true);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
});
test('Roost Seek: cast the spell face from temporary exile', async ({ page }) => {
  await runSelectedFaceViewer(page, 'Sagu Wildling', true, false, true);
});
test('Marchesa: return creatures after simultaneous deaths', async ({ page }) => {
  await verifyFirstZoneReturn(
    page,
    'Marchesa: return creatures after simultaneous deaths',
    'P2',
    true,
    false,
    true,
  );
});

test('Triarch Praetorian: unearth it to draw two cards', async ({ page }) => {
  await runScenario(page, 'Triarch Praetorian: unearth it to draw two cards');
  const praetorian = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Triarch Praetorian', exact: true }) });
  await expect(praetorian).toHaveClass(/actionable/, { timeout: 15_000 });
  await praetorian.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(handCard(page, 'Lab Ox')).toBeVisible();
  await expect(handCard(page, 'Lab Zombie')).toBeVisible();
  await expect(page.locator('.log .line', { hasText: /loses 2 life/ }).first()).toBeVisible();
  // Unearth's delayed trigger exiled it at the beginning of the end step.
  await expect(permanent(page, 'Triarch Praetorian')).toHaveCount(0);
  await expect(
    page
      .locator('.zones-strip .zone', { hasText: 'Exile' })
      .getByRole('img', { name: 'Triarch Praetorian', exact: true }),
  ).toBeVisible();
});

test("Canoptek Tomb Sentinel: unearth it to exile P2's Lab Ox", async ({ page }) => {
  await runScenario(page, "Canoptek Tomb Sentinel: unearth it to exile P2's Lab Ox");
  const sentinel = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Canoptek Tomb Sentinel', exact: true }) });
  await expect(sentinel).toHaveClass(/actionable/, { timeout: 15_000 });
  await sentinel.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // The enters-from-a-graveyard trigger asks for up to one nonland permanent.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  // Unearth's delayed trigger exiled the Sentinel at the beginning of the end step.
  await expect(permanent(page, 'Canoptek Tomb Sentinel')).toHaveCount(0);
  await expect(
    page
      .locator('.zones-strip .zone', { hasText: 'Exile' })
      .getByRole('img', { name: 'Canoptek Tomb Sentinel', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .zone', { hasText: 'Exile' })
      .getByRole('img', { name: 'Lab Ox', exact: true }),
  ).toBeVisible();
});

test("Glen Elendra Archmage: counter P3's spell, then persist", async ({ page }) => {
  await runScenario(page, "Glen Elendra Archmage: counter P3's spell, then persist");
  const archmage = permanent(page, 'Glen Elendra Archmage');
  await expect(archmage).toHaveClass(/actionable/, { timeout: 15_000 });
  await archmage.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const pending = page.locator('.stack li').filter({ hasText: 'Lab Pending Spell' });
  await expect(pending).toHaveClass(/targetable/);
  await pending.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/Lab Pending Spell is countered/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Glen Elendra Archmage')).toBeVisible();
  await expect(page.getByText('-1/-1×1')).toBeVisible();
});

test('Flayer of the Hatebound: destroy it, undying, deal 5 to P2', async ({ page }) => {
  await runScenario(page, 'Flayer of the Hatebound: destroy it, undying, deal 5 to P2');
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Flayer of the Hatebound').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Undying returns it; its enters-from-your-graveyard trigger asks for any target.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Flayer of the Hatebound')).toBeVisible();
  await expect(page.getByText('+1/+1×1')).toBeVisible();
  await expect(page.getByText(/Flayer of the Hatebound deals 5 to P2/).first()).toBeVisible();
});

test("Kambal, Consul of Allocation: tax P2's noncreature spell", async ({ page }) => {
  await runScenario(page, "Kambal, Consul of Allocation: tax P2's noncreature spell");
  const spell = handCard(page, 'Lab Pending Spell');
  await expect(spell).toHaveClass(/actionable/);
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // P2's scripted seat casts Lab Shock at you; only that cast triggers Kambal.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.log .line', { hasText: /loses 2 life$/ })).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /gains 2 life$/ })).toHaveCount(1);
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('38');
});

test('Gleeful Arsonist: burn P2 for casting, then undying', async ({ page }) => {
  await runScenario(page, 'Gleeful Arsonist: burn P2 for casting, then undying');
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Gleeful Arsonist').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // P2's scripted seat responds with Lab Shock, which triggers the Arsonist.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Gleeful Arsonist.* deals 1 to P2/).first()).toBeVisible();
  await expect(permanent(page, 'Gleeful Arsonist')).toBeVisible();
  await expect(page.getByText('+1/+1×1')).toBeVisible();
});

test("Shard of the Nightbringer: cast it to drain half of P2's life", async ({ page }) => {
  await runScenario(page, "Shard of the Nightbringer: cast it to drain half of P2's life");
  const shard = handCard(page, 'Shard of the Nightbringer');
  await expect(shard).toHaveClass(/actionable/);
  await shard.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Cast, so its enters trigger asks for target opponent.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Shard of the Nightbringer')).toBeVisible();
  await expect(page.locator('.log .line', { hasText: /loses 20 life$/ })).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /gains 20 life$/ })).toHaveCount(1);
});

test('Satoru, the Infiltrator: a free creature draws, a paid one does not', async ({ page }) => {
  await runScenario(page, 'Satoru, the Infiltrator: a free creature draws, a paid one does not');
  const ornithopter = handCard(page, 'Lab Ornithopter');
  await expect(ornithopter).toHaveClass(/actionable/);
  await ornithopter.click();
  // A {0} spell may still ask to confirm its (empty) payment.
  const confirmButton = page.getByRole('button', { name: 'Confirm' });
  await expect(permanent(page, 'Lab Ornithopter').or(confirmButton).first()).toBeVisible({
    timeout: 15_000,
  });
  if (await confirmButton.isVisible()) await confirm(page);
  await expect(handCard(page, 'Lab Ox')).toBeVisible({ timeout: 15_000 });
  await castAndResolve(page, 'Lab Zombie');
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Zombie')).toBeVisible();
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
});

test('Keeper of Secrets: flash back a spell to ping P2', async ({ page }) => {
  await runScenario(page, 'Keeper of Secrets: flash back a spell to ping P2');
  const bolt = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Lab Flash Bolt', exact: true }) });
  await expect(bolt).toHaveClass(/actionable/, { timeout: 15_000 });
  await bolt.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent').filter({ hasText: 'P3' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Cast from the graveyard, so Keeper of Secrets triggers and asks for target opponent.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Keeper of Secrets.* deals 1 to P2/).first()).toBeVisible();
  await expect(page.getByText(/Lab Flash Bolt deals 1 to P3/).first()).toBeVisible();
});

test('River Kelpie: draw from a flashback and from persist', async ({ page }) => {
  await runScenario(page, 'River Kelpie: draw from a flashback and from persist');
  const bolt = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Lab Flash Bolt', exact: true }) });
  await expect(bolt).toHaveClass(/actionable/, { timeout: 15_000 });
  await bolt.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // The Kelpie's cast trigger sits above the bolt; pass until both have resolved.
  await passUntil(page, page.getByText(/Lab Flash Bolt resolves/).first());
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'River Kelpie').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'River Kelpie')).toBeVisible();
  await expect(page.getByText('-1/-1×1')).toBeVisible();
  await expect(handCard(page, 'Lab Ox')).toBeVisible();
  await expect(handCard(page, 'Lab Zombie')).toBeVisible();
});

test('Aurora Phoenix: cast a cascade spell to return it', async ({ page }) => {
  await runScenario(page, 'Aurora Phoenix: cast a cascade spell to return it');
  const cascader = handCard(page, 'Lab Cascader');
  await expect(cascader).toHaveClass(/actionable/);
  await cascader.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // The Phoenix's graveyard trigger and the cascade trigger fire together: order them.
  await page
    .getByRole('button', { name: /Aurora Phoenix: Whenever you cast a spell with cascade/ })
    .click({ timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Cascader')).toBeVisible();
  await expect(handCard(page, 'Aurora Phoenix')).toBeVisible();
});

test('Aurora Phoenix: cast it, cascade into a cheaper spell, and see it fly', async ({ page }) => {
  await runScenario(page, 'Aurora Phoenix: cast it, cascade into a cheaper spell, and see it fly');
  const phoenix = handCard(page, 'Aurora Phoenix');
  await expect(phoenix).toHaveClass(/actionable/);
  await phoenix.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Its own cascade exiles the Forest, then stops at Lab Cascade Hit, the first cheaper nonland card.
  await page
    .getByRole('button', { name: 'Cast Lab Cascade Hit without paying its mana cost' })
    .click({ timeout: 15_000 });
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Cascade Hit')).toHaveCount(1);
  await expect(permanent(page, 'Aurora Phoenix')).toHaveCount(1);
  await expect(permanent(page, 'Aurora Phoenix')).toContainText('5/3');
  await expect(permanent(page, 'Aurora Phoenix')).toContainText(/flying/i);
  await expect(handCard(page, 'Aurora Phoenix')).toHaveCount(0);
});

test('Watcher for Tomorrow: hide a card, then get it back as it leaves', async ({ page }) => {
  await runScenario(page, 'Watcher for Tomorrow: hide a card, then get it back as it leaves');
  await castAndResolve(page, 'Watcher for Tomorrow');
  await expect(permanent(page, 'Watcher for Tomorrow').locator('.tap-badge')).toHaveText('TAP');
  // Let Hideaway resolve: pick a card from the top four to exile face down.
  const hide = page.getByRole('button', { name: /Exile face down/ }).first();
  await passUntil(page, hide);
  await hide.click();
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Watcher for Tomorrow').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Watcher for Tomorrow')).toHaveCount(0);
  // Whichever card was hidden is now the only card in hand.
  await expect(
    page.locator('.hand-card:not(.hand-card-leave-active)', {
      hasText: /Lab (Ox|Zombie|Servo|Bird)/,
    }),
  ).toHaveCount(1);
});

test('Psychomancer: drain P2 when your artifact is destroyed', async ({ page }) => {
  await runScenario(page, 'Psychomancer: drain P2 when your artifact is destroyed');
  const shatter = handCard(page, 'Lab Shatter');
  await expect(shatter).toHaveClass(/actionable/);
  await shatter.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Anrakyr Relic').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // The Relic is destroyed: Psychomancer's trigger asks for target opponent.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P2' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Anrakyr Relic')).toHaveCount(0);
  await expect(page.locator('.log .line', { hasText: /loses 1 life$/ })).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /gains 1 life$/ })).toHaveCount(1);
});

test('Shard of the Void Dragon: attack, and grow from the sacrificed artifact', async ({
  page,
}) => {
  await runScenario(
    page,
    'Shard of the Void Dragon: attack, and grow from the sacrificed artifact',
  );
  // Nothing is castable, so precombat priority passes itself and combat begins.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Shard of the Void Dragon' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Anrakyr Relic')).toHaveCount(0);
  await expect(page.getByText('+1/+1×2')).toBeVisible();
  await expect(page.getByText(/Shard of the Void Dragon deals 9 to P2/).first()).toBeVisible();
});

test('Scavenging Ooze: exile a creature card to grow and gain life', async ({ page }) => {
  await runScenario(page, 'Scavenging Ooze: exile a creature card to grow and gain life');
  const ooze = permanent(page, 'Scavenging Ooze');
  await expect(ooze).toHaveClass(/actionable/, { timeout: 15_000 });
  await ooze.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const ox = page.locator('.zone-card-thumb.targetable').filter({
    has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
  });
  await expect(ox).toBeVisible();
  await ox.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText('+1/+1×1')).toBeVisible();
  await expect(page.locator('.log .line', { hasText: /gains 1 life$/ })).toHaveCount(1);
});

test('Imotekh the Stormlord: reanimate an artifact, then buff it at combat', async ({ page }) => {
  await runScenario(page, 'Imotekh the Stormlord: reanimate an artifact, then buff it at combat');
  const reanimate = handCard(page, 'Lab Reanimate');
  await expect(reanimate).toHaveClass(/actionable/, { timeout: 15_000 });
  await reanimate.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const construct = page.locator('.zone-card-thumb.targetable').filter({
    has: page.getByRole('img', { name: 'Lab Construct', exact: true }),
  });
  await expect(construct).toBeVisible();
  await construct.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // An artifact card left the graveyard: two Necron Warriors, then the combat trigger targets.
  const target = page.getByText(/Target 1 of 1/);
  await passUntil(page, target);
  await expect(permanent(page, 'Necron Warrior')).toContainText('×2');
  await permanent(page, 'Lab Construct').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Reset declaration' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Construct')).toContainText('3/3');
});

test('The Ooze: Mutagens from a leaving creature and a graveyard exile', async ({ page }) => {
  await runScenario(page, 'The Ooze: Mutagens from a leaving creature and a graveyard exile');
  const banish = handCard(page, 'Lab Banish');
  await expect(banish).toHaveClass(/actionable/, { timeout: 15_000 });
  await banish.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Mutant').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Lab Mutant left with two +1/+1 counters: two Mutagens.
  const mutagen = permanent(page, 'Mutagen');
  await passUntil(page, mutagen);
  await expect(mutagen).toContainText('×2');
  const ooze = permanent(page, 'The Ooze');
  await expect(ooze).toHaveClass(/actionable/, { timeout: 15_000 });
  await ooze.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const ox = page.locator('.zone-card-thumb.targetable').filter({
    has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
  });
  await expect(ox).toBeVisible();
  await ox.click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Mutagen')).toContainText('×3');
  await expect(ooze.locator('.tap-badge')).toHaveText('TAP');
});

test('God-Eternal Rhonas: double your creatures, then go third from the top', async ({ page }) => {
  await runScenario(page, 'God-Eternal Rhonas: double your creatures, then go third from the top');
  await castAndResolve(page, 'God-Eternal Rhonas');
  await expect(permanent(page, 'Lab Ox')).toContainText('8/4', { timeout: 15_000 });
  const banish = handCard(page, 'Lab Banish');
  await expect(banish).toHaveClass(/actionable/, { timeout: 15_000 });
  await banish.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'God-Eternal Rhonas').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Exiled from the battlefield: choose to put it into the library third from the top.
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  await passUntil(page, yes);
  await yes.click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'God-Eternal Rhonas')).toHaveCount(0);
  await expect(
    page.locator('.zone-card-thumb').filter({
      has: page.getByRole('img', { name: 'God-Eternal Rhonas', exact: true }),
    }),
  ).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toContainText('8/4');
});

test('Candlekeep Sage: your commander draws as it enters and leaves', async ({ page }) => {
  await runScenario(page, 'Candlekeep Sage: your commander draws as it enters and leaves');
  await page.locator('.command-zone .commander-card').click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Lab General enters: the granted trigger draws Lab Ox. Waiting on the trigger's resolution
  // (passing only while the stack is non-empty) never passes the empty-stack priority that
  // would end the scenario.
  const granted = 'Lab General — When this creature enters or leaves the battlefield, draw a card';
  await awaitResolution(page, granted, 0);
  const ox = handCard(page, 'Lab Ox');
  await expect(ox).toBeVisible();
  await expect(permanent(page, 'Lab General')).toHaveCount(1);
  const banish = handCard(page, 'Lab Banish');
  await expect(banish).toHaveClass(/actionable/, { timeout: 15_000 });
  await banish.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab General').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Exiled: the leave trigger draws Lab Servo.
  await awaitResolution(page, granted, 1);
  await expect(handCard(page, 'Lab Servo')).toBeVisible();
  await expect(permanent(page, 'Lab General')).toHaveCount(0);
  await expect(handCard(page, 'Lab Ox')).toHaveCount(1);
});

test("Flickerwisp: exile P2's creature until the next end step", async ({ page }) => {
  await runScenario(page, "Flickerwisp: exile P2's creature until the next end step");
  await castAndResolve(page, 'Flickerwisp');
  // The enters trigger targets another permanent: Lab Ox.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/Lab Ox is exiled by Flickerwisp/).first());
  await passUntil(page, page.getByText(/game over/i).first());
  // Returned at the beginning of the end step, under P2's control: on P2's board, not in exile.
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(
    page.locator('.zone-card-thumb').filter({
      has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
    }),
  ).toHaveCount(0);
});

test('Venser, the Sojourner: +2 blinks your Lab Ox at the end step', async ({ page }) => {
  await runScenario(page, 'Venser, the Sojourner: +2 blinks your Lab Ox at the end step');
  const venser = permanent(page, 'Venser, the Sojourner');
  await expect(venser).toHaveClass(/actionable/, { timeout: 15_000 });
  await venser.click();
  await page.getByRole('button', { name: /\+2: Exile target permanent you own/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/Lab Ox is exiled by Venser/).first());
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(
    page.locator('.zone-card-thumb').filter({
      has: page.getByRole('img', { name: 'Lab Ox', exact: true }),
    }),
  ).toHaveCount(0);
});

test('Venser, the Sojourner: −1 makes creatures unblockable', async ({ page }) => {
  await runScenario(page, 'Venser, the Sojourner: −1 makes creatures unblockable');
  await activate(page, 'Venser, the Sojourner', /−1: Creatures can't be blocked/);
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('36');
});

test("Venser, the Sojourner: −8 emblem exiles P2's Lab Ox", async ({ page }) => {
  await runScenario(page, "Venser, the Sojourner: −8 emblem exiles P2's Lab Ox");
  await activate(page, 'Venser, the Sojourner', /−8: You get an emblem/);
  const divination = handCard(page, 'Lab Divination');
  await expect(divination).toHaveClass(/actionable/, { timeout: 15_000 });
  await divination.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // The emblem triggers on the cast: choose its target, P2's Lab Ox.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/Lab Ox is exiled by/).first());
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
});

test("Puppeteer Clique: steal P2's Lab Ox, attack, then exile it", async ({ page }) => {
  await runScenario(page, "Puppeteer Clique: steal P2's Lab Ox, attack, then exile it");
  await castAndResolve(page, 'Puppeteer Clique');
  // Lab Ox is the only legal target: it enters under your control with haste.
  const ox = permanent(page, 'Lab Ox');
  await passUntil(page, ox);
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('36');
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
});

test('Puppeteer Clique: destroy it and persist returns it', async ({ page }) => {
  await runScenario(page, 'Puppeteer Clique: destroy it and persist returns it');
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Puppeteer Clique').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  // Persist returned it as a new object with a -1/-1 counter: a 2/1 flier.
  await expect(permanent(page, 'Puppeteer Clique')).toHaveCount(1);
  await expect(page.getByText('-1/-1×1')).toBeVisible();
  await expect(permanent(page, 'Puppeteer Clique')).toContainText('2/1');
  await expect(handCard(page, 'Lab Doom')).toHaveCount(0);
});

test('Cryptek: your Lab Construct dies and returns tapped', async ({ page }) => {
  await runScenario(page, 'Cryptek: your Lab Construct dies and returns tapped');
  const cryptek = permanent(page, 'Cryptek');
  await expect(cryptek).toHaveClass(/actionable/, { timeout: 15_000 });
  await cryptek.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Construct').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  const doom = handCard(page, 'Lab Doom');
  await passUntil(page, doom.and(page.locator('.actionable')));
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Construct').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Construct')).toHaveCount(1);
  await expect(permanent(page, 'Lab Construct').locator('.tap-badge')).toHaveText('TAP');
});

test('Living Death: swap the battlefield and graveyard creatures', async ({ page }) => {
  await runScenario(page, 'Living Death: swap the battlefield and graveyard creatures');
  await castAndResolve(page, 'Living Death');
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Risen Zombie')).toHaveCount(1);
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  // P2's graveyard creature returns too, on P2's board, and its Lab Ox went to the graveyard.
  const p2 = page.locator('.opponent[data-seat="P2"]');
  await expect(permanent(page, 'Lab Risen Bear')).toHaveCount(1);
  await expect(
    p2
      .locator('.tile')
      .filter({ has: page.getByRole('img', { name: 'Lab Risen Bear', exact: true }) }),
  ).toHaveCount(1);
});

test('Technomancer: mill three, then return artifact creatures worth 6', async ({ page }) => {
  await runScenario(page, 'Technomancer: mill three, then return artifact creatures worth 6');
  await castAndResolve(page, 'Technomancer');
  for (const name of ['Lab Three Construct', 'Lab Three Construct', 'Lab Zero Construct']) {
    const choice = page
      .locator('.panel-group')
      .filter({ hasText: name })
      .first()
      .getByRole('button', { name: 'Return', exact: true });
    await passUntil(page, choice);
    await choice.click();
  }
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Three Construct')).toContainText('×2');
  await expect(permanent(page, 'Lab Zero Construct')).toHaveCount(1);
});

test('Victimize: sacrifice Lab Servo, return two creatures tapped', async ({ page }) => {
  await runScenario(page, 'Victimize: sacrifice Lab Servo, return two creatures tapped');
  const victimize = handCard(page, 'Victimize');
  await expect(victimize).toHaveClass(/actionable/, { timeout: 15_000 });
  await victimize.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Exactly two: the graveyard cards are named, and stopping early is never offered.
  await page
    .getByRole('button', { name: "Target Lab Ox (P1's graveyard)" })
    .click({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toHaveCount(0);
  // The second target is then forced (one candidate, no stopping), so the viewer may submit it
  // on its own; the outcome below shows both were chosen.

  // Lab Servo is the only creature to sacrifice.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  for (const name of ['Lab Ox', 'Lab Fallen Bear']) {
    await expect(permanent(page, name).locator('.tap-badge')).toHaveText('TAP');
  }
});

test('Body Launderer: Lab Ox dies and it connives', async ({ page }) => {
  await runScenario(page, 'Body Launderer: Lab Ox dies and it connives');
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Connive: Lab Hex is drawn, then the nonland Lab Servo is discarded.
  const discard = page
    .locator('.panel-group')
    .filter({ hasText: 'Lab Servo' })
    .first()
    .getByRole('button', { name: 'Discard', exact: true });
  await passUntil(page, discard);
  await discard.click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Body Launderer')).toContainText('4/4');
  await expect(handCard(page, 'Lab Hex')).toBeVisible();
});

test('Body Launderer: it dies and returns Lab Servo, not Lab Ox', async ({ page }) => {
  await runScenario(page, 'Body Launderer: it dies and returns Lab Servo, not Lab Ox');
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Body Launderer').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Lab Servo is the only legal target, so the return needs no choice.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Body Launderer')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
});

test('Sautekh Immortal: two creatures died this turn, so it enters as a 4/4', async ({ page }) => {
  await runScenario(page, 'Sautekh Immortal: two creatures died this turn, so it enters as a 4/4');
  // Kill both of P2's creatures with real spells, letting each resolve before the next.
  let doomResolutions = 0;
  for (const victim of ['Lab Ox', 'Lab Servo']) {
    const doom = handCard(page, 'Lab Doom').first();
    await expect(doom).toHaveClass(/actionable/);
    await doom.click();
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, victim).click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await confirm(page);
    await awaitResolution(page, 'Lab Doom', doomResolutions);
    doomResolutions++;
    await expect(permanent(page, victim)).toHaveCount(0);
  }
  const sautekh = handCard(page, 'Sautekh Immortal');
  await expect(sautekh).toHaveClass(/actionable/);
  await sautekh.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, permanent(page, 'Sautekh Immortal'));
  await expect(permanent(page, 'Sautekh Immortal')).toBeVisible();
  await expect(permanent(page, 'Sautekh Immortal').getByText('+1/+1×2')).toBeVisible();
  await expect(permanent(page, 'Sautekh Immortal').getByText('4/4')).toBeVisible();
});

test('Iron Apprentice: it dies and its +1/+1 counter moves to Lab Bird', async ({ page }) => {
  await runScenario(page, 'Iron Apprentice: it dies and its +1/+1 counter moves to Lab Bird');
  const apprentice = handCard(page, 'Iron Apprentice');
  await expect(apprentice).toHaveClass(/actionable/, { timeout: 15_000 });
  await apprentice.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, permanent(page, 'Iron Apprentice'));
  // It enters with its counter already on it: a 1/1, not an enters trigger.
  await expect(permanent(page, 'Iron Apprentice').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Iron Apprentice').getByText('1/1')).toBeVisible();
  await expect(permanent(page, 'Lab Bird').getByText('+1/+1×1')).toHaveCount(0);

  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/);
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Iron Apprentice').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Lab Bird is the only creature P1 controls, so the dies trigger needs no choice.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Iron Apprentice')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Lab Ox').getByText('+1/+1×1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Lab Bird').getByText('2/2')).toBeVisible();
});

test('Vigean Graftmage: graft a counter, then untap a creature that has one', async ({ page }) => {
  await runScenario(page, 'Vigean Graftmage: graft a counter, then untap a creature that has one');
  // Pass only while something is on the stack: a pass with an empty stack would leave the main
  // phase before Lab Servo is cast.
  await castAndResolve(page, 'Vigean Graftmage');
  // It enters with both counters already on it: a 2/2, and its own entry grafts nothing.
  await expect(permanent(page, 'Vigean Graftmage').getByText('+1/+1×2')).toBeVisible();
  await expect(permanent(page, 'Vigean Graftmage').getByText('2/2')).toBeVisible();
  // The prepared Lab Ox starts tapped with one counter.
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Ox').getByText('+1/+1×1')).toBeVisible();

  const servo = handCard(page, 'Lab Servo');
  await expect(servo).toHaveClass(/actionable/);
  await servo.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Another creature entered, so Graft asks whether to move a counter onto it.
  const use = page.getByText(/use this ability/i).first();
  await passUntil(page, use);
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  // Answering finishes the trigger's resolution; passing again here would leave the main phase.
  await expect(permanent(page, 'Lab Servo').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Vigean Graftmage').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Vigean Graftmage').getByText('1/1')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('2/2')).toBeVisible();

  // Untap Lab Ox, which has a +1/+1 counter on it.
  const untapped = page.getByText(/Untap target creature with a \+1\/\+1 counter on it\. resolves/);
  await expect(permanent(page, 'Vigean Graftmage')).toHaveClass(/actionable/);
  await permanent(page, 'Vigean Graftmage').click();
  const ability = page.getByRole('button', { name: /Untap target creature/ });
  if (await ability.isVisible()) await ability.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, untapped.first());
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);
});

test('Elite Scaleguard: bolster the smallest creature, then tap a blocker as it attacks', async ({
  page,
}) => {
  await runScenario(
    page,
    'Elite Scaleguard: bolster the smallest creature, then tap a blocker as it attacks',
  );
  const scaleguard = handCard(page, 'Elite Scaleguard');
  await expect(scaleguard).toHaveClass(/actionable/, { timeout: 15_000 });
  await scaleguard.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, permanent(page, 'Elite Scaleguard'));
  // Bolster 2 is not targeted: Lab Servo (toughness 1) is the only least-toughness creature.
  await passUntil(page, permanent(page, 'Lab Servo').getByText('+1/+1×2'));
  await expect(permanent(page, 'Lab Servo').getByText('3/3')).toBeVisible();
  await expect(permanent(page, 'Elite Scaleguard').getByText('+1/+1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);

  // Nothing is castable now, so priority passes and combat begins. Only Lab Servo can attack.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Servo' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  // The countered attacker's trigger taps Lab Ox (P2's only creature), so nothing blocks.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Lab Servo deals 3 to P2/).first()).toBeVisible();
});

test('Forgotten Ancient: grow when a spell is cast, then move counters at your upkeep', async ({
  page,
}) => {
  await runScenario(
    page,
    'Forgotten Ancient: grow when a spell is cast, then move counters at your upkeep',
  );
  // Forgotten Ancient starts with two +1/+1 counters; it is a 2/5 with them.
  await expect(permanent(page, 'Forgotten Ancient').getByText('+1/+1×2')).toBeVisible();
  const shock = handCard(page, 'Lab Shock');
  await expect(shock).toHaveClass(/actionable/, { timeout: 15_000 });
  await shock.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Your own cast triggers it too: accept the optional counter.
  const use = page.getByText(/use this ability/i).first();
  await passUntil(page, use);
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await passUntil(page, permanent(page, 'Forgotten Ancient').getByText('+1/+1×3'));

  // At your upkeep, put one counter on each of two other creatures (either player's) and stop.
  // Moving none is the decline, so there is no "use this ability?" prompt first.
  // Each recipient is a card in the prompt with its own Move button; Forgotten Ancient is not one.
  const moveOnto = (name: string) =>
    page.locator('.panel-group').filter({ hasText: name }).getByRole('button', { name: 'Move' });
  await passUntil(page, moveOnto('Lab Servo'));
  await expect(page.locator('.panel-group').getByRole('button', { name: 'Move' })).toHaveCount(2);
  await moveOnto('Lab Servo').click();
  await passUntil(page, page.getByText(/\(2 left\)/).first());
  await moveOnto('Lab Ox').click();
  await passUntil(page, page.getByText(/\(1 left\)/).first());
  await passUntil(page, page.getByRole('button', { name: 'Move no more counters' }));
  await page.getByRole('button', { name: 'Move no more counters' }).click();

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Forgotten Ancient').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('2/2')).toBeVisible();
  await expect(permanent(page, 'Lab Ox').getByText('5/5')).toBeVisible();
});

test('Pensive Professor: Increment grows it, then the counter draws a card', async ({ page }) => {
  await runScenario(page, 'Pensive Professor: Increment grows it, then the counter draws a card');
  // The only card in hand is Lab Ripple, and nothing has been drawn yet.
  await expect(handCard(page, 'Island')).toHaveCount(0);
  const ripple = handCard(page, 'Lab Ripple');
  await expect(ripple).toHaveClass(/actionable/, { timeout: 15_000 });
  await ripple.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // One mana beats the 0/3's power of 0: Increment puts a counter, and that counter draws a card.
  await passUntil(page, permanent(page, 'Pensive Professor').getByText('+1/+1×1'));
  await expect(permanent(page, 'Pensive Professor').getByText('1/3')).toBeVisible();
  await passUntil(page, handCard(page, 'Island'));
  await expect(handCard(page, 'Island')).toHaveCount(1);
  await expect(handCard(page, 'Lab Ripple')).toHaveCount(0);
});

test('Mikey & Leo, Chaos & Order: the first counter you put each turn draws a card', async ({
  page,
}) => {
  await runScenario(
    page,
    'Mikey & Leo, Chaos & Order: the first counter you put each turn draws a card',
  );
  // Nothing has been drawn yet: the hand is the two Lab Grafts.
  await expect(handCard(page, 'Lab Graft')).toHaveCount(2);
  await expect(handCard(page, 'Lab Ox').or(handCard(page, 'Lab Hex'))).toHaveCount(0);
  const castOnServo = async () => {
    const graft = handCard(page, 'Lab Graft').first();
    await expect(graft).toHaveClass(/actionable/, { timeout: 15_000 });
    await graft.click();
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, 'Lab Servo').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await confirm(page);
  };

  // The first counter you put on a creature you control draws a card.
  await castOnServo();
  await passUntil(page, permanent(page, 'Lab Servo').getByText('+1/+1×1'));
  const drawn = handCard(page, 'Lab Ox').or(handCard(page, 'Lab Hex'));
  await passUntil(page, drawn);
  await expect(handCard(page, 'Lab Graft')).toHaveCount(1);
  await expect(drawn).toHaveCount(1);

  // The second counter the same turn does not: the ability triggers only once each turn.
  await castOnServo();
  await passUntil(page, permanent(page, 'Lab Servo').getByText('+1/+1×2'));
  await expect(handCard(page, 'Lab Graft')).toHaveCount(0);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(drawn).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
});

test('Animate Dead: destroy the Aura and the returned creature is sacrificed', async ({ page }) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, 'Animate Dead: destroy the Aura and the returned creature is sacrificed');
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);

  // Return Lab Ox from P2's graveyard under your control with the Aura attached.
  const animate = handCard(page, 'Animate Dead');
  await expect(animate).toHaveClass(/actionable/, { timeout: 15_000 });
  await animate.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page
    .locator('.zone-card-thumb.targetable')
    .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
    .click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Lab Uproot is cast in this same main phase, so never pass on an empty stack here.
  await passStackUntil(page, permanent(page, 'Lab Ox'));
  await expect(permanent(page, 'Lab Ox')).toContainText('3/4');
  await expect
    .poll(() => {
      const board = boards.at(-1);
      const ox = board?.find((p) => p.name === 'Lab Ox');
      return ox === undefined
        ? undefined
        : board?.find((p) => p.name === 'Animate Dead')?.attachedTo === ox.id;
    })
    .toBe(true);

  // Destroy the Aura while Lab Ox is alive: leaving the battlefield sacrifices it.
  const uproot = handCard(page, 'Lab Uproot');
  await expect(uproot).toHaveClass(/actionable/, { timeout: 15_000 });
  await uproot.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Animate Dead').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Animate Dead')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByText(/Lab Ox's controller sacrifices it/).first()).toBeVisible();
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Bess, Soul Nourisher: a 1/1 entering grows Bess, then her attack pumps the 1/1s', async ({
  page,
}) => {
  await runScenario(
    page,
    'Bess, Soul Nourisher: a 1/1 entering grows Bess, then her attack pumps the 1/1s',
  );
  await expect(permanent(page, 'Bess, Soul Nourisher').getByText('+1/+1')).toHaveCount(0);
  const servo = handCard(page, 'Lab Servo');
  await expect(servo).toHaveClass(/actionable/, { timeout: 15_000 });
  await servo.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Lab Servo is another base-1/1 creature entering: Bess gets one counter and is a 2/2.
  await passUntil(page, permanent(page, 'Lab Servo'));
  await passUntil(page, permanent(page, 'Bess, Soul Nourisher').getByText('+1/+1×1'));
  await expect(permanent(page, 'Bess, Soul Nourisher').getByText('2/2')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('1/1')).toBeVisible();

  // Nothing is castable now, so priority passes and combat begins. Only Bess can attack.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Bess, Soul Nourisher' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  // Her attack trigger gives the other base-1/1 creature +1/+1 until end of turn.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Servo').getByText('2/2')).toBeVisible();
  await expect(page.getByText(/Bess, Soul Nourisher deals 2 to P2/).first()).toBeVisible();
});

test('Aetheric Amplifier: double the counters on a target permanent', async ({ page }) => {
  await runScenario(page, 'Aetheric Amplifier: double the counters on a target permanent');
  // Lab Servo carries two +1/+1 counters and one charge counter; you have three energy.
  await expect(permanent(page, 'Lab Servo').getByText('+1/+1×2')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('3/3')).toBeVisible();
  await expect(page.getByLabel('Global counters')).toContainText('3');

  const amplifier = permanent(page, 'Aetheric Amplifier');
  await expect(amplifier).toHaveClass(/actionable/, { timeout: 15_000 });
  await amplifier.click();
  // The choose-one is offered as one action per mode.
  const permanentMode = page.getByRole('button', {
    name: /double the number of each kind of counter on target permanent/i,
  });
  await expect(permanentMode).toBeVisible();
  await expect(
    page.getByRole('button', { name: /double the number of each kind of counter you have/i }),
  ).toBeVisible();
  await permanentMode.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Servo').click();
  // The tray auto-pays the {4} as it confirms: one Confirm puts the ability on the stack.
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, permanent(page, 'Lab Servo').getByText('+1/+1×4'));
  await expect(permanent(page, 'Lab Servo').getByText('5/5')).toBeVisible();
  await expect(permanent(page, 'Aetheric Amplifier').locator('.tap-badge')).toHaveText('TAP');
  // The mode only doubles the target's counters: your energy is unchanged.
  await expect(page.getByLabel('Global counters')).toContainText('3');
});

test('The Thing: four counters after a noncreature spell, then pay to double counters', async ({
  page,
}) => {
  await runScenario(
    page,
    'The Thing: four counters after a noncreature spell, then pay to double counters',
  );
  await expect(permanent(page, 'The Thing').getByText('+1/+1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Hex').getByText('charge×1')).toBeVisible();

  // A noncreature spell this turn: at the beginning of combat The Thing gets four counters.
  await castAndResolve(page, 'Lab Ripple');
  await passUntil(page, permanent(page, 'The Thing').getByText('+1/+1×4'));
  await expect(permanent(page, 'The Thing').getByText('9/9')).toBeVisible();

  // Only The Thing can attack.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'The Thing' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Pay {R}{G}{W}{U} with the other four lands, then choose the permanents to double.
  const pay = page.getByRole('button', { name: /^Pay / });
  await passUntil(page, pay);
  await pay.click();
  await passUntil(page, page.getByRole('button', { name: 'Choose no more targets' }));
  await page.getByRole('button', { name: 'Target The Thing' }).click();
  await page.getByRole('button', { name: 'Target Lab Hex' }).click();
  await page.getByRole('button', { name: 'Choose no more targets' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'The Thing').getByText('+1/+1×8')).toBeVisible();
  await expect(permanent(page, 'The Thing').getByText('13/13')).toBeVisible();
  await expect(permanent(page, 'Lab Hex').getByText('charge×2')).toBeVisible();
  await expect(page.getByText(/The Thing deals 13 to P2/).first()).toBeVisible();
});

test('Lockjaw, Slobbering Teleporter: a noncreature spell grows it and makes two creatures unblockable', async ({
  page,
}) => {
  await runScenario(
    page,
    'Lockjaw, Slobbering Teleporter: a noncreature spell grows it and makes two creatures unblockable',
  );
  await expect(permanent(page, 'Lockjaw, Slobbering Teleporter').getByText('1/1')).toBeVisible();
  await castAndResolve(page, 'Lab Ripple');

  // At the beginning of combat Lockjaw gets a counter, then its reflexive trigger asks for up to
  // one other creature: choose Lab Servo.
  await passUntil(page, page.getByRole('button', { name: 'Target Lab Servo' }));
  await expect(
    permanent(page, 'Lockjaw, Slobbering Teleporter').getByText('+1/+1×1'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Target Lab Servo' }).click();

  // Both creatures attack P2, and Lab Ox is never asked to block either of them.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  for (const name of ['Lockjaw, Slobbering Teleporter', 'Lab Servo']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByRole('button', { name: /Declare blockers/ })).toHaveCount(0);
  await expect(
    page.getByText(/Lockjaw, Slobbering Teleporter deals 2 to P2/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Lab Servo deals 1 to P2/).first()).toBeVisible();
  await expect(permanent(page, 'Lockjaw, Slobbering Teleporter').locator('.tap-badge')).toHaveCount(
    0,
  );
});

test('Belladonna Took: three tokens give life, then a card, then a counter on each creature', async ({
  page,
}) => {
  await runScenario(
    page,
    'Belladonna Took: three tokens give life, then a card, then a counter on each creature',
  );
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(3);

  const castForge = async (servos: number) => {
    const forge = handCard(page, 'Lab Token Forge').first();
    await expect(forge).toHaveClass(/actionable/, { timeout: 15_000 });
    await forge.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
    // Identical tokens share one tile with a count.
    await passUntil(
      page,
      servos === 1
        ? permanent(page, 'Servo')
        : permanent(page, 'Servo').filter({ hasText: `×${servos}` }),
    );
  };

  // First resolution: gain 1 life.
  await castForge(1);
  await passUntil(page, page.locator('.log .line', { hasText: /gains 1 life/ }).first());
  await expect(hand).toHaveCount(2);

  // Second resolution: draw a card (two Forges left, then one drawn card).
  await castForge(2);
  await passUntil(page, page.locator('.log .line', { hasText: /draws/ }).first());
  await expect(hand).toHaveCount(2);

  // Third resolution: a +1/+1 counter on each creature you control.
  await castForge(3);
  await passUntil(page, permanent(page, 'Belladonna Took').getByText('+1/+1×1'));
  await expect(permanent(page, 'Lab Ox').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Servo').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Servo')).toContainText('×3');
  await expect(page.locator('.log .line', { hasText: /gains 1 life/ })).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
});

test('Rumor Gatherer: scry 1, then draw instead on the second creature, then scry again', async ({
  page,
}) => {
  await runScenario(
    page,
    'Rumor Gatherer: scry 1, then draw instead on the second creature, then scry again',
  );
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(3);
  const keep = page.getByRole('button', { name: /^Keep .+ on top$/ });

  const castForge = async (servos: number) => {
    const forge = handCard(page, 'Lab Token Forge').first();
    await expect(forge).toHaveClass(/actionable/, { timeout: 15_000 });
    await forge.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
    // Identical tokens share one tile with a count.
    await passUntil(
      page,
      servos === 1
        ? permanent(page, 'Servo')
        : permanent(page, 'Servo').filter({ hasText: `×${servos}` }),
    );
  };

  // First creature: scry 1.
  await castForge(1);
  await passUntil(page, keep);
  await keep.click();
  await expect(hand).toHaveCount(2);

  // Second creature: draw a card instead, with no scry prompt.
  await castForge(2);
  await passUntil(page, page.locator('.log .line', { hasText: /draws/ }).first());
  await expect(keep).toHaveCount(0);
  await expect(hand).toHaveCount(2);

  // Third creature: scry 1 again.
  await castForge(3);
  await passUntil(page, keep);
  await keep.click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(hand).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
});

test('Crystal, Inhuman Princess: a two-color spell deals 2 to each opponent', async ({ page }) => {
  await runScenario(page, 'Crystal, Inhuman Princess: a two-color spell deals 2 to each opponent');
  await castAndResolve(page, 'Lab Gruul Charm');
  await passUntil(page, page.getByText(/game over/i).first());
  // The spell is two colors, so Crystal dealt 2 to each of the three opponents, and no more.
  for (const opponent of ['P2', 'P3', 'P4']) {
    await expect(
      page.locator('.log .line', {
        hasText: new RegExp(`Crystal, Inhuman Princess.*deals 2 to ${opponent}`),
      }),
    ).toHaveCount(1);
  }
  await expect(
    page.locator('.log .line', { hasText: /Crystal, Inhuman Princess.*deals \d+ to/ }),
  ).toHaveCount(3);
  await expect(page.locator('.log .line', { hasText: /gains 1 life/ })).toHaveCount(1);
});

test('Call Forth the Tempest: damage equals the mana value of your other spells this turn', async ({
  page,
}) => {
  await runScenario(
    page,
    'Call Forth the Tempest: damage equals the mana value of your other spells this turn',
  );
  const callForth = handCard(page, 'Call Forth the Tempest');
  await expect(callForth).toHaveClass(/actionable/, { timeout: 15_000 });
  await callForth.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Two identical cascade triggers: put either on the stack first.
  const order = page.getByRole('button', { name: /Call Forth the Tempest: Cascade/ }).first();
  await passUntil(page, order);
  await order.click();

  // Each cascade finds a cheaper spell: cast both for free.
  for (const name of ['Lab Cascade Two', 'Lab Cascade Three']) {
    const cast = page.getByRole('button', { name: `Cast ${name} without paying its mana cost` });
    await passUntil(page, cast);
    await cast.click();
  }

  // 2 + 3 = 5 damage to each of P2's creatures: Lab Ox (4/4) dies, Lab Tower (0/10) lives.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Tower')).toBeVisible();
  await expect(page.getByText(/Call Forth the Tempest deals 5 to Lab Tower/).first()).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
  await expect(page.getByText(/Call Forth the Tempest deals \d+ to Lab Servo/)).toHaveCount(0);
});

test('First Family: draw and gain life for each color among your permanents and spells', async ({
  page,
}) => {
  await runScenario(
    page,
    'First Family: draw and gain life for each color among your permanents and spells',
  );
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(1);
  await castAndResolve(page, 'First Family');
  // Red from Lab Red Bear, green and blue from First Family itself: X = 3.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(hand).toHaveCount(3);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(3);
  await expect(page.locator('.log .line', { hasText: /gains 3 life/ })).toHaveCount(1);
});

test('Unbreakable Formation: cast in your main phase, your creatures also get counters and vigilance', async ({
  page,
}) => {
  await runScenario(
    page,
    'Unbreakable Formation: cast in your main phase, your creatures also get counters and vigilance',
  );
  await expect(permanent(page, 'Lab Red Bear').getByText('2/2')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('1/1')).toBeVisible();
  await castAndResolve(page, 'Unbreakable Formation');
  await passUntil(page, page.getByText(/game over/i).first());

  // Cast in your main phase: each of your creatures gets a counter (and so grows by one).
  await expect(permanent(page, 'Lab Red Bear').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Lab Red Bear').getByText('3/3')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Lab Servo').getByText('2/2')).toBeVisible();
  // Indestructible and vigilance until end of turn are granted to those two creatures only.
  for (const name of ['Lab Red Bear', 'Lab Servo']) {
    await expect(permanent(page, name)).toContainText(/indestructible/i);
    await expect(permanent(page, name)).toContainText(/vigilance/i);
  }
  // The opponent's creature gets nothing.
  await expect(permanent(page, 'Lab Ox').getByText('+1/+1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox').getByText('4/4')).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).not.toContainText(/indestructible|vigilance/i);
});

test('The Fantasticar: become a creature, then sacrifice it on your fourth noncreature spell', async ({
  page,
}) => {
  await runScenario(
    page,
    'The Fantasticar: become a creature, then sacrifice it on your fourth noncreature spell',
  );
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  const no = page.getByRole('button', { name: 'No', exact: true });
  const castGain = async () => {
    const spell = handCard(page, 'Lab Quick Gain').first();
    await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
    await spell.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
  };

  // As a Vehicle it shows no power and toughness yet.
  await expect(permanent(page, 'The Fantasticar')).not.toContainText('4/4');
  // Spell 1: accept the creature trigger; it is a 4/4 flying artifact creature.
  await castGain();
  await passUntil(page, yes);
  await yes.click();
  await expect(permanent(page, 'The Fantasticar').getByText('4/4')).toBeVisible();
  await expect(permanent(page, 'The Fantasticar')).toContainText(/flying/i);

  // Spells 2 and 3: decline the creature trigger.
  for (let spell = 2; spell <= 3; spell++) {
    await castGain();
    await passUntil(page, no);
    await no.click();
  }

  // Spell 4: both triggers fire. Put the sacrifice on the stack first so it resolves last.
  await castGain();
  const sacrificeFirst = page.getByRole('button', { name: /fourth noncreature spell/ });
  await passUntil(page, sacrificeFirst);
  await sacrificeFirst.click();
  await passUntil(page, no);
  await no.click();
  await passUntil(page, yes);
  await yes.click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'The Fantasticar')).toHaveCount(0);
  await expect(permanent(page, 'Construct')).toContainText('×4');
  await expect(permanent(page, 'Construct')).toContainText('4/4');
  await expect(permanent(page, 'Construct')).toContainText(/flying/i);
  await expect(permanent(page, 'Construct')).toContainText(/haste/i);
});

test('Kutzil, Malamet Exemplar: one grown creature connecting draws a card, and opponents cannot cast spells', async ({
  page,
}) => {
  await runScenario(
    page,
    'Kutzil, Malamet Exemplar: one grown creature connecting draws a card, and opponents cannot cast spells',
  );
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo').getByText('2/2')).toBeVisible();

  // All three creatures attack P2, who controls no creatures.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  for (const name of ['Kutzil, Malamet Exemplar', 'Lab Servo', 'Lab Red Bear']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Only the grown Lab Servo is above its base power: a single trigger, a single card.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(hand).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
  // P2 never cast Lab Shock on our turn.
  await expect(page.locator('.log .line', { hasText: /P2 casts/ })).toHaveCount(0);
});

test('Finneas, Ace Archer: attacking grows your tokens and Rabbits, and total power 10 draws a card', async ({
  page,
}) => {
  await runScenario(
    page,
    'Finneas, Ace Archer: attacking grows your tokens and Rabbits, and total power 10 draws a card',
  );
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(1);
  await castAndResolve(page, 'Lab Token Forge');
  await passUntil(page, permanent(page, 'Servo'));
  await expect(hand).toHaveCount(0);

  // Finneas, Lab Rabbit and Lab Ox can attack; the Servo token is summoning sick.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  for (const name of ['Finneas, Ace Archer', 'Lab Rabbit', 'Lab Ox']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The token and the Rabbit grow (total power 9 -> 11), and that draws one card.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Servo').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Lab Rabbit').getByText('+1/+1×1')).toBeVisible();
  await expect(permanent(page, 'Finneas, Ace Archer').getByText('+1/+1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox').getByText('+1/+1')).toHaveCount(0);
  await expect(hand).toHaveCount(1);
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(1);
});

test('Captain America, Skybound: battalion grows each attacker and makes them indestructible', async ({
  page,
}) => {
  await runScenario(
    page,
    'Captain America, Skybound: battalion grows each attacker and makes them indestructible',
  );
  // Captain America and two others attack; Lab Servo stays home.
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  for (const name of ['Captain America, Skybound', 'Lab Ox', 'Lab Red Bear']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  for (const name of ['Captain America, Skybound', 'Lab Ox', 'Lab Red Bear']) {
    await expect(permanent(page, name).getByText('+1/+1×1')).toBeVisible();
    await expect(permanent(page, name)).toContainText(/indestructible/i);
  }
  await expect(permanent(page, 'Lab Servo').getByText('+1/+1')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).not.toContainText(/indestructible/i);
  // Lab Ox 4/4 -> 5/5, Lab Red Bear 2/2 -> 3/3.
  await expect(permanent(page, 'Lab Ox').getByText('5/5')).toBeVisible();
  await expect(permanent(page, 'Lab Red Bear').getByText('3/3')).toBeVisible();
});

test('Cranial Plating: equip, then move it with {B}{B}', async ({ page }) => {
  await runScenario(page, 'Cranial Plating: equip, then move it with {B}{B}');
  await expect(permanent(page, 'Lab Green Bear').getByText('2/2')).toBeVisible();
  await expect(permanent(page, 'Lab Ox').getByText('4/4')).toBeVisible();

  const plating = permanent(page, 'Cranial Plating');
  await expect(plating).toHaveClass(/actionable/, { timeout: 15_000 });
  await plating.click();
  // Equip {1} and the {B}{B} attach are separate actions.
  await expect(page.getByRole('button', { name: /Attach this Equipment/ })).toBeVisible();
  await page.getByRole('button', { name: /Equip \{1\}/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  // Only your own creatures can be chosen: the opponent's Lab Bird is not a legal target.
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Bird')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Payment is automatic: the untapped Swamps are the only way to pay.

  // Plating is the only artifact: the Bear gets +1/+0 and Lab Ox is untouched.
  await passStackUntil(page, permanent(page, 'Lab Green Bear').getByText('3/2'));
  await expect(permanent(page, 'Lab Ox').getByText('4/4')).toBeVisible();

  // The {B}{B} ability needs no timing window: move Plating onto Lab Ox.
  await expect(plating).toHaveClass(/actionable/, { timeout: 15_000 });
  await plating.click();
  // Choose Lab Ox for the attach. Lab Green Bear is a legal but no-op target (CR 701.3b); the
  // engine leaves the current host out of the options.
  await page.getByRole('button', { name: /Attach this Equipment/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, permanent(page, 'Lab Ox').getByText('5/4'));
  await expect(permanent(page, 'Lab Green Bear').getByText('2/2')).toBeVisible();
});

test('Cranial Plating: attach it with a spell on the stack, and its bonus tracks your artifacts', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Cranial Plating: attach it with a spell on the stack, and its bonus tracks your artifacts',
  );
  await expect(permanent(page, 'Lab Green Bear').getByText('2/2')).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toHaveCount(1);
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  expect(boards.at(-1)!.find((p) => p.name === 'Cranial Plating')?.attachedTo ?? null).toBeNull();

  const plating = permanent(page, 'Cranial Plating');
  await expect(plating).toHaveClass(/actionable/, { timeout: 15_000 });
  // With an empty stack Plating offers Equip {1} and the {B}{B} attach as two separate actions.
  await plating.click();
  await expect(page.getByRole('button', { name: /Equip \{1\}/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Attach this Equipment/ })).toBeVisible();

  // Cast Lab Token Forge and leave it on the stack: it is the spell Plating is activated over.
  const forge = handCard(page, 'Lab Token Forge');
  await expect(forge).toHaveClass(/actionable/, { timeout: 15_000 });
  await forge.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await expect(page.locator('.stack li').filter({ hasText: 'Lab Token Forge' })).toHaveCount(1, {
    timeout: 15_000,
  });

  // Equip is sorcery speed, so it is gone; the {B}{B} attach is Plating's only action now and
  // clicking Plating goes straight to choosing a creature you control.
  await expect(plating).toHaveClass(/actionable/, { timeout: 15_000 });
  await plating.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Equip \{1\}/ })).toHaveCount(0);
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Servo')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  // Attach over Forge: both abilities are on the stack and nothing has resolved yet.
  await expect(page.locator('.stack li')).toHaveCount(2, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Green Bear').getByText('2/2')).toBeVisible();

  // One deliberate pass resolves only the attach (it is on top): Plating is the only artifact
  // you control, so +1 and P2's Lab Servo adds nothing. The Forge is still on the stack.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(permanent(page, 'Lab Green Bear').getByText('3/2')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.stack li').filter({ hasText: 'Lab Token Forge' })).toHaveCount(1);
  await expect(permanent(page, 'Servo')).toHaveCount(0);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Cranial Plating')?.attachedTo)
    .toBe(bearId);

  // Forge resolves: the Servo token is a second artifact you control, so +2.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await expect(permanent(page, 'Servo')).toHaveCount(1, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Green Bear').getByText('4/2')).toBeVisible();

  // Destroy your own Servo token: you control one artifact again, so the bonus falls to +1.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Servo').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Green Bear').getByText('3/2')).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toHaveCount(1);
  expect(boards.at(-1)!.find((p) => p.name === 'Cranial Plating')?.attachedTo).toBe(bearId);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Mask of Memory: equip it, connect, then draw two and discard a card', async ({ page }) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, 'Mask of Memory: equip it, connect, then draw two and discard a card');
  const hand = page.locator('.human-zone .hand-card');
  await expect(hand).toHaveCount(1);
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  expect(boards.at(-1)!.find((p) => p.name === 'Mask of Memory')?.attachedTo ?? null).toBeNull();

  const mask = permanent(page, 'Mask of Memory');
  await expect(mask).toHaveClass(/actionable/, { timeout: 15_000 });
  // Equip {1} is the Mask's only ability, so clicking it goes straight to choosing a target.
  await mask.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  // Only your own creatures can be chosen: the Bear and Lab Ox.
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Equip resolves on its own (passing is the only legal action). Wait for the attachment
  // rather than passing, because the next step is still this main phase.
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Mask of Memory')?.attachedTo)
    .toBe(bearId);

  // A second, differently equipped creature: Cranial Plating goes on Lab Ox. With the Mask and
  // Plating you control two artifacts, so Lab Ox becomes a 6/4.
  const oxId = boards.at(-1)!.find((p) => p.name === 'Lab Ox')!.id;
  const plating = permanent(page, 'Cranial Plating');
  await expect(plating).toHaveClass(/actionable/, { timeout: 15_000 });
  // One Swamp is left, so the {B}{B} attach is unaffordable and Equip {1} is Plating's only action.
  await plating.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Cranial Plating')?.attachedTo)
    .toBe(oxId);
  await expect(permanent(page, 'Lab Ox').getByText('6/4')).toBeVisible();
  expect(boards.at(-1)!.find((p) => p.name === 'Mask of Memory')?.attachedTo).toBe(bearId);

  // Both Equipment are on, so move on to attackers (advancing the turn is the intent here).
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P3' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Both unblocked creatures deal combat damage to a player, but only the Mask's creature
  // triggers it: accept the optional draw once.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  // The hand is Lab Hex plus the two drawn Forests; discarding is the player's choice.
  await expect(page.getByText(/Discard a card \(1 of 1\)/i)).toBeVisible({ timeout: 15_000 });
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Lab Hex' })
    .first()
    .getByRole('button', { name: 'Discard', exact: true })
    .click();

  // Lab Ox's damage to P3 asked about nothing: the game ends with no second prompt or draw.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/use this ability/i)).toHaveCount(0);
  await expect(hand).toHaveCount(2);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('38');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('34');
  await expect(page.locator('.log .line', { hasText: /draws/ })).toHaveCount(2);
  expect(boards.at(-1)!.find((p) => p.name === 'Cranial Plating')?.attachedTo).toBe(oxId);
});

test('Resurrection Orb: equip a stolen creature, gain life, lose it, and it returns home', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Resurrection Orb: equip a stolen creature, gain life, lose it, and it returns home',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  // P1 controls the Bear but P2 owns it; the Orb starts unattached and grants nothing yet.
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')?.controller).toBe('P1');
  expect(boards.at(-1)!.find((p) => p.name === 'Resurrection Orb')?.attachedTo ?? null).toBeNull();
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')?.keywords ?? []).not.toContain(
    'lifelink',
  );

  const orb = permanent(page, 'Resurrection Orb');
  await expect(orb).toHaveClass(/actionable/, { timeout: 15_000 });
  // Equip {4} is the Orb's only activated ability, so clicking it goes straight to a target.
  await orb.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Equip resolves, then the turn moves on to attackers; the Bear now has lifelink.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Resurrection Orb')?.attachedTo)
    .toBe(bearId);
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.keywords).toContain('lifelink');
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The unblocked Bear connects: P2 takes 2 and the lifelink gains you 2.
  await passUntil(page, page.locator('.human-zone .life-badge', { hasText: '42' }));
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('38');

  // In your second main phase, destroy your own Bear: it dies into its owner P2's graveyard.
  await passUntil(page, page.getByText(/Main phase\s*2/).first());
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The Orb's trigger waits for the end step; the Bear returns then, under P2's control.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  const back = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear');
  expect(back?.controller).toBe('P2');
  expect(back?.id).not.toBe(bearId);
  expect(boards.at(-1)!.find((p) => p.name === 'Resurrection Orb')?.attachedTo ?? null).toBeNull();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
});

test('Sunforger: equip it, then unattach it to cast a red instant from your library for free', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Sunforger: equip it, then unattach it to cast a red instant from your library for free',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  expect(boards.at(-1)!.find((p) => p.name === 'Sunforger')?.attachedTo ?? null).toBeNull();

  const sunforger = permanent(page, 'Sunforger');
  await expect(sunforger).toHaveClass(/actionable/, { timeout: 15_000 });
  // Unattached, Equip {3} is its only legal action, so clicking it goes straight to a target.
  await sunforger.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Equip resolves on its own (passing is the only legal action) and the Bear becomes a 6/2.
  await expect(permanent(page, 'Lab Green Bear')).toContainText('6/2', { timeout: 15_000 });
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Sunforger')?.attachedTo)
    .toBe(bearId);

  // Attached, the {R}{W} ability is its only legal action now: pay it and unattach as a cost.
  await expect(sunforger).toHaveClass(/actionable/, { timeout: 15_000 });
  await sunforger.click();
  await confirm(page);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Sunforger')?.attachedTo ?? null)
    .toBeNull();
  await expect(permanent(page, 'Sunforger')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Only the red or white instants with mana value 4 or less are offered from the library: the
  // red instant and the white one, not the mana value 5 red instant, the blue instant or the red
  // sorcery.
  const castForFree = page.getByRole('button', { name: 'Cast for free' });
  await expect(castForFree).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByRole('img', { name: 'Lab Quick Gain' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Lab Sun White Instant' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Lab Sun Red Big Instant' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Sun Blue Instant' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Lab Sun Red Sorcery' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find nothing' })).toBeVisible();
  // Cast the red one, which is listed first.
  await castForFree.first().click();

  // The free spell resolves: 1 life gained, and Sunforger stays on the battlefield unattached.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await expect(permanent(page, 'Sunforger')).toHaveCount(1);
  expect(boards.at(-1)!.find((p) => p.name === 'Sunforger')?.attachedTo ?? null).toBeNull();
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');
});

test('Screams from Within: its creature dies and it returns onto a hexproof opposing creature', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Screams from Within: its creature dies and it returns onto a hexproof opposing creature',
  );
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Hexproof Elf')?.id)
    .toBeTruthy();
  const elfId = boards.at(-1)!.find((p) => p.name === 'Lab Hexproof Elf')!.id;
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura: only creatures you can target are legal, so the hexproof Elf is not.
  const screams = handCard(page, 'Screams from Within');
  await expect(screams).toHaveClass(/actionable/, { timeout: 15_000 });
  const screamsBefore = await page.getByText('Screams from Within resolves').count();
  await screams.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Hexproof Elf')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Let it resolve: the enchanted Bear is a 1/1 and the Ox is untouched.
  await awaitResolution(page, 'Screams from Within', screamsBefore);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('1/1', { timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Screams from Within')?.attachedTo)
    .toBe(bearId);

  // Destroy the enchanted Bear. The Aura goes to the graveyard with it and its trigger returns it.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The Aura chooses what to enchant as it enters: both the Ox and the opposing hexproof Elf are
  // legal choices (nothing is targeted), and the Bear that just died is not on the board.
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/actionable/, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Hexproof Elf')).toHaveClass(/actionable/);
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await permanent(page, 'Lab Hexproof Elf').click();
  await expect(page.getByText('Enchant Lab Hexproof Elf')).toBeVisible();
  await confirm(page);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Screams from Within')?.attachedTo)
    .toBe(elfId);

  await passUntil(page, page.getByText(/game over/i).first());
  const final = boards.at(-1)!;
  const back = final.find((p) => p.name === 'Screams from Within');
  expect(back?.attachedTo).toBe(elfId);
  expect(back?.controller).toBe('P1');
  expect(back?.id).not.toBe(final.find((p) => p.name === 'Lab Ox')?.id);
  await expect(permanent(page, 'Screams from Within')).toHaveCount(1);
  await expect(permanent(page, 'Lab Hexproof Elf')).toContainText('1/1');
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  // Lab Green Bear and Lab Doom are in your graveyard; the Aura is not.
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Ghoulish Impetus: its creature dies and it returns at the next end step', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Ghoulish Impetus: its creature dies and it returns at the next end step',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Ox')?.id).toBeTruthy();
  const oxId = boards.at(-1)!.find((p) => p.name === 'Lab Ox')!.id;
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on the Bear: the hexproof Elf is not a legal target.
  const impetus = handCard(page, 'Ghoulish Impetus');
  await expect(impetus).toHaveClass(/actionable/, { timeout: 15_000 });
  const impetusBefore = await page.getByText('Ghoulish Impetus resolves').count();
  await impetus.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Hexproof Elf')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Let it resolve: the Bear is a 3/3 with deathtouch, goaded by you.
  await awaitResolution(page, 'Ghoulish Impetus', impetusBefore);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3', { timeout: 15_000 });
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Ghoulish Impetus')?.attachedTo)
    .toBe(bearId);
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.keywords).toContain('deathtouch');
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');

  // Destroy the enchanted Bear. The Aura goes to the graveyard with it, and nothing returns yet.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The return waits for the beginning of the end step, where the Aura chooses what to enchant.
  await passUntil(page, page.getByText('Ghoulish Impetus: choose a permanent to enchant.'));
  await expect(permanent(page, 'Ghoulish Impetus')).toHaveCount(0);
  await expect(page.getByText('Graveyard (3)')).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/actionable/, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Hexproof Elf')).toHaveClass(/actionable/);
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText('Enchant Lab Ox')).toBeVisible();
  await confirm(page);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Ghoulish Impetus')?.attachedTo)
    .toBe(oxId);

  await passUntil(page, page.getByText(/game over/i).first());
  const back = boards.at(-1)!.find((p) => p.name === 'Ghoulish Impetus');
  expect(back?.attachedTo).toBe(oxId);
  expect(back?.controller).toBe('P1');
  expect(boards.at(-1)!.find((p) => p.id === oxId)?.keywords).toContain('deathtouch');
  await expect(permanent(page, 'Ghoulish Impetus')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Ghoulish Impetus: the goaded creature must attack, an unenchanted one may stay home', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Ghoulish Impetus: the goaded creature must attack, an unenchanted one may stay home',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on Lab Green Bear and let it resolve: a 3/3 with deathtouch.
  const impetus = handCard(page, 'Ghoulish Impetus');
  await expect(impetus).toHaveClass(/actionable/, { timeout: 15_000 });
  const impetusBefore = await page.getByText('Ghoulish Impetus resolves').count();
  await impetus.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Ghoulish Impetus', impetusBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Ghoulish Impetus')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3');
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.keywords).toContain('deathtouch');
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');

  // Declare attackers: the goaded Bear has no "Stay home" choice and may not attack you; the
  // unenchanted Ox has one.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  const bearRow = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Green Bear' });
  const oxRow = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Ox' });
  await expect(bearRow).toBeVisible();
  await expect(bearRow.getByRole('button', { name: 'Stay home' })).toHaveCount(0);
  await expect(oxRow.getByRole('button', { name: 'Stay home' })).toHaveCount(1);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(bearRow.getByRole('button', { name: seat })).toHaveCount(1);
  await expect(bearRow.getByRole('button', { name: 'P1' })).toHaveCount(0);

  // Never assign the Bear: it attacks anyway. Ox stays home.
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('37');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
  await expect(permanent(page, 'Ghoulish Impetus')).toHaveCount(1);
});

test('Ghoulish Impetus: P2’s goaded creature cannot attack you, their other creature can', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Ghoulish Impetus: P2’s goaded creature cannot attack you, their other creature can',
  );
  // P2's scripted seat attacks you with everything it may; the scenario then plays out on its own.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });

  // Your Aura stays on P2's Lab Green Bear (a 3/3 with deathtouch).
  const final = boards.at(-1)!;
  const bear = final.find((p) => p.name === 'Lab Green Bear')!;
  expect(final.find((p) => p.name === 'Ghoulish Impetus')?.attachedTo).toBe(bear.id);
  expect(final.find((p) => p.name === 'Ghoulish Impetus')?.controller).toBe('P1');
  expect(bear.controller).toBe('P2');
  expect(bear.keywords).toContain('deathtouch');
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3');

  // Only the unenchanted Lab Ox attacked you (4): you are at 36, not 33. The goaded Bear
  // attacked someone else: P3 took 3 and P4 is untouched.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('37');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
});

test('Gift of Immortality: the creature returns to its owner, then the Aura returns onto it', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Gift of Immortality: the creature returns to its owner, then the Aura returns onto it',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.controller).toBe('P1');

  // Cast the Aura on the Bear you control but P2 owns.
  const gift = handCard(page, 'Gift of Immortality');
  await expect(gift).toHaveClass(/actionable/, { timeout: 15_000 });
  const giftBefore = await page.getByText('Gift of Immortality resolves').count();
  await gift.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Gift of Immortality', giftBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Gift of Immortality')?.attachedTo)
    .toBe(bearId);

  // Destroy the enchanted Bear. It dies into P2's graveyard and its trigger returns it at once,
  // under P2's control (the Aura follows at the end step; the headless scenario pins that order).
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.controller)
    .toBe('P2');
  const returnedBear = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!;
  expect(returnedBear.id).not.toBe(bearId);

  // At the beginning of the end step the Aura returns attached to that Bear, under your control.
  await passUntil(page, page.getByText(/game over/i).first());
  const back = boards.at(-1)!.find((p) => p.name === 'Gift of Immortality');
  expect(back?.attachedTo).toBe(returnedBear.id);
  expect(back?.controller).toBe('P1');
  await expect(permanent(page, 'Gift of Immortality')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')?.controller).toBe('P2');
  // Lab Doom is your only graveyard card.
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
});

test("Ajani's Chosen: an Aura you cast moves onto the Cat it makes", async ({ page }) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, "Ajani's Chosen: an Aura you cast moves onto the Cat it makes");
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on the Bear and let it resolve: the Bear is a 4/4.
  const aegis = handCard(page, 'Lab Aegis');
  await expect(aegis).toHaveClass(/actionable/, { timeout: 15_000 });
  const aegisBefore = await page.getByText('Lab Aegis resolves').count();
  await aegis.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Aegis', aegisBefore);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('4/4', { timeout: 15_000 });
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Aegis')?.attachedTo)
    .toBe(bearId);

  // The trigger resolves on its own: a Cat is made, and the attach is offered with a way to
  // decline.
  await expect(page.getByRole('button', { name: /Don.t attach Lab Aegis/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('img', { name: 'Cat', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();

  // The Aura moved: the Cat is a 4/4 and the Bear a 2/2 again.
  await expect(permanent(page, 'Cat')).toContainText('4/4', { timeout: 15_000 });
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');
  const catId = boards.at(-1)!.find((p) => p.name === 'Cat')!.id;
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Aegis')?.attachedTo).toBe(catId);
  await expect(permanent(page, 'Cat')).toHaveCount(1);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(1);
});

test("Ajani's Chosen: a non-Aura enchantment you cast makes a Cat with nothing to attach", async ({
  page,
}) => {
  await runScenario(
    page,
    "Ajani's Chosen: a non-Aura enchantment you cast makes a Cat with nothing to attach",
  );
  await expect(permanent(page, 'Cat')).toHaveCount(0);

  // Cast the enchantment: it is not an Aura, so it has no target.
  const hex = handCard(page, 'Lab Hex');
  await expect(hex).toHaveClass(/actionable/, { timeout: 15_000 });
  const hexBefore = await page.getByText('Lab Hex resolves').count();
  await hex.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Hex', hexBefore);

  // The trigger resolves on its own and makes the Cat.
  await expect(permanent(page, 'Cat')).toContainText('2/2', { timeout: 15_000 });
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Cat')).toHaveCount(1);
  await expect(permanent(page, 'Lab Hex')).toHaveCount(1);
  await expect(permanent(page, "Ajani's Chosen")).toContainText('3/3');
  // There was never an attach choice.
  await expect(page.getByRole('button', { name: /attach/i })).toHaveCount(0);
});

test('Shielded by Faith: it moves onto a creature that enters and keeps it indestructible', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Shielded by Faith: it moves onto a creature that enters and keeps it indestructible',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Ox')?.id).toBeTruthy();
  const oxId = boards.at(-1)!.find((p) => p.name === 'Lab Ox')!.id;

  // Cast the Aura on Lab Ox and let it resolve.
  const aura = handCard(page, 'Shielded by Faith');
  await expect(aura).toHaveClass(/actionable/, { timeout: 15_000 });
  const auraBefore = await page.getByText('Shielded by Faith resolves').count();
  await aura.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Shielded by Faith', auraBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Shielded by Faith')?.attachedTo)
    .toBe(oxId);

  // Cast the Bear: the Aura's trigger asks whether to attach it to the new creature.
  const bear = handCard(page, 'Lab Green Bear');
  await expect(bear).toHaveClass(/actionable/, { timeout: 15_000 });
  const bearBefore = await page.getByText('Lab Green Bear resolves').count();
  await bear.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Green Bear', bearBefore);
  await expect(
    page.getByText(/Shielded by Faith — Whenever a creature enters/).first(),
  ).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: 'No', exact: true }));
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Shielded by Faith')?.attachedTo)
    .toBe(bearId);

  // Destroy the Bear: it is indestructible now, so it survives.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  const final = boards.at(-1)!;
  expect(final.find((p) => p.name === 'Shielded by Faith')?.attachedTo).toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(permanent(page, 'Shielded by Faith')).toHaveCount(1);
  // Lab Doom is your only graveyard card.
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
});

test('Shielded by Faith: an opponent’s creature entering offers you the attach', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Shielded by Faith: an opponent’s creature entering offers you the attach',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Ox')?.id).toBeTruthy();
  const oxId = boards.at(-1)!.find((p) => p.name === 'Lab Ox')!.id;
  await expect(permanent(page, 'Lab Flash Wolf')).toHaveCount(0);

  // Cast the Aura on Lab Ox and let it resolve: Lab Ox is indestructible.
  const aura = handCard(page, 'Shielded by Faith');
  await expect(aura).toHaveClass(/actionable/, { timeout: 15_000 });
  const auraBefore = await page.getByText('Shielded by Faith resolves').count();
  await aura.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Shielded by Faith', auraBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Shielded by Faith')?.attachedTo)
    .toBe(oxId);
  await expect(permanent(page, 'Lab Ox')).toContainText(/indestructible/i);

  // Pass: P2 flashes in Lab Flash Wolf, and Shielded by Faith asks you, not P2, about attaching.
  await passUntil(page, page.getByRole('button', { name: 'No', exact: true }));
  await expect(
    page.getByText(/Shielded by Faith — Whenever a creature enters/).first(),
  ).toBeVisible();
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Flash Wolf')?.controller)
    .toBe('P2');
  await expect(permanent(page, 'Lab Flash Wolf')).not.toContainText(/indestructible/i);
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  // The Aura moved onto P2's creature, taking the indestructible with it.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  const wolfId = boards.at(-1)!.find((p) => p.name === 'Lab Flash Wolf')!.id;
  const final = boards.at(-1)!;
  expect(final.find((p) => p.name === 'Shielded by Faith')?.attachedTo).toBe(wolfId);
  expect(final.find((p) => p.name === 'Shielded by Faith')?.controller).toBe('P1');
  await expect(permanent(page, 'Lab Flash Wolf')).toContainText(/indestructible/i);
  await expect(permanent(page, 'Lab Ox')).not.toContainText(/indestructible/i);
  await expect(permanent(page, 'Shielded by Faith')).toHaveCount(1);
});

test('Forum Filibuster: at your upkeep the Inkling gets an Aura from your graveyard', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Forum Filibuster: at your upkeep the Inkling gets an Aura from your graveyard',
  );
  // Your upkeep: the Inkling is made, then the reflexive ability asks for up to one target. Only
  // the Aura is offered, not the creature card, and choosing none is a button of its own.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Lab Aegis' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Target Lab Green Bear' })).toHaveCount(0);
  await expect(permanent(page, 'Inkling')).toContainText('2/1');
  // The token flies: the viewer shows the keyword on the chip and in the board state.
  await expect(permanent(page, 'Inkling')).toContainText(/flying/i);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Inkling')?.keywords)
    .toEqual(['flying']);
  await page.getByRole('button', { name: 'Target Lab Aegis' }).click();

  // It resolves: the Aura is on the Inkling, which is a 4/3, and the creature card stays.
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(1, { timeout: 15_000 });
  await expect(permanent(page, 'Inkling')).toContainText('4/3');
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Aegis')?.attachedTo)
    .toBeTruthy();
  const inklingId = boards.at(-1)!.find((p) => p.name === 'Inkling')!.id;
  const back = boards.at(-1)!.find((p) => p.name === 'Lab Aegis');
  expect(back?.attachedTo).toBe(inklingId);
  expect(back?.controller).toBe('P1');
  await expect(permanent(page, 'Inkling')).toHaveCount(1);
  await expect(permanent(page, 'Inkling')).toContainText(/flying/i);
  expect(boards.at(-1)!.find((p) => p.name === 'Inkling')?.keywords).toEqual(['flying']);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
});

test('Forum Filibuster: at your upkeep the Inkling gets an Equipment from your graveyard', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Forum Filibuster: at your upkeep the Inkling gets an Equipment from your graveyard',
  );
  // Your upkeep: the Inkling is made, then the reflexive ability offers the Equipment and the
  // Aura but not the creature card.
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Target Sunforger' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Target Lab Aegis' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Target Lab Green Bear' })).toHaveCount(0);
  await expect(permanent(page, 'Inkling')).toContainText('2/1');
  await page.getByRole('button', { name: 'Target Sunforger' }).click();

  // It resolves: the Equipment is attached to the Inkling, which is a 6/1 flier; the Aura stays.
  await expect(permanent(page, 'Sunforger')).toHaveCount(1, { timeout: 15_000 });
  await expect(permanent(page, 'Inkling')).toContainText('6/1');
  await expect(permanent(page, 'Inkling')).toContainText(/flying/i);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Sunforger')?.attachedTo)
    .toBeTruthy();
  const inklingId = boards.at(-1)!.find((p) => p.name === 'Inkling')!.id;
  const back = boards.at(-1)!.find((p) => p.name === 'Sunforger');
  expect(back?.attachedTo).toBe(inklingId);
  expect(back?.controller).toBe('P1');
  await expect(permanent(page, 'Inkling')).toHaveCount(1);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(0);
  // Lab Aegis and Lab Green Bear are still in the graveyard.
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test("Karametra's Favor: draw a card, then tap the enchanted creature for mana to cast a spell", async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    "Karametra's Favor: draw a card, then tap the enchanted creature for mana to cast a spell",
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  // Before the Aura the Bear has no mana ability: with the Forests tapped nothing could pay {R}.
  await expect(handCard(page, 'Lab Shock')).not.toHaveClass(/actionable/);

  // Cast the Aura on Lab Green Bear, paying with the Forests, and let it resolve.
  const aura = handCard(page, "Karametra's Favor");
  await expect(aura).toHaveClass(/actionable/, { timeout: 15_000 });
  const favorBefore = await page.getByText("Karametra's Favor resolves").count();
  const drawBefore = await page.getByText('When this Aura enters, draw a card. resolves').count();
  await aura.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, "Karametra's Favor", favorBefore);
  await awaitResolution(page, 'When this Aura enters, draw a card.', drawBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === "Karametra's Favor")?.attachedTo)
    .toBe(bearId);

  // The enters trigger has resolved and drawn the Plains. A pass here would hit the land-drop
  // reminder, since the Plains is then a playable land.
  await expect(handCard(page, 'Plains')).toHaveCount(1, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Green Bear')).not.toContainText('TAP');

  // Both Forests are tapped, yet Lab Shock is castable: the enchanted Bear taps for {R}.
  const shock = handCard(page, 'Lab Shock');
  await expect(shock).toHaveClass(/actionable/, { timeout: 15_000 });
  await shock.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await expect(page.getByText('Lab Shock resolves')).toBeVisible({ timeout: 15_000 });
  // The drawn Plains is a playable land, so passing asks about the land drop.
  await passUntil(page, page.getByRole('button', { name: 'Pass anyway' }));
  await page.getByRole('button', { name: 'Pass anyway' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')?.tapped).toBe(true);
  expect(boards.at(-1)!.find((p) => p.name === "Karametra's Favor")?.attachedTo).toBe(bearId);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await expect(permanent(page, "Karametra's Favor")).toHaveCount(1);
});

test('Redemption Arc: enchant your creature, then pay {1}{W} to exile it with no target', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Redemption Arc: enchant your creature, then pay {1}{W} to exile it with no target',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on Lab Green Bear and let it resolve.
  const arc = handCard(page, 'Redemption Arc');
  await expect(arc).toHaveClass(/actionable/, { timeout: 15_000 });
  const arcBefore = await page.getByText('Redemption Arc resolves').count();
  await arc.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Redemption Arc', arcBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Redemption Arc')?.attachedTo)
    .toBe(bearId);

  // Activate {1}{W}: the Aura's ability takes no target, so there is no target prompt.
  const aura = permanent(page, 'Redemption Arc');
  await expect(aura).toHaveClass(/actionable/, { timeout: 15_000 });
  await aura.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of/)).toHaveCount(0);
  await confirm(page);

  // It resolves: Lab Green Bear is exiled, and the Aura has nothing to enchant.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(permanent(page, 'Redemption Arc')).toHaveCount(0);
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')).toBeUndefined();
  await expect(page.getByText('Exile (1)')).toBeVisible();
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
});

test('Redemption Arc: Lab Doom cannot destroy the creature, which must attack', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Redemption Arc: Lab Doom cannot destroy the creature, which must attack',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on Lab Green Bear and let it resolve: indestructible.
  const arc = handCard(page, 'Redemption Arc');
  await expect(arc).toHaveClass(/actionable/, { timeout: 15_000 });
  const arcBefore = await page.getByText('Redemption Arc resolves').count();
  await arc.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Redemption Arc', arcBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Redemption Arc')?.attachedTo)
    .toBe(bearId);
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.keywords).toContain('indestructible');

  // Destroy it: Lab Doom resolves, but the indestructible Bear survives.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  const doomBefore = await page.getByText('Lab Doom resolves').count();
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Doom', doomBefore);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  expect(boards.at(-1)!.find((p) => p.id === bearId)).toBeDefined();
  await expect(permanent(page, 'Redemption Arc')).toHaveCount(1);

  // Declare attackers: the goaded Bear has no "Stay home" choice and may not attack you; the
  // unenchanted Ox has one.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  const bearRow = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Green Bear' });
  const oxRow = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Ox' });
  await expect(bearRow).toBeVisible();
  await expect(bearRow.getByRole('button', { name: 'Stay home' })).toHaveCount(0);
  await expect(oxRow.getByRole('button', { name: 'Stay home' })).toHaveCount(1);
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(bearRow.getByRole('button', { name: seat })).toHaveCount(1);
  await expect(bearRow.getByRole('button', { name: 'P1' })).toHaveCount(0);

  // Never assign the Bear: it attacks anyway. Ox stays home.
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('38');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
});

test('Redemption Arc: P2’s goaded creature cannot attack you, their other creature can', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Redemption Arc: P2’s goaded creature cannot attack you, their other creature can',
  );
  // P2's scripted seat attacks you with everything it may; the scenario then plays out on its own.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });

  // Your Aura stays on P2's indestructible Lab Green Bear.
  const final = boards.at(-1)!;
  const bear = final.find((p) => p.name === 'Lab Green Bear')!;
  expect(final.find((p) => p.name === 'Redemption Arc')?.attachedTo).toBe(bear.id);
  expect(final.find((p) => p.name === 'Redemption Arc')?.controller).toBe('P1');
  expect(bear.controller).toBe('P2');
  expect(bear.keywords).toContain('indestructible');

  // Only the unenchanted Lab Ox attacked you (4): you are at 36, not 34. The goaded Bear
  // attacked someone else: P3 took 2 and P4 is untouched.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('38');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
});

test('Fallen Ideal: sacrifice for a pump, then sacrifice the creature to get the Aura back', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Fallen Ideal: sacrifice for a pump, then sacrifice the creature to get the Aura back',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;

  // Cast the Aura on Lab Green Bear and let it resolve.
  const ideal = handCard(page, 'Fallen Ideal');
  await expect(ideal).toHaveClass(/actionable/, { timeout: 15_000 });
  const idealBefore = await page.getByText('Fallen Ideal resolves').count();
  await ideal.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Fallen Ideal', idealBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Fallen Ideal')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Sacrifice Lab Ox to the granted ability: the cost is paid at once, and the pump follows.
  const bear = permanent(page, 'Lab Green Bear');
  await expect(bear).toHaveClass(/actionable/, { timeout: 15_000 });
  await bear.click();
  // The ability has no mana cost, so there is no payment to configure; the sacrifice is chosen
  // from your creatures, the enchanted one included.
  await confirm(page);
  await expect(page.getByText(/choose permanent 1 of 1 to sacrifice/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText('Sacrifice Lab Ox')).toBeVisible();
  await confirm(page);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByText('Graveyard (1)')).toBeVisible();
  await passStackUntil(page, permanent(page, 'Lab Green Bear').filter({ hasText: '4/3' }));

  // Sacrifice the enchanted creature itself: the Aura goes to the graveyard and back to hand.
  await expect(bear).toHaveClass(/actionable/, { timeout: 15_000 });
  await bear.click();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(permanent(page, 'Fallen Ideal')).toHaveCount(0);
  await expect(handCard(page, 'Fallen Ideal')).toHaveCount(1);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Fallen Ideal: the enchanted creature flies over Lab Ox and attacks unblocked', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Fallen Ideal: the enchanted creature flies over Lab Ox and attacks unblocked',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).not.toContainText(/flying/i);

  // Cast the Aura on Lab Green Bear: it gains flying.
  const ideal = handCard(page, 'Fallen Ideal');
  await expect(ideal).toHaveClass(/actionable/, { timeout: 15_000 });
  const idealBefore = await page.getByText('Fallen Ideal resolves').count();
  await ideal.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Fallen Ideal', idealBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Fallen Ideal')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText(/flying/i);
  await expect(permanent(page, 'Lab Ox')).not.toContainText(/flying/i);

  // Attack P2: Lab Ox cannot block a flier, so the Bear connects and survives.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  // The enchanted creature has an activated ability, so you are given priority in each step.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('38');
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  const final = boards.at(-1)!;
  expect(final.find((p) => p.id === bearId)?.damageMarked).toBe(0);
  expect(final.find((p) => p.name === 'Lab Ox')?.damageMarked).toBe(0);
});

test('Kor Spiritdancer: cast an Aura on it, draw a card, and it grows by +2/+2 for the Aura', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Kor Spiritdancer: cast an Aura on it, draw a card, and it grows by +2/+2 for the Aura',
  );
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Kor Spiritdancer')?.id)
    .toBeTruthy();
  const korId = boards.at(-1)!.find((p) => p.name === 'Kor Spiritdancer')!.id;
  await expect(permanent(page, 'Kor Spiritdancer')).toContainText('0/2');

  // Cast the Aura on Kor Spiritdancer: its trigger goes on the stack above the spell.
  const aegis = handCard(page, 'Lab Aegis');
  await expect(aegis).toHaveClass(/actionable/, { timeout: 15_000 });
  await aegis.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Kor Spiritdancer').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The trigger is optional: accept the draw.
  await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(1, { timeout: 15_000 });

  // Lab Aegis resolves onto it: +2/+2 from the Aura and +2/+2 more for the Aura attached to it.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Aegis')?.attachedTo)
    .toBe(korId);
  await expect(permanent(page, 'Kor Spiritdancer')).toContainText('4/6');
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(1);
});

test('Kor Spiritdancer: a second attached Aura adds another +2/+2 to the pump', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Kor Spiritdancer: a second attached Aura adds another +2/+2 to the pump',
  );
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Kor Spiritdancer')?.id)
    .toBeTruthy();
  const korId = boards.at(-1)!.find((p) => p.name === 'Kor Spiritdancer')!.id;
  await expect(permanent(page, 'Kor Spiritdancer')).toContainText('0/2');

  // Cast each Aura on Kor Spiritdancer, declining its optional draw, and let it resolve.
  const castAura = async (aura: string, size: string) => {
    const card = handCard(page, aura);
    await expect(card).toHaveClass(/actionable/, { timeout: 15_000 });
    const before = await page.getByText(`${aura} resolves`).count();
    await card.click();
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, 'Kor Spiritdancer').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await confirm(page);
    await expect(page.getByText(/use this ability/i).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'No', exact: true }).click();
    await awaitResolution(page, aura, before);
    await expect.poll(() => boards.at(-1)?.find((p) => p.name === aura)?.attachedTo).toBe(korId);
    await expect(permanent(page, 'Kor Spiritdancer')).toContainText(size);
  };
  // One Aura: +2/+2 from Lab Aegis and +2/+2 for the Aura attached to it.
  await castAura('Lab Aegis', '4/6');
  // Two Auras: +2/+2 and +1/+1 from them, and +4/+4 for the two attached to it.
  await castAura('Lab Mantle', '7/9');

  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Kor Spiritdancer')).toContainText('7/9');
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(1);
  await expect(permanent(page, 'Lab Mantle')).toHaveCount(1);
  await expect(page.locator('.hand-card')).toHaveCount(0);
});

test('Hateful Eidolon: your Aura on an opponent’s creature, then it dies and you draw', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Hateful Eidolon: your Aura on an opponent’s creature, then it dies and you draw',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Bird')?.id).toBeTruthy();
  const birdId = boards.at(-1)!.find((p) => p.name === 'Lab Bird')!.id;
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(0);

  // Enchant the opponent's Lab Bird with your Lab Aegis.
  const aegis = handCard(page, 'Lab Aegis');
  await expect(aegis).toHaveClass(/actionable/, { timeout: 15_000 });
  const aegisBefore = await page.getByText('Lab Aegis resolves').count();
  await aegis.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Aegis', aegisBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Aegis')?.attachedTo)
    .toBe(birdId);

  // Destroy it: Lab Bird dies carrying one Aura you control, so one card is drawn.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(0);
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Hateful Eidolon: two of your Auras on a creature that dies draw you two cards', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Hateful Eidolon: two of your Auras on a creature that dies draw you two cards',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Bird')?.id).toBeTruthy();
  const birdId = boards.at(-1)!.find((p) => p.name === 'Lab Bird')!.id;
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(handCard(page, 'Lab Ox')).toHaveCount(0);

  // Enchant the opponent's Lab Bird with both of your Auras.
  for (const aura of ['Lab Aegis', 'Lab Mantle']) {
    const card = handCard(page, aura);
    await expect(card).toHaveClass(/actionable/, { timeout: 15_000 });
    const before = await page.getByText(`${aura} resolves`).count();
    await card.click();
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, 'Lab Bird').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await confirm(page);
    await awaitResolution(page, aura, before);
    await expect.poll(() => boards.at(-1)?.find((p) => p.name === aura)?.attachedTo).toBe(birdId);
  }

  // Destroy it: Lab Bird dies carrying two Auras you control, so two cards are drawn.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(0);
  await expect(permanent(page, 'Lab Mantle')).toHaveCount(0);
  await expect(handCard(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(handCard(page, 'Lab Ox')).toHaveCount(1);
  await expect(page.locator('.hand-card')).toHaveCount(2);
  // Lab Aegis, Lab Mantle and Lab Doom are in your graveyard.
  await expect(page.getByText('Graveyard (3)')).toBeVisible();
});

test('Hateful Eidolon: its combat damage gains life, Lab Ox’s does not', async ({ page }) => {
  await runScenario(page, 'Hateful Eidolon: its combat damage gains life, Lab Ox’s does not');
  await expect(permanent(page, 'Hateful Eidolon')).toContainText(/lifelink/i);
  await expect(permanent(page, 'Lab Ox')).not.toContainText(/lifelink/i);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');

  // Attack P2 with the lifelinker and P3 with the Ox.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Hateful Eidolon' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P3' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Only the Eidolon's 1 damage gains life: 41, not 45.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('39');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('36');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
});

test('Martial Impetus: the enchanted creature attacks and pumps your other attacker', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Martial Impetus: the enchanted creature attacks and pumps your other attacker',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Ox')).toContainText('4/4');

  // Cast the Aura on Lab Green Bear and let it resolve: a 3/3 that is goaded.
  const impetus = handCard(page, 'Martial Impetus');
  await expect(impetus).toHaveClass(/actionable/, { timeout: 15_000 });
  const impetusBefore = await page.getByText('Martial Impetus resolves').count();
  await impetus.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Martial Impetus', impetusBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Martial Impetus')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3');

  // Attack: the goaded Bear must attack and may not attack you; Lab Ox attacks P3.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P3' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The attack trigger pumps the other attacker, and unblocked damage is dealt.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('37');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('35');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
});

test('Martial Impetus: P2’s goaded creature cannot attack you, their other creature can', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Martial Impetus: P2’s goaded creature cannot attack you, their other creature can',
  );
  // P2's scripted seat attacks you with everything it may; the scenario then plays out on its own.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });

  // Your Aura stays on P2's Lab Green Bear (a 3/3).
  const final = boards.at(-1)!;
  const bear = final.find((p) => p.name === 'Lab Green Bear')!;
  expect(final.find((p) => p.name === 'Martial Impetus')?.attachedTo).toBe(bear.id);
  expect(final.find((p) => p.name === 'Martial Impetus')?.controller).toBe('P1');
  expect(bear.controller).toBe('P2');
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/3');

  // Only the unenchanted, unpumped Lab Ox attacked you (4): you are at 36, not 33. The goaded
  // Bear attacked someone else: P3 took 3 and P4 is untouched.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('37');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
});

test('Killian, Decisive Mentor: an enchantment taps and goads, then the enchanted attacker draws', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Killian, Decisive Mentor: an enchantment taps and goads, then the enchanted attacker draws',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Bird').locator('.tap-badge')).toHaveCount(0);

  // Cast the Aura on Lab Green Bear. Entering, it triggers Killian: up to one target creature.
  const aegis = handCard(page, 'Lab Aegis');
  await expect(aegis).toHaveClass(/actionable/, { timeout: 15_000 });
  const aegisBefore = await page.getByText('Lab Aegis resolves').count();
  await aegis.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Aegis', aegisBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Aegis')?.attachedTo)
    .toBe(bearId);
  await expect(page.getByRole('button', { name: 'Choose no more targets' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Target Lab Bird' }).click();

  // The trigger resolves: Lab Bird is tapped (the goad is asserted in the headless scenario).
  await expect(permanent(page, 'Lab Bird').locator('.tap-badge')).toHaveText('TAP', {
    timeout: 15_000,
  });

  // Attack P2 with the enchanted Lab Green Bear: Killian's attack trigger draws a card.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Lab Ox')).toHaveCount(1);
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('36');
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(1);
});

test('Killian, Decisive Mentor: P2’s goaded creature cannot attack you, their other creature can', async ({
  page,
}) => {
  await runScenario(
    page,
    'Killian, Decisive Mentor: P2’s goaded creature cannot attack you, their other creature can',
  );
  // P2's scripted seat attacks you with everything it may; the scenario then plays out on its own.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Killian, Decisive Mentor')).toHaveCount(1);

  // Only the ungoaded Lab Ox attacked you (4): you are at 36, not 34. The goaded Bear attacked
  // someone else: P3 took 2 and P4 is untouched.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
  await expect(page.locator('.opponent[data-seat="P3"]')).toContainText('38');
  await expect(page.locator('.opponent[data-seat="P4"]')).toContainText('40');
});

test('Angelic Destiny: a 6/6 flying Angel, then it dies and the Aura returns to your hand', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Angelic Destiny: a 6/6 flying Angel, then it dies and the Aura returns to your hand',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Cast the Aura on Lab Green Bear: it becomes a 6/6.
  const destiny = handCard(page, 'Angelic Destiny');
  await expect(destiny).toHaveClass(/actionable/, { timeout: 15_000 });
  const destinyBefore = await page.getByText('Angelic Destiny resolves').count();
  await destiny.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Angelic Destiny', destinyBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Angelic Destiny')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('6/6');

  // Destroy it: the Aura goes to the graveyard with it and returns to your hand.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(permanent(page, 'Angelic Destiny')).toHaveCount(0);
  await expect(handCard(page, 'Angelic Destiny')).toHaveCount(1);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Angelic Destiny: a 7/7 flying first-striking Angel attacks past Lab Ox and kills Lab Titan unharmed', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Angelic Destiny: a 7/7 flying first-striking Angel attacks past Lab Ox and kills Lab Titan unharmed',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');
  await expect(permanent(page, 'Lab Green Bear')).not.toContainText(/flying/i);

  // Cast the Aura on Lab Green Bear: 2/2 + 4/+4 + Lab Choir's +1/+1 for the Angel type = 7/7,
  // with flying and first strike.
  const destiny = handCard(page, 'Angelic Destiny');
  await expect(destiny).toHaveClass(/actionable/, { timeout: 15_000 });
  const destinyBefore = await page.getByText('Angelic Destiny resolves').count();
  await destiny.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Angelic Destiny', destinyBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Angelic Destiny')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('7/7');
  await expect(permanent(page, 'Lab Green Bear')).toContainText(/flying/i);
  await expect(permanent(page, 'Lab Green Bear')).toContainText(/first strike/i);

  // Attack P2. Only the flier Lab Titan can block it; Lab Ox has no flying or reach.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });

  // Only Lab Titan could block the flier, and first strike killed it before it hit back: the Bear
  // is undamaged, Lab Ox is untouched, and nothing reached P2.
  const final = boards.at(-1)!;
  expect(final.find((p) => p.id === bearId)?.damageMarked).toBe(0);
  expect(final.find((p) => p.name === 'Lab Ox')?.damageMarked).toBe(0);
  await expect(permanent(page, 'Lab Titan')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('7/7');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
});

test('Sheltered by Ghosts: exile an opposing permanent, then attack with lifelink', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Sheltered by Ghosts: exile an opposing permanent, then attack with lifelink',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Bird')).toHaveCount(1);

  // Cast the Aura on Lab Green Bear; it can only enchant a creature you control.
  const ghosts = handCard(page, 'Sheltered by Ghosts');
  await expect(ghosts).toHaveClass(/actionable/, { timeout: 15_000 });
  const ghostsBefore = await page.getByText('Sheltered by Ghosts resolves').count();
  await ghosts.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Sheltered by Ghosts', ghostsBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Sheltered by Ghosts')?.attachedTo)
    .toBe(bearId);

  // The enters trigger needs a target: choose the opposing Lab Bird.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0, { timeout: 15_000 });
  await expect(permanent(page, 'Lab Hex')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/2');

  // Attack P2: the 3/2 lifelinker hits for 3 and you gain 3.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('37');
  await expect(permanent(page, 'Sheltered by Ghosts')).toHaveCount(1);
});

test('Sheltered by Ghosts: ward {2} counters an opponent’s Lab Shock aimed at the creature', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Sheltered by Ghosts: ward {2} counters an opponent’s Lab Shock aimed at the creature',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Cast the Aura on Lab Green Bear and let it resolve. Nothing is left for its enters trigger
  // to exile, so no extra target prompt appears.
  const ghosts = handCard(page, 'Sheltered by Ghosts');
  await expect(ghosts).toHaveClass(/actionable/, { timeout: 15_000 });
  const ghostsBefore = await page.getByText('Sheltered by Ghosts resolves').count();
  await ghosts.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Sheltered by Ghosts', ghostsBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Sheltered by Ghosts')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/2');
  await expect(permanent(page, 'Lab Green Bear')).toContainText(/lifelink/i);

  // Pass with an empty stack: P2 casts Lab Shock at the enchanted Bear, which would be lethal.
  // Ward {2} triggers; P2's only untapped Mountain cannot pay, so Lab Shock is countered.
  await passUntil(page, page.getByText(/Lab Shock is countered by Lab Green Bear — ward—\{2\}/));
  await expect(page.getByText('Lab Green Bear — ward—{2} resolves')).toBeVisible();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('3/2');
  await expect(permanent(page, 'Sheltered by Ghosts')).toHaveCount(1);
  expect(boards.at(-1)!.find((p) => p.id === bearId)?.damageMarked).toBe(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
});

test('Eldrazi Conscription: a 12/12 trampler attacks and the defending player sacrifices two permanents', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Eldrazi Conscription: a 12/12 trampler attacks and the defending player sacrifices two permanents',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Bird')).toHaveCount(1);
  await expect(permanent(page, 'Lab Hex')).toHaveCount(1);

  // Cast the Aura on Lab Green Bear: it becomes a 12/12.
  const conscription = handCard(page, 'Eldrazi Conscription');
  await expect(conscription).toHaveClass(/actionable/, { timeout: 15_000 });
  const conscriptionBefore = await page.getByText('Eldrazi Conscription resolves').count();
  await conscription.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Eldrazi Conscription', conscriptionBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Eldrazi Conscription')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('12/12');

  // Attack P2: annihilator 2 makes the defending player sacrifice both of their permanents.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Hex')).toHaveCount(0);
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('28');
  await expect(permanent(page, 'Eldrazi Conscription')).toHaveCount(1);
});

test('Eldrazi Conscription: a blocked 12/12 trampler tramples over to the defending player', async ({
  page,
}) => {
  await runScenario(
    page,
    'Eldrazi Conscription: a blocked 12/12 trampler tramples over to the defending player',
  );
  // P2 casts the Aura on its Lab Green Bear and attacks you; let the Aura resolve.
  await awaitResolution(page, 'Eldrazi Conscription', 0);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('12/12');
  await expect(permanent(page, 'Lab Green Bear')).toContainText(/trample/i);

  // Annihilator 2: sacrifice two Forests, keeping Lab Ox to block. Each prompt lists Lab Ox first,
  // so the second "Sacrifice" button is a Forest (a missing block below would expose a mistake).
  const prompt = (position: string) =>
    page
      .getByRole('complementary')
      .filter({ hasText: `choose a permanent to sacrifice (${position})` });
  await expect(prompt('1 of 2').last()).toBeVisible({ timeout: 15_000 });
  await prompt('1 of 2').last().getByRole('button', { name: 'Sacrifice' }).nth(1).click();
  await expect(prompt('2 of 2').last()).toBeVisible({ timeout: 15_000 });
  await prompt('2 of 2').last().getByRole('button', { name: 'Sacrifice' }).nth(1).click();

  // Block the trampler with Lab Ox.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'Lab Green Bear' })
    .click();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();

  // P2 assigns lethal (4) to Lab Ox and tramples the other 8 over to you: 40 - 8 = 32.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.human-zone .life-badge, .seat[data-seat="P1"] .life-badge'),
  ).toHaveText('32');
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByText('Graveyard (3)')).toBeVisible();
  await expect(permanent(page, 'Lab Green Bear')).toBeVisible();
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('40');
});

test('Curse of Bounty: enchant a player, then attacking them untaps your nonland permanents', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Curse of Bounty: enchant a player, then attacking them untaps your nonland permanents',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Ox')?.id).toBeTruthy();
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');

  // Cast the Curse targeting P2: it enchants the player, not a permanent.
  const curse = handCard(page, 'Curse of Bounty');
  await expect(curse).toHaveClass(/actionable/, { timeout: 15_000 });
  const curseBefore = await page.getByText('Curse of Bounty resolves').count();
  await curse.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Curse of Bounty', curseBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Curse of Bounty')?.attachedTo)
    .toBe('P2');
  await expect(permanent(page, 'Forest').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');

  // Attack P2: the Curse untaps your nonland permanents, but not the lands.
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Green Bear' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);
  await expect(permanent(page, 'Lab Green Bear').locator('.tap-badge')).toHaveCount(0);
  await expect(permanent(page, 'Forest').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('38');
  await expect(permanent(page, 'Curse of Bounty')).toHaveCount(1);
});

test('Curse of Bounty: an opponent attacking the enchanted player untaps their nonland permanents', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Curse of Bounty: an opponent attacking the enchanted player untaps their nonland permanents',
  );
  // P3 attacks P2, the player your Curse enchants; the scenario then plays out on its own.
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });

  // Before the attack, everything that matters was tapped except P3's Lab Green Bear.
  const tappedBefore = (name: string) =>
    boards.some((board) => board.find((p) => p.name === name)?.tapped === true);
  for (const name of ['Lab Ox', 'Forest', 'Lab Servo', 'Lab Thrull', 'Plains', 'Lab Bird', 'Swamp'])
    expect(tappedBefore(name), `${name} started tapped`).toBe(true);

  // The attacking opponent untapped their nonland permanents, the attacker included.
  for (const name of ['Lab Green Bear', 'Lab Thrull', 'Lab Ox'])
    await expect(permanent(page, name)).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear').locator('.tap-badge')).toHaveCount(0);
  await expect(permanent(page, 'Lab Thrull').locator('.tap-badge')).toHaveCount(0);
  // The Curse's controller untapped its own nonland permanent.
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);
  // Lands stay tapped, and the enchanted player and the bystander untapped nothing.
  for (const name of ['Forest', 'Plains', 'Lab Servo', 'Lab Bird', 'Swamp'])
    await expect(permanent(page, name).locator('.tap-badge'), name).toHaveText('TAP');
  await expect(page.locator('.opponent[data-seat="P2"]')).toContainText('38');
  await expect(permanent(page, 'Curse of Bounty')).toHaveCount(1);
});

test('Eidolon of Countless Battles: bestow onto a creature, then it becomes a creature again', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Eidolon of Countless Battles: bestow onto a creature, then it becomes a creature again',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Cast the Eidolon with its bestow cost: it is an Aura spell that targets Lab Green Bear.
  const eidolon = handCard(page, 'Eidolon of Countless Battles');
  await expect(eidolon).toHaveClass(/actionable/, { timeout: 15_000 });
  await eidolon.click();
  const actions = page.locator('.source-actions .source-action-row button');
  await expect(actions).toHaveCount(2);
  await actions.filter({ hasText: /bestow/i }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Eidolon of Countless Battles'));
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Eidolon of Countless Battles')?.attachedTo)
    .toBe(bearId);
  // +1/+1 for the one creature and +1/+1 for the one Aura you control.
  await expect(permanent(page, 'Lab Green Bear')).toContainText('4/4');

  // Destroy the Bear: the Eidolon stays on the battlefield as a creature again.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Green Bear')).toHaveCount(0);
  await expect(permanent(page, 'Eidolon of Countless Battles')).toHaveCount(1);
  await expect(permanent(page, 'Eidolon of Countless Battles')).toContainText('1/1');
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Eidolon of Countless Battles')?.attachedTo)
    .toBeFalsy();
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

test('Eidolon of Countless Battles: the host grows by one per creature and one per Aura you control', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Eidolon of Countless Battles: the host grows by one per creature and one per Aura you control',
  );
  await expect.poll(() => boards.at(-1)?.find((p) => p.name === 'Lab Green Bear')?.id).toBeTruthy();
  const bearId = boards.at(-1)!.find((p) => p.name === 'Lab Green Bear')!.id;
  await expect(permanent(page, 'Lab Green Bear')).toContainText('2/2');

  // Bestow onto Lab Green Bear: one creature and one Aura you control, so +2/+2. P2's Lab Ox
  // adds nothing.
  const eidolon = handCard(page, 'Eidolon of Countless Battles');
  await expect(eidolon).toHaveClass(/actionable/, { timeout: 15_000 });
  const eidolonBefore = await page.getByText('Eidolon of Countless Battles resolves').count();
  await eidolon.click();
  await page
    .locator('.source-actions .source-action-row button')
    .filter({ hasText: /bestow/i })
    .click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Green Bear').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Eidolon of Countless Battles', eidolonBefore);
  await expect
    .poll(() => boards.at(-1)?.find((p) => p.name === 'Eidolon of Countless Battles')?.attachedTo)
    .toBe(bearId);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('4/4');

  // A second creature only: +1/+1 more.
  const bird = handCard(page, 'Lab Bird');
  await expect(bird).toHaveClass(/actionable/, { timeout: 15_000 });
  const birdBefore = await page.getByText('Lab Bird resolves').count();
  await bird.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Bird', birdBefore);
  await expect(permanent(page, 'Lab Bird')).toHaveCount(1);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('5/5');

  // A second Aura only (on Lab Bird, so the creature count is unchanged): +1/+1 more.
  const aegis = handCard(page, 'Lab Aegis');
  await expect(aegis).toHaveClass(/actionable/, { timeout: 15_000 });
  const aegisBefore = await page.getByText('Lab Aegis resolves').count();
  await aegis.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Lab Aegis', aegisBefore);
  await expect(permanent(page, 'Lab Bird')).toContainText('3/3');
  await expect(permanent(page, 'Lab Green Bear')).toContainText('6/6');

  // Destroy Lab Bird: the creature and its Aura go together, so the Bear drops back to 4/4.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Bird').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Aegis')).toHaveCount(0);
  await expect(permanent(page, 'Lab Green Bear')).toContainText('4/4');
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  expect(boards.at(-1)?.find((p) => p.name === 'Eidolon of Countless Battles')?.attachedTo).toBe(
    bearId,
  );
  await expect(page.getByText('Graveyard (3)')).toBeVisible();
});

test('Animate Dead: return an opponent’s creature, then it dies and the Aura goes with it', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Animate Dead: return an opponent’s creature, then it dies and the Aura goes with it',
  );
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);

  // Cast Animate Dead on Lab Ox in P2's graveyard: the Aura's only legal targets are cards there.
  const animate = handCard(page, 'Animate Dead');
  await expect(animate).toHaveClass(/actionable/, { timeout: 15_000 });
  await animate.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page
    .locator('.zone-card-thumb.targetable')
    .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
    .click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Lab Ox'));
  // The creature returns under your control with the Aura attached, as a 3/4.
  await expect(permanent(page, 'Lab Ox')).toContainText('3/4');
  await expect
    .poll(() => {
      const board = boards.at(-1);
      const ox = board?.find((p) => p.name === 'Lab Ox');
      return ox === undefined
        ? undefined
        : board?.find((p) => p.name === 'Animate Dead')?.attachedTo === ox.id;
    })
    .toBe(true);

  // Destroy it: the Aura is put into the graveyard with it.
  const doom = handCard(page, 'Lab Doom');
  await expect(doom).toHaveClass(/actionable/, { timeout: 15_000 });
  await doom.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Animate Dead')).toHaveCount(0);
  await expect(page.getByText('Graveyard (2)')).toBeVisible();
});

// Coverage PR06 (docs/plans/card-coverage-chunks.md).

test('Dragon Tempest: the entering Dragon deals the damage', async ({ page }) => {
  await runScenario(page, 'Dragon Tempest: the entering Dragon deals the damage');
  const spell = handCard(page, 'Lab Skydrake');
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // Both Tempest triggers fire as the Dragon enters: put the haste trigger on the stack first.
  const haste = page.getByRole('button', { name: /Flying ETB haste/ });
  await passUntil(page, haste);
  await haste.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  // The Dragon deals the damage (not the enchantment), so its lifelink gains you the life.
  await expect(page.getByText(/Lab Skydrake deals 1 to P2/).first()).toBeVisible();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');
  await expect(permanent(page, 'Lab Skydrake')).toContainText(/haste/i);
});

test('Scourge of Valkas: it and another Dragon each deal X damage as they enter', async ({
  page,
}) => {
  await runScenario(
    page,
    'Scourge of Valkas: it and another Dragon each deal X damage as they enter',
  );
  const castDragon = async (name: string) => {
    const spell = handCard(page, name);
    await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
    await spell.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
    // Pass until the Dragon has entered and its trigger asks for a target.
    await passUntil(page, page.getByText(/Target 1 of 1/));
    await page.locator('.opponent[data-seat="P2"] > header').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
    await confirm(page);
  };

  // Scourge enters alone: it is the source and you control one Dragon, so X is 1.
  await castDragon('Scourge of Valkas');
  await passStackUntil(page, page.getByText(/Scourge of Valkas deals 1 to P2/).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');

  // Another Dragon enters: Scourge's trigger fires, the Skydrake is the source and X is 2.
  await castDragon('Lab Skydrake');
  await passStackUntil(page, page.getByText(/Lab Skydrake deals 2 to P2/).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('37');
  // The Dragon that entered dealt the damage, so its lifelink gained you the life.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('42');

  // The seventh Mountain pays for the {R} pump: Scourge is a 5/4 flier until end of turn.
  await activate(page, 'Scourge of Valkas', /\{R\}: ~ gets \+1\/\+0/);
  await passUntil(page, permanent(page, 'Scourge of Valkas').getByText('5/4'));
  await expect(permanent(page, 'Scourge of Valkas')).toContainText(/flying/i);
});

test("Tyrant's Familiar: lieutenant attack hits a creature of the player it attacks", async ({
  page,
}) => {
  await runScenario(
    page,
    "Tyrant's Familiar: lieutenant attack hits a creature of the player it attacks",
  );
  // With your commander out the Familiar is a 7/7 flier.
  await expect(permanent(page, "Tyrant's Familiar").getByText('7/7')).toBeVisible();
  await expect(permanent(page, "Tyrant's Familiar")).toContainText(/flying/i);

  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: "Tyrant's Familiar" })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The granted attack trigger: only creatures P2 controls can be chosen.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Servo')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Bird')).not.toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab General')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Servo')).toBeVisible();
  await expect(permanent(page, 'Lab Bird')).toBeVisible();
  await expect(page.getByText(/Tyrant's Familiar.* deals 7 to Lab Ox/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('33');
});

test('Brash Taunter: fight Lab Ox, then reflect the damage at P3', async ({ page }) => {
  await runScenario(page, 'Brash Taunter: fight Lab Ox, then reflect the damage at P3');
  const taunter = permanent(page, 'Brash Taunter');
  await expect(taunter).toHaveClass(/actionable/, { timeout: 15_000 });
  await taunter.click();
  // A source with one legal action goes straight to its targets; several open the action menu.
  const fightAction = page.getByRole('button', { name: /fights another target creature/ });
  if (await fightAction.isVisible()) await fightAction.click();
  // "Another" target creature: the Taunter itself is not offered, any other creature is.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Servo')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Brash Taunter')).not.toHaveClass(/targetable/);
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // Lab Ox deals 4 to the Taunter, which triggers its reflection: choose P3.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent[data-seat="P3"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Brash Taunter')).toBeVisible();
  await expect(page.getByText(/Brash Taunter.* deals 4 to P3/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('40');
});

test('Tomb Blade: the damaged player sacrifices a creature or loses life', async ({ page }) => {
  await runScenario(page, 'Tomb Blade: the damaged player sacrifices a creature or loses life');
  // Unearth the second Tomb Blade from the graveyard: it returns with haste.
  const graveBlade = page
    .locator('.zones-strip .zone', { hasText: 'Graveyard' })
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name: 'Tomb Blade', exact: true }) });
  await expect(graveBlade).toHaveClass(/actionable/, { timeout: 15_000 });
  await graveBlade.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Tomb Blade').nth(1));
  await expect(permanent(page, 'Tomb Blade')).toHaveCount(2);

  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  const rows = page.locator('.combat-assignment-row').filter({ hasText: 'Tomb Blade' });
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByRole('button', { name: 'P2' }).click();
  await rows.nth(1).getByRole('button', { name: 'P3' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Both triggers fire at once: put either on the stack first. The damaged players answer
  // (P2 loses the life, P3 sacrifices Lab Servo) without involving the attacker.
  const order = page.getByRole('button', {
    name: /Tomb Blade: Whenever this creature deals combat damage/,
  });
  await passUntil(page, order.first().or(page.getByText(/game over/i).first()));
  if (await order.first().isVisible()) await order.first().click();
  await passUntil(page, page.getByText(/game over/i).first());

  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('32');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('35');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P4' }).locator('.life-badge'),
  ).toHaveText('40');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  // P2 kept all three creatures; P3 sacrificed Lab Servo and kept Lab Ox.
  await expect(permanent(page, 'Lab Bird')).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(2);
});

test("Duelist's Heritage: one trigger per attack, double strike for the attacker you pick", async ({
  page,
}) => {
  await runScenario(
    page,
    "Duelist's Heritage: one trigger per attack, double strike for the attacker you pick",
  );
  const mine = (name: string) =>
    page
      .locator('.human-zone .object')
      .filter({ has: page.getByRole('img', { name, exact: true }) });
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  for (const attacker of ['Lab Ox', 'Lab Servo']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: attacker })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // One trigger for the whole attack: only the two attackers can be chosen.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await expect(mine('Lab Ox')).toHaveClass(/targetable/);
  await expect(mine('Lab Servo')).toHaveClass(/targetable/);
  await expect(permanent(page, 'Lab Bird')).not.toHaveClass(/targetable/);
  await mine('Lab Servo').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // "You may": say yes.
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  await passUntil(page, yes);
  await yes.click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(mine('Lab Servo')).toContainText(/double strike/i);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('34');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('40');
});

test('Thunderbreak Regent: the opponent who targets your Dragon takes 3', async ({ page }) => {
  await runScenario(page, 'Thunderbreak Regent: the opponent who targets your Dragon takes 3');
  await expect(permanent(page, 'Thunderbreak Regent')).toContainText(/flying/i);
  // Take the land drop so passing is not interrupted by the land reminder.
  await page.getByRole('button', { name: 'Play Forest', exact: true }).click();
  // P2 casts Lab Doom on the Regent when you pass; the Regent's trigger resolves above it.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Thunderbreak Regent.* deals 3 to P2/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('37');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('40');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  // Lab Doom then destroys the Regent.
  await expect(permanent(page, 'Thunderbreak Regent')).toHaveCount(0);
});

test('Invisible Woman: pay {R}{G}{W}{U} when you attack, then pump and evade', async ({ page }) => {
  await runScenario(page, 'Invisible Woman: pay {R}{G}{W}{U} when you attack, then pump and evade');
  // A noncreature spell this turn earns the Wall at the beginning of combat.
  const trinket = handCard(page, 'Lab Free Trinket');
  await expect(trinket).toHaveClass(/actionable/, { timeout: 15_000 });
  await trinket.click();
  // Nothing to pay: confirming puts the spell on the stack.
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Lab Free Trinket'));
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await expect(permanent(page, 'Wall')).toBeVisible();
  await expect(permanent(page, 'Wall').getByText('0/3')).toBeVisible();

  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The payment is asked first; only paying creates the reflexive trigger and its target prompt.
  const pay = page.getByRole('button', { name: /^Pay \{/ });
  await expect(pay).toBeVisible({ timeout: 15_000 });
  await pay.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  // Four creatures (the Wall included): +4/+0, and the unblockable Ox's 8 damage all lands.
  await expect(permanent(page, 'Lab Ox').getByText('8/4')).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('32');
});

test('Flameblast Dragon: choose the target, then pay {X}{R} for X damage', async ({ page }) => {
  await runScenario(page, 'Flameblast Dragon: choose the target, then pay {X}{R} for X damage');
  await expect(permanent(page, 'Flameblast Dragon')).toContainText(/flying/i);
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Flameblast Dragon' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The target comes first, while the trigger goes on the stack; no mana has been spent yet.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.opponent').filter({ hasText: 'P3' }).locator('header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  // The payment is asked as the trigger resolves, declining and paying X=0 being separate choices.
  const pay = page.getByRole('button', { name: /^Pay X=3 / });
  await passUntil(page, pay);
  await expect(page.getByRole('button', { name: "Don't pay" })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pay X=0 / })).toBeVisible();
  await pay.click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Flameblast Dragon.* deals 3 to P3/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('37');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('35');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P4' }).locator('.life-badge'),
  ).toHaveText('40');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test('Territorial Aetherkite: pay energy and damage each other creature', async ({ page }) => {
  await runScenario(page, 'Territorial Aetherkite: pay energy and damage each other creature');
  const kite = handCard(page, 'Territorial Aetherkite');
  await expect(kite).toHaveClass(/actionable/, { timeout: 15_000 });
  await kite.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The enter trigger gives {E}{E}; the payment is then offered, up to the energy you have.
  // Amounts are listed as rows, each with its own Pay button; declining is a separate button.
  const row = (amount: number) => page.getByText(`Pay ${amount} energy`, { exact: true });
  await passUntil(page, row(2));
  await expect(row(1)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay no energy', exact: true })).toBeVisible();
  const pay = row(2).locator(
    'xpath=ancestor::div[contains(@class,"group-value")]/following-sibling::div[contains(@class,"group-actions")]//button',
  );
  await pay.click();

  // "When you do" is its own trigger: it resolves as a separate object after the enter trigger.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.getByText(
      'Territorial Aetherkite — When you do, this creature deals that much damage to each other creature resolves',
    ),
  ).toBeVisible();
  // Both Lab Servos and Lab Bird (1/1) died; the Aetherkite and Lab Ox (4/4) survived.
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Territorial Aetherkite')).toBeVisible();
  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test('Arcbond: the chosen creature reflects the damage it is dealt', async ({ page }) => {
  await runScenario(page, 'Arcbond: the chosen creature reflects the damage it is dealt');
  const arcbond = handCard(page, 'Arcbond');
  await expect(arcbond).toHaveClass(/actionable/, { timeout: 15_000 });
  await arcbond.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Arcbond', 0);

  // Arcbond has resolved: damage dealt to Lab Ox now is reflected by Lab Ox.
  const shock = handCard(page, 'Lab Shock');
  await expect(shock).toHaveClass(/actionable/, { timeout: 15_000 });
  await shock.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird')).toHaveCount(0);
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('38');
  }
  await expect(page.locator('.human-zone .life-badge')).toHaveText('38');
});

test('Thundermaw Hellkite: damage and tap the fliers your opponents control', async ({ page }) => {
  await runScenario(page, 'Thundermaw Hellkite: damage and tap the fliers your opponents control');
  const kite = handCard(page, 'Thundermaw Hellkite');
  await expect(kite).toHaveClass(/actionable/, { timeout: 15_000 });
  await kite.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Thundermaw Hellkite')).toContainText(/flying/i);
  // Every opposing flier is tapped, protection from red included; the ground creature and your
  // own flier are not.
  await expect(permanent(page, 'Lab Sturdy Flier')).toHaveCount(2);
  for (const flier of await permanent(page, 'Lab Sturdy Flier').all())
    await expect(flier.locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Red Guard').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird').locator('.tap-badge')).toHaveCount(0);
  // The Red Guard's protection stopped the damage; the other fliers took 1 each.
  await expect(
    page.getByText(/Thundermaw Hellkite.* deals 1 to Lab Sturdy Flier/).first(),
  ).toBeVisible();
});

test('Backlash: tap an untapped creature and it hits its controller', async ({ page }) => {
  await runScenario(page, 'Backlash: tap an untapped creature and it hits its controller');
  const backlash = handCard(page, 'Backlash');
  await expect(backlash).toHaveClass(/actionable/, { timeout: 15_000 });
  await backlash.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  // Both creatures are untapped, so both are on offer; choose P2's Lab Ox.
  await expect(permanent(page, 'Lab Servo')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Servo').locator('.tap-badge')).toHaveCount(0);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('36');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test('Guard Gomazoa: blocks Lab Ox and takes no combat damage', async ({ page }) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(page, 'Guard Gomazoa: blocks Lab Ox and takes no combat damage');
  await expect(permanent(page, 'Guard Gomazoa')).toContainText(/flying/i, { timeout: 15_000 });
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Guard Gomazoa')).toHaveCount(1);
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  const final = boards.at(-1)!;
  expect(final.find((p) => p.name === 'Guard Gomazoa')?.damageMarked).toBe(0);
  expect(final.find((p) => p.name === 'Lab Ox')?.damageMarked).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('40');
});

test('Selfless Squire: prevent the damage to you and grow by that much', async ({ page }) => {
  await runScenario(page, 'Selfless Squire: prevent the damage to you and grow by that much');
  const squire = handCard(page, 'Selfless Squire');
  await expect(squire).toHaveClass(/actionable/, { timeout: 15_000 });
  await squire.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The enter trigger resolves, then P2's Lab Shock at you is prevented and the Squire grows.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Selfless Squire')).toContainText('3/3');
  await expect(page.getByText(/Lab Shock.* prevented/i).first()).toBeVisible();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test("Deflecting Palm: prevent a chosen creature's damage and reflect it", async ({ page }) => {
  await runScenario(page, "Deflecting Palm: prevent a chosen creature's damage and reflect it");
  const palm = handCard(page, 'Deflecting Palm');
  await expect(palm).toHaveClass(/actionable/, { timeout: 15_000 });
  await palm.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // The source is chosen as Deflecting Palm resolves: every permanent is on offer.
  const choosing = page.getByText(/choose a source of damage/i).first();
  await passStackUntil(page, choosing);
  await expect(page.locator('.panel-group').filter({ hasText: 'Lab Servo' })).toHaveCount(1);
  await page
    .locator('.panel-group')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'Choose' })
    .click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Deflecting Palm.* deals 4 to P2/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('36');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
});

test('Comeuppance: prevent the damage and deal it back to the creature and the controller', async ({
  page,
}) => {
  await runScenario(
    page,
    'Comeuppance: prevent the damage and deal it back to the creature and the controller',
  );
  const comeuppance = handCard(page, 'Comeuppance');
  await expect(comeuppance).toHaveClass(/actionable/, { timeout: 15_000 });
  await comeuppance.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  // P2's Lab Shock and Lab Ox's attack are both prevented; each reflection goes to its own target.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Comeuppance.* deals 2 to P2/).first()).toBeVisible();
  await expect(page.getByText(/Comeuppance.* deals 4 to Lab Ox/).first()).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('38');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
});

test('Michiko Konda: each opposing source that damages you makes its controller sacrifice', async ({
  page,
}) => {
  await runScenario(
    page,
    'Michiko Konda: each opposing source that damages you makes its controller sacrifice',
  );
  // P2 casts Lab Shock at you and attacks with Lab Ox; decline to block with Michiko Konda.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('34');
  await expect(page.getByText(/Michiko Konda.* sacrifice/i).first()).toBeVisible();
  await expect(page.locator('.opponent[data-seat="P2"]').locator('.life-badge')).toHaveText('40');
  for (const seat of ['P3', 'P4']) {
    await expect(page.locator(`.opponent[data-seat="${seat}"]`).locator('.life-badge')).toHaveText(
      '40',
    );
  }
  await expect(permanent(page, 'Lab Ox')).toHaveCount(1);
  await expect(permanent(page, 'Forest')).toHaveCount(0);
});

test("Delirium: during an opponent's attack, tap its creature, hit it back and stop its combat damage", async ({
  page,
}) => {
  await runScenario(
    page,
    "Delirium: during an opponent's attack, tap its creature, hit it back and stop its combat damage",
  );
  // Wait for the declare attackers step of P2's turn, then cast Delirium on the attacking Lab Ox.
  await passUntil(page, page.getByText(/Combat · Declare attackers/).first());
  const delirium = handCard(page, 'Delirium');
  await expect(delirium).toHaveClass(/actionable/, { timeout: 15_000 });
  await delirium.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  // Only the creatures of the player whose turn it is are on offer, and both are.
  await expect(permanent(page, 'Lab Ox')).toHaveClass(/targetable/);
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  // Auto-pay is previewed in the same tray as the target, so one Confirm casts it.
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Lab Ox.* deals 4 to P2/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('36');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
});

test('Planeswalker attack: Lab Ox attacks Lab Walker through the player board and its loyalty drops', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  await runScenario(
    page,
    'Attacking a planeswalker: unblocked combat damage removes loyalty, not life',
  );
  await expect(permanent(page, 'Lab Walker')).toContainText('loyalty×5', { timeout: 15_000 });
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  // The planeswalker is offered by name, next to the opponents, and chosen instead of P2.
  const row = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Ox' });
  await expect(row.getByRole('button', { name: 'Lab Walker' })).toBeVisible();
  await row.getByRole('button', { name: 'Lab Walker' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Walker')).toContainText('loyalty×1');
  const final = boards.at(-1)!;
  expect(final.find((p) => p.name === 'Lab Walker')?.counters['loyalty']).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('40');
});

/** The latest library size of `seat` in the live snapshots, and its first. */
function trackLibrary(page: Page, seat: string): { first: () => number; last: () => number } {
  const sizes: number[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type !== 'playerStateSnapshot' && frame.type !== 'stateSnapshot') return;
      const size = frame.payload.state.seats.find((s) => s.seat === seat)?.librarySize;
      if (size !== undefined) sizes.push(size);
    }),
  );
  return { first: () => sizes[0]!, last: () => sizes.at(-1)! };
}

test('Firemane Commando: attacking with two creatures draws you a card', async ({ page }) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(page, 'Firemane Commando: attacking with two creatures draws you a card');
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  for (const name of ['Lab Ox', 'Lab Servo']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('35');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('40');
  }
});

test('Firemane Commando: another player attacking someone else draws a card', async ({ page }) => {
  const library = trackLibrary(page, 'P2');
  await runScenario(page, 'Firemane Commando: another player attacking someone else draws a card');
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('35');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test('Firemane Commando: another player who attacked you draws nothing', async ({ page }) => {
  const library = trackLibrary(page, 'P2');
  await runScenario(page, 'Firemane Commando: another player who attacked you draws nothing');
  // P2 attacks you with both creatures; decline to block with Firemane Commando.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('35');
  await expect(
    page.getByText(/Firemane Commando — Whenever another player attacks.* resolves/i).first(),
  ).toBeVisible();
});

test('Breena: attacking the opponent with the most life draws you a card and grows a creature', async ({
  page,
}) => {
  const boards: SpectatorPermanent[][] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
        boards.push(frame.payload.state.battlefield);
    }),
  );
  const library = trackLibrary(page, 'P1');
  await runScenario(
    page,
    'Breena: attacking the opponent with the most life draws you a card and grows a creature',
  );
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  const row = page.locator('.combat-assignment-row').filter({ hasText: 'Lab Ox' });
  await row.getByRole('button', { name: 'P2' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // Breena's ability resolves: choose Lab Ox for the counters.
  await expect(page.getByText(/choose a creature you control/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .locator('div')
    .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Choose' }) })
    .last()
    .getByRole('button', { name: 'Choose' })
    .click();

  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(permanent(page, 'Lab Ox')).toContainText('6/6');
  expect(boards.at(-1)!.find((p) => p.name === 'Lab Ox')?.counters['+1/+1']).toBe(2);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('34');
  for (const seat of ['P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('30');
  }
});

test('Ever-Watching Threshold: an opponent attacking you draws you a card', async ({ page }) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(page, 'Ever-Watching Threshold: an opponent attacking you draws you a card');
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
});

test('Ever-Watching Threshold: an opponent attacking your planeswalker draws you a card', async ({
  page,
}) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(
    page,
    'Ever-Watching Threshold: an opponent attacking your planeswalker draws you a card',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(permanent(page, 'Lab Walker')).toContainText('loyalty×1');
});

test('Ever-Watching Threshold: an opponent attacking someone else draws nothing', async ({
  page,
}) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(
    page,
    'Ever-Watching Threshold: an opponent attacking someone else draws nothing',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Mangara: an opponent attacking you with two creatures draws you a card', async ({ page }) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(page, 'Mangara: an opponent attacking you with two creatures draws you a card');
  // P2 attacks you with both creatures; decline to block with Mangara.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('35');
});

test('Mangara: an opponent attacking you with one creature draws nothing', async ({ page }) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(page, 'Mangara: an opponent attacking you with one creature draws nothing');
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
});

test('Tomik: affinity for planeswalkers makes it cost {W}{B} with one planeswalker', async ({
  page,
}) => {
  await runScenario(
    page,
    'Tomik: affinity for planeswalkers makes it cost {W}{B} with one planeswalker',
  );
  const tomik = handCard(page, 'Tomik, Wielder of Law');
  await expect(tomik).toHaveClass(/actionable/, { timeout: 15_000 });
  const before = await page.getByText('Tomik, Wielder of Law resolves').count();
  await tomik.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await awaitResolution(page, 'Tomik, Wielder of Law', before);
  await expect(permanent(page, 'Tomik, Wielder of Law')).toHaveCount(1);
  await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Swamp').locator('.tap-badge')).toHaveText('TAP');
});

test('Tomik: an opponent attacking you with two creatures loses 3 life and you draw', async ({
  page,
}) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(
    page,
    'Tomik: an opponent attacking you with two creatures loses 3 life and you draw',
  );
  // P2 attacks you with both creatures; decline to block with Tomik.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('37');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('35');
});

test('Frontier Warmonger: the creatures attacking an opponent gain menace', async ({ page }) => {
  await runScenario(page, 'Frontier Warmonger: the creatures attacking an opponent gain menace');
  await expect(permanent(page, 'Lab Ox')).not.toContainText(/menace/i);
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/gain menace until end of turn.* resolves/i).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Tenuous Truce: at the enchanted opponent’s end step you and they each draw', async ({
  page,
}) => {
  const mine = trackLibrary(page, 'P1');
  const theirs = trackLibrary(page, 'P2');
  await runScenario(
    page,
    'Tenuous Truce: at the enchanted opponent’s end step you and they each draw',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  expect(mine.first() - mine.last()).toBe(1);
  expect(theirs.first() - theirs.last()).toBe(1);
  await expect(permanent(page, 'Tenuous Truce')).toHaveCount(1);
});

test('Tenuous Truce: attacking the enchanted opponent sacrifices the Aura', async ({ page }) => {
  await runScenario(page, 'Tenuous Truce: attacking the enchanted opponent sacrifices the Aura');
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Tenuous Truce')).toHaveCount(0);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Tenuous Truce: the enchanted opponent attacking you sacrifices the Aura', async ({
  page,
}) => {
  await runScenario(
    page,
    'Tenuous Truce: the enchanted opponent attacking you sacrifices the Aura',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Tenuous Truce')).toHaveCount(0);
  await expect(page.locator('.human-zone .life-badge')).toHaveText('36');
});

test('Wall of Tears: the creature it blocks returns to its owner’s hand at end of combat', async ({
  page,
}) => {
  await runScenario(
    page,
    'Wall of Tears: the creature it blocks returns to its owner’s hand at end of combat',
  );
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Servo' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.getByText(/Wall of Tears — Whenever this creature blocks.* resolves/i).first(),
  ).toBeVisible();
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Wall of Tears')).toHaveCount(1);
});

test('Human Torch: a noncreature spell grants flying, double strike and haste, and paying copies its damage', async ({
  page,
}) => {
  await runScenario(
    page,
    'Human Torch: a noncreature spell grants flying, double strike and haste, and paying copies its damage',
  );
  const trinket = handCard(page, 'Lab Free Trinket');
  await expect(trinket).toHaveClass(/actionable/, { timeout: 15_000 });
  await trinket.click();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Lab Free Trinket'));
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  // The beginning of combat trigger has resolved: Human Torch has the three keywords.
  await expect(permanent(page, 'Human Torch')).toContainText(/double strike/i);
  await expect(permanent(page, 'Human Torch')).toContainText(/flying/i);

  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Human Torch' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  const pay = page.getByRole('button', { name: /^Pay \{/ });
  await expect(pay).toBeVisible({ timeout: 15_000 });
  await pay.click();

  await passUntil(page, page.getByText(/game over/i).first());
  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('34');
  }
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

// Coverage PR07 (docs/plans/card-coverage-chunks.md).

test('Promise of Loyalty: a vowed creature cannot attack its caster but can attack others', async ({
  page,
}) => {
  await runScenario(
    page,
    'Promise of Loyalty: a vowed creature cannot attack its caster but can attack others',
  );
  const spell = handCard(page, 'Promise of Loyalty');
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Keep Lab Ox: every player chooses in turn order, then the vow counters are put on.
  await passStackUntil(
    page,
    page.getByText('Choose a creature to keep and put a vow counter on.', { exact: true }),
  );
  await page
    .locator('.panel-group')
    .filter({ has: page.getByRole('img', { name: 'Lab Ox', exact: true }) })
    .getByRole('button', { name: 'Keep', exact: true })
    .click();

  // P2's vowed Lab Ox may not attack you, so it attacks P3.
  await passUntil(page, page.getByText(/game over/i).first());
  for (const seat of ['P1', 'P2']) {
    const kept =
      seat === 'P1' ? page.locator('.human-zone') : page.locator(`.opponent[data-seat="${seat}"]`);
    await expect(kept.getByRole('img', { name: 'Lab Ox', exact: true })).toBeVisible();
    await expect(kept.locator('.counters').filter({ hasText: /vow/i })).toBeVisible();
    await expect(
      kept
        .locator('.object')
        .filter({ has: page.getByRole('img', { name: 'Lab Servo', exact: true }) }),
    ).toHaveCount(0);
  }
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Lightning Runner: paying eight energy untaps your creatures and adds a combat phase', async ({
  page,
}) => {
  await runScenario(
    page,
    'Lightning Runner: paying eight energy untaps your creatures and adds a combat phase',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lightning Runner' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The trigger gives {E}{E}, taking you to eight, and offers the payment.
  const pay = page.getByRole('button', { name: 'Pay', exact: true });
  await passUntil(page, pay);
  await pay.click();

  // Lab Ox untapped and the additional combat phase offers a second declaration.
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  for (const name of ['Lightning Runner', 'Lab Ox'])
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('28');
});

test('Firkraag: attacking an opponent with a Dragon goads one of that opponent’s creatures', async ({
  page,
}) => {
  await runScenario(
    page,
    'Firkraag: attacking an opponent with a Dragon goads one of that opponent’s creatures',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Firkraag' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();

  // The trigger targets a creature the attacked player controls; goad Lab Ox.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/goad/i).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('37');
});

test('Firkraag: a goaded creature that deals combat damage to an opponent grows Firkraag and draws a card', async ({
  page,
}) => {
  const library = trackLibrary(page, 'P1');
  await runScenario(
    page,
    'Firkraag: a goaded creature that deals combat damage to an opponent grows Firkraag and draws a card',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  expect(library.first() - library.last()).toBe(1);
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(permanent(page, 'Firkraag, Cunning Instigator')).toContainText('4/4');
});

test('Eriette of the Charmed Apple: a creature enchanted by your Aura cannot attack you', async ({
  page,
}) => {
  await runScenario(
    page,
    'Eriette of the Charmed Apple: a creature enchanted by your Aura cannot attack you',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('34');
});

test('Eriette of the Charmed Apple: at your end step each opponent loses X life and you gain X', async ({
  page,
}) => {
  await runScenario(
    page,
    'Eriette of the Charmed Apple: at your end step each opponent loses X life and you gain X',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
  for (const seat of ['P2', 'P3', 'P4']) {
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('38');
  }
});

test('Rite of the Raging Storm: a creature named Lightning Rager cannot attack you', async ({
  page,
}) => {
  await runScenario(
    page,
    'Rite of the Raging Storm: a creature named Lightning Rager cannot attack you',
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('34');
});

test("Rite of the Raging Storm: each player's upkeep makes them a Lightning Rager that is sacrificed at the end step", async ({
  page,
}) => {
  await runScenario(
    page,
    "Rite of the Raging Storm: each player's upkeep makes them a Lightning Rager that is sacrificed at the end step",
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Lightning Rager/).first()).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('35');
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  // Sacrificed at the end step: no Lightning Rager is left on the battlefield.
  await expect(permanent(page, 'Lightning Rager')).toHaveCount(0);
});

test('Nils, Discipline Enforcer: at your end step put a +1/+1 counter on up to one creature for each player', async ({
  page,
}) => {
  await runScenario(
    page,
    'Nils, Discipline Enforcer: at your end step put a +1/+1 counter on up to one creature for each player',
  );
  // One prompt for each player in turn order: you first, then P2.
  const prompt = (seat: string) =>
    page.getByText(new RegExp(`choose a target controlled by ${seat}`)).first();
  await passUntil(page, prompt('P1'));
  await page.getByRole('button', { name: 'Target Lab Servo' }).click();
  await passUntil(page, prompt('P2'));
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();

  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Servo')).toContainText('2/2');
  await expect(permanent(page, 'Lab Ox')).toContainText('5/5');
  await expect(permanent(page, 'Lab Bird')).toContainText('1/1');
});

test('Nils, Discipline Enforcer: a creature with counters must pay to attack you', async ({
  page,
}) => {
  await runScenario(
    page,
    'Nils, Discipline Enforcer: a creature with counters must pay to attack you',
  );
  // P2 paid {2} for Lab Ox's two counters and attacks you; decline to block with Nils.
  await page.getByRole('button', { name: /Declare blockers/ }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('34');
});

test('Combat Calligrapher: an Inkling cannot attack you', async ({ page }) => {
  await runScenario(page, 'Combat Calligrapher: an Inkling cannot attack you');
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
  // P2 created the Inkling, so it is on P2's side of the board.
  await expect(
    page.locator('.opponent[data-seat="P2"]').getByRole('img', { name: 'Inkling', exact: true }),
  ).toBeVisible();
});

test('Combat Calligrapher: a player attacking an opponent of yours creates a tapped attacking Inkling', async ({
  page,
}) => {
  await runScenario(
    page,
    'Combat Calligrapher: a player attacking an opponent of yours creates a tapped attacking Inkling',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Lab Ox' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Inkling')).toBeVisible();
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('34');
});

test("Goblin Spymaster: at an opponent's end step that player creates a Goblin token", async ({
  page,
}) => {
  await runScenario(
    page,
    "Goblin Spymaster: at an opponent's end step that player creates a Goblin token",
  );
  await passUntil(page, page.getByText(/game over/i).first());
  // P2 created the Goblin, so it is on P2's side of the board and none is on yours.
  await expect(
    page.locator('.opponent[data-seat="P2"]').getByRole('img', { name: 'Goblin', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.human-zone').getByRole('img', { name: 'Goblin', exact: true }),
  ).toHaveCount(0);
});

test('Toby, Beastie Befriender: the Beast token cannot block alone', async ({ page }) => {
  await runScenario(page, 'Toby, Beastie Befriender: the Beast token cannot block alone');
  const toby = handCard(page, 'Toby, Beastie Befriender');
  await expect(toby).toHaveClass(/actionable/);
  await toby.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Beast'));
  // P2 attacks with Lab Ox. The Beast alone is not a legal declaration.
  const declare = page.getByRole('button', { name: /Declare blockers/ });
  await passUntil(page, declare);
  await declare.click();
  const rows = page.locator('.combat-assignment-row');
  await rows
    .filter({ has: page.getByText('Beast', { exact: true }) })
    .getByRole('button', { name: 'Lab Ox' })
    .click();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await expect(page.getByText(/Beast can't block alone/)).toBeVisible();
  // Adding Toby as a second blocker makes it legal.
  await rows
    .filter({ has: page.getByText('Toby, Beastie Befriender', { exact: true }) })
    .getByRole('button', { name: 'Lab Ox' })
    .click();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test('Toby, Beastie Befriender: creature tokens have flying while you control four or more', async ({
  page,
}) => {
  await runScenario(
    page,
    'Toby, Beastie Befriender: creature tokens have flying while you control four or more',
  );
  const cast = async (card: string) => {
    const hand = handCard(page, card).first();
    await expect(hand).toHaveClass(/actionable/, { timeout: 15_000 });
    await hand.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await confirm(page);
  };
  await cast('Toby, Beastie Befriender');
  await passStackUntil(page, permanent(page, 'Beast'));
  await expect(permanent(page, 'Beast')).not.toContainText(/flying/i);
  for (let servos = 1; servos <= 3; servos++) {
    await cast('Lab Token Forge');
    await passStackUntil(
      page,
      servos === 1
        ? permanent(page, 'Servo')
        : permanent(page, 'Servo').filter({ hasText: `×${servos}` }),
    );
  }
  await expect(permanent(page, 'Beast')).toContainText(/flying/i);
  await expect(permanent(page, 'Servo')).toContainText(/flying/i);
});

test('Life of the Party: the attacker gets +X/+0 for the creatures you control', async ({
  page,
}) => {
  await runScenario(
    page,
    'Life of the Party: the attacker gets +X/+0 for the creatures you control',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Life of the Party', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('37');
});

test('Life of the Party: each opponent creates a goaded copy of it', async ({ page }) => {
  await runScenario(page, 'Life of the Party: each opponent creates a goaded copy of it');
  const party = handCard(page, 'Life of the Party');
  await expect(party).toHaveClass(/actionable/);
  await party.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // Each opponent now controls a copy.
  for (const seat of ['P2', 'P3', 'P4'])
    await passStackUntil(
      page,
      page
        .locator(`.opponent[data-seat="${seat}"]`)
        .getByRole('img', { name: 'Life of the Party', exact: true }),
    );
  // Your own combat: attack with nothing.
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  // P2's goaded copy had to attack, and not you.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
});

test("Kardur, Doomscourge: opponents' creatures must attack, and not you, until your next turn", async ({
  page,
}) => {
  await runScenario(
    page,
    "Kardur, Doomscourge: opponents' creatures must attack, and not you, until your next turn",
  );
  const kardur = handCard(page, 'Kardur, Doomscourge');
  await expect(kardur).toHaveClass(/actionable/);
  await kardur.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  // Lab Ox had to attack and could not attack you: it hit P3.
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Kardur, Doomscourge: whenever an attacking creature dies, each opponent loses 1 and you gain 1', async ({
  page,
}) => {
  await runScenario(
    page,
    'Kardur, Doomscourge: whenever an attacking creature dies, each opponent loses 1 and you gain 1',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
  for (const seat of ['P2', 'P3', 'P4'])
    await expect(
      page.locator('.opponent').filter({ hasText: seat }).locator('.life-badge'),
    ).toHaveText('39');
});

test('Galactus, Devourer of Worlds: it must attack the opponent with the most life', async ({
  page,
}) => {
  await runScenario(
    page,
    'Galactus, Devourer of Worlds: it must attack the opponent with the most life',
  );
  // Its only legal declaration is made for you: it attacks P3 and nobody else.
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('28');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('20');
});

test("Galactus, Devourer of Worlds: no requirement while you control Silver Surfer, Galactus's Herald", async ({
  page,
}) => {
  await runScenario(
    page,
    "Galactus, Devourer of Worlds: no requirement while you control Silver Surfer, Galactus's Herald",
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Galactus, Devourer of Worlds', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('8');
});

test('Silver Surfer: search your library for Galactus when it enters', async ({ page }) => {
  await runScenario(page, 'Silver Surfer: search your library for Galactus when it enters');
  const surfer = handCard(page, "Silver Surfer, Galactus's Herald");
  await expect(surfer).toHaveClass(/actionable/);
  await surfer.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await page.getByRole('button', { name: 'Yes' }).click({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Put into your hand' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText('Galactus, Devourer of Worlds').first()).toBeVisible();
});

test('Silver Surfer: the target creature must attack the player it damaged', async ({ page }) => {
  await runScenario(page, 'Silver Surfer: the target creature must attack the player it damaged');
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText("Silver Surfer, Galactus's Herald", { exact: true }) })
    .getByRole('button', { name: 'P3' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  // The combat damage trigger's one required target is chosen on the board, then confirmed.
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Ox').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(page.locator('.opponent[data-seat="P3"]').locator('.life-badge')).toHaveText('32');
});

test("Taunt from the Rampart: opponents' creatures are goaded and can't block until your next turn", async ({
  page,
}) => {
  await runScenario(
    page,
    "Taunt from the Rampart: opponents' creatures are goaded and can't block until your next turn",
  );
  const taunt = handCard(page, 'Taunt from the Rampart');
  await expect(taunt).toHaveClass(/actionable/);
  await taunt.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Bird', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
});

test('Hexmark Destroyer: three blockers are not enough', async ({ page }) => {
  await runScenario(page, 'Hexmark Destroyer: three blockers are not enough');
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Hexmark Destroyer', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('34');
  await expect(permanent(page, 'Lab Servo')).toContainText('×3');
});

test("Champion of Lambholt: weaker creatures can't block your creatures", async ({ page }) => {
  await runScenario(page, "Champion of Lambholt: weaker creatures can't block your creatures");
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  // Lab Ox blocked and killed Lab Servo; Lab Bird could not block and is untouched.
  await expect(permanent(page, 'Lab Servo')).toHaveCount(0);
  await expect(permanent(page, 'Lab Bird')).toBeVisible();
  await expect(permanent(page, 'Champion of Lambholt')).toContainText('3/3');
});

test('Pramikon, Sky Rampart: each player may attack only the nearest opponent in the chosen direction', async ({
  page,
}) => {
  await runScenario(
    page,
    'Pramikon, Sky Rampart: each player may attack only the nearest opponent in the chosen direction',
  );
  const pramikon = handCard(page, 'Pramikon, Sky Rampart');
  await expect(pramikon).toHaveClass(/actionable/);
  await pramikon.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/choose left or right/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Right/ }).click();
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  const row = page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) });
  // Only P4, the nearest opponent to the right, is a legal defender.
  await expect(row.getByRole('button', { name: 'P2' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'P3' })).toHaveCount(0);
  await row.getByRole('button', { name: 'P4' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P4' }).locator('.life-badge'),
  ).toHaveText('39');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('40');
});

test('Teyo, Geometric Tactician: the -2 limits attacks to the nearest opponent in the chosen direction', async ({
  page,
}) => {
  await runScenario(
    page,
    'Teyo, Geometric Tactician: the -2 limits attacks to the nearest opponent in the chosen direction',
  );
  const teyo = permanent(page, 'Teyo, Geometric Tactician');
  await expect(teyo).toHaveClass(/actionable/);
  await teyo.click();
  await page.getByRole('button', { name: /−2: Choose left or right/ }).click();
  await expect(page.getByText('Activate Teyo, Geometric Tactician')).toBeVisible();
  await confirm(page);
  await expect(page.getByText(/choose one/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Right/ }).click();
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  const row = page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) });
  // Only P4, the nearest opponent to the right, is a legal defender.
  await expect(row.getByRole('button', { name: 'P2' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'P3' })).toHaveCount(0);
  await row.getByRole('button', { name: 'P4' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P4' }).locator('.life-badge'),
  ).toHaveText('39');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('40');
});

test('Teyo, Geometric Tactician: the Wall token and the +1 draw for you and a target opponent', async ({
  page,
}) => {
  await runScenario(
    page,
    'Teyo, Geometric Tactician: the Wall token and the +1 draw for you and a target opponent',
  );
  const teyo = handCard(page, 'Teyo, Geometric Tactician');
  await expect(teyo).toHaveClass(/actionable/);
  await teyo.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passStackUntil(page, permanent(page, 'Wall'));
  await expect(permanent(page, 'Wall')).toContainText('0/4');
  const walker = permanent(page, 'Teyo, Geometric Tactician');
  await expect(walker).toHaveClass(/actionable/);
  await walker.click();
  await page.getByRole('button', { name: /\+1: You and target opponent each draw a card/ }).click();
  await expect(page.getByText('Activate Teyo, Geometric Tactician')).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone .hand-card')).toHaveCount(1);
});

test('Triarch Stalker: creatures attacking the chosen player have menace', async ({ page }) => {
  await runScenario(page, 'Triarch Stalker: creatures attacking the chosen player have menace');
  await expect(page.getByText(/choose an opponent/).first()).toBeVisible({ timeout: 15_000 });
  await page
    .locator('.panel-group')
    .filter({ has: page.getByText('P2', { exact: true }) })
    .getByRole('button', { name: 'Choose' })
    .click();
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');
});

test("Illusionist's Gambit: remove the attackers, then an additional combat they cannot use against you", async ({
  page,
}) => {
  await runScenario(
    page,
    "Illusionist's Gambit: remove the attackers, then an additional combat they cannot use against you",
  );
  const gambit = page.locator('.hand-card.actionable', { hasText: "Illusionist's Gambit" });
  await passUntil(page, gambit);
  await gambit.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone').locator('.life-badge').first()).toHaveText('40');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('35');
});

test('Moraug, Fury of Akoum: landfall adds a combat phase and untaps your creatures, and each attack grows them', async ({
  page,
}) => {
  await runScenario(
    page,
    'Moraug, Fury of Akoum: landfall adds a combat phase and untaps your creatures, and each attack grows them',
  );
  const forest = handCard(page, 'Forest');
  await expect(forest).toHaveClass(/actionable/);
  await forest.click();
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  for (const name of ['Moraug, Fury of Akoum', 'Lab Ox'])
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('28');
});

test("Siren's Call: the active player's creatures must attack, and the ones that did not are destroyed", async ({
  page,
}) => {
  await runScenario(
    page,
    "Siren's Call: the active player's creatures must attack, and the ones that did not are destroyed",
  );
  const siren = page.locator('.hand-card.actionable', { hasText: "Siren's Call" });
  await passUntil(page, siren);
  await siren.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('35');
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .permanents')
      .getByRole('img', { name: 'Lab Ox', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .permanents')
      .getByRole('img', { name: 'Lab Bird', exact: true }),
  ).toHaveCount(0);
});

test("War's Toll: an opponent's mana taps all their lands, and an attack by one creature is an attack by all", async ({
  page,
}) => {
  await runScenario(
    page,
    "War's Toll: an opponent's mana taps all their lands, and an attack by one creature is an attack by all",
  );
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.human-zone').locator('.life-badge').first()).toHaveText('36');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('39');
});

test('Willie Lumpkin: both players draw, then the one who drew cannot attack you on their next turn', async ({
  page,
}) => {
  await runScenario(
    page,
    'Willie Lumpkin: both players draw, then the one who drew cannot attack you on their next turn',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Willie Lumpkin, Postman', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');
  await expect(
    page.locator('.opponent').filter({ hasText: 'P3' }).locator('.life-badge'),
  ).toHaveText('36');
  await expect(page.locator('.human-zone').locator('.life-badge').first()).toHaveText('40');
});

test('Fight or Flight: you separate P2’s creatures into two piles and only the pile P2 chooses can attack', async ({
  page,
}) => {
  await runScenario(
    page,
    'Fight or Flight: you separate P2’s creatures into two piles and only the pile P2 chooses can attack',
  );
  for (const [name, pile] of [
    ['Lab Ox', 2],
    ['Lab Servo', 1],
  ] as const) {
    await passUntil(page, page.getByText(`Put ${name} in a pile.`, { exact: true }));
    await page.getByRole('button', { name: `Put it in pile ${pile}`, exact: true }).click();
  }
  await passUntil(page, page.getByText(/game over/i).first());
  // Only Lab Servo, in the pile P2 chose, attacked: one damage to you.
  await expect(page.locator('.human-zone').locator('.life-badge').first()).toHaveText('39');
});

test('Fight or Flight: P2 separates your creatures and only the pile you choose can attack', async ({
  page,
}) => {
  await runScenario(
    page,
    'Fight or Flight: P2 separates your creatures and only the pile you choose can attack',
  );
  await passUntil(
    page,
    page.getByText(/choose a pile of creatures; only those can attack this turn/),
  );
  await expect(page.getByRole('button', { name: 'Attack with pile 1: Lab Ox' })).toBeVisible();
  await page.getByRole('button', { name: 'Attack with pile 2: Lab Servo' }).click();
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  // Lab Ox is in the pile you did not choose: it is not offered any defender.
  await expect(
    page
      .locator('.combat-assignment-row')
      .filter({ has: page.getByText('Lab Ox', { exact: true }) })
      .getByRole('button', { name: 'P2' }),
  ).toHaveCount(0);
  await page
    .locator('.combat-assignment-row')
    .filter({ has: page.getByText('Lab Servo', { exact: true }) })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.locator('.opponent').filter({ hasText: 'P2' }).locator('.life-badge'),
  ).toHaveText('39');
});

test('Master Warcraft: you choose which of P2’s creatures attack, and how P3’s creatures block them', async ({
  page,
}) => {
  await runScenario(
    page,
    'Master Warcraft: you choose which of P2’s creatures attack, and how P3’s creatures block them',
  );
  const warcraft = page.locator('.hand-card.actionable', { hasText: 'Master Warcraft' });
  await passUntil(page, warcraft);
  await warcraft.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  // You are asked which of P2's creatures attack: only that, no defender yet.
  const choose = page.getByRole('button', { name: /Choose attackers/ });
  await passUntil(page, choose);
  await choose.click({ timeout: 15_000 });
  await expect(page.getByText('Choose which of P2’s creatures attack')).toBeVisible();
  const row = (name: string) =>
    page.locator('.combat-assignment-row').filter({ has: page.getByText(name, { exact: true }) });
  await expect(row('Lab Ox').getByRole('button', { name: 'P3' })).toHaveCount(0);
  await row('Lab Servo').getByRole('button', { name: 'Attacks' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  // P2 chooses what Lab Servo attacks (P3); then you choose P3's blocks.
  const blockers = page.getByRole('button', { name: /Declare blockers/ });
  await passUntil(page, blockers);
  await blockers.click({ timeout: 15_000 });
  await expect(page.getByText('Declare blockers for P3', { exact: true })).toBeVisible();
  await row('Lab Ox').getByRole('button', { name: 'Lab Servo' }).click();
  await page.getByRole('button', { name: 'Confirm blocks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent[data-seat="P3"] .life-badge')).toHaveText('40');
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .permanents')
      .getByRole('img', { name: 'Lab Servo', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.opponent[data-seat="P2"] .permanents')
      .getByRole('img', { name: 'Lab Ox', exact: true }),
  ).toBeVisible();
});

test('Master Warcraft: P2 chooses which of your creatures attack and you choose what they attack', async ({
  page,
}) => {
  await runScenario(
    page,
    'Master Warcraft: P2 chooses which of your creatures attack and you choose what they attack',
  );
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click({ timeout: 15_000 });
  await expect(page.getByText('Choose what each creature P2 chose attacks')).toBeVisible();
  // Only the creature P2 chose is offered, and it has no "stay home" choice.
  const rows = page.locator('.combat-assignment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Lab Servo');
  await expect(rows.first().getByRole('button', { name: 'Stay home' })).toHaveCount(0);
  await expect(rows.first().getByRole('button', { name: 'Decline to pay' })).toHaveCount(0);
  await rows.first().getByRole('button', { name: 'P3' }).click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.locator('.opponent[data-seat="P3"] .life-badge')).toHaveText('39');
});
