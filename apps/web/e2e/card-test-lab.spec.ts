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
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const catalogScenarioIds = new Set<string>();
const exercisedScenarioIds = new Set<string>();

test.afterAll(() => {
  expect([...exercisedScenarioIds].sort()).toEqual([...catalogScenarioIds].sort());
});

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
    for (const scenarioId of optionIds) catalogScenarioIds.add(scenarioId);
  } else {
    expect([...optionIds].sort()).toEqual([...catalogScenarioIds].sort());
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
  return page
    .locator('.object, .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card', { hasText: name });
}

async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm' }).click();
}

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
  // Game-over stays in player mode: opponent seats have no spectator exile meta-item, and a
  // leftover card-preview img would still match a page-wide Lab Ox locator.
  const closeResults = page.getByRole('button', { name: 'Close results' });
  if (await closeResults.isVisible()) {
    await closeResults.click();
  }
  await expect(page.getByText('Lab Ox is exiled by Swords to Plowshares')).toBeVisible();
  await expect(page.getByText(/gains 4 life/i).first()).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.locator('.opponent').filter({ hasText: 'P2' })).toContainText('44');
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
  await page.locator('.opponent').filter({ hasText: 'P2' }).click();
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
    await page.getByLabel('Confirm passes & lands').check();
    await expect(page.getByLabel('Skip confirm step')).not.toBeChecked();
    await page.locator('.hand-card', { hasText: 'Myriad Landscape' }).click();

    await expect(page.getByRole('button', { name: 'Play land', exact: true })).toBeVisible();
    expect(await submissionCount(page)).toBe(0);
    await page.getByRole('button', { name: 'Play land', exact: true }).click();
    await assertLandPlayedOnce(page);
  });

  test('skip confirm submits the land once', async ({ page }) => {
    await runLandScenario(page);
    await page.getByLabel('Skip confirm step').check();
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
    await page.getByLabel('Land drop reminder').uncheck();
    await page.getByRole('button', { name: 'Pass priority', exact: true }).click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect.poll(() => submissionCount(page)).toBe(1);
  });

  test('confirm passes and lands still reviews when skip confirm is also on', async ({ page }) => {
    await runLandScenario(page);
    await page.getByLabel('Confirm passes & lands').check();
    await page.getByLabel('Skip confirm step').check();
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

  // The Plains is the only basic land name in the library, so the search finds it directly.
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
