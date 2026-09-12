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

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(37);
  await picker.selectOption({ label: title });
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function permanent(page: Page, name: string) {
  return page.locator('.object').filter({ has: page.getByRole('img', { name, exact: true }) });
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
  await expect(page.getByAltText('Gev, Scaled Scorch')).toBeVisible();
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
  await expect(page.getByAltText('Nightscape Familiar').first()).toBeVisible();
});

test('Thran Vigil: artifact leaves your graveyard', async ({ page }) => {
  await runScenario(page, 'Thran Vigil: artifact leaves your graveyard');

  const picker = permanent(page, 'Grave Picker');
  await expect(picker).toHaveClass(/actionable/);
  await picker.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const talisman = page.locator('.zone-card-thumb.targetable').filter({
    has: page.getByAltText('Eligible Talisman'),
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
  await expect(page.getByText(/exile/i).first()).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(page.getByText(/gains 4 life/i).first()).toBeVisible();
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

  const bog = handCard(page, 'Bojuka Bog');
  await expect(bog).toHaveClass(/actionable/);
  await bog.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
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
  await page.locator('.object').filter({ has: page.getByRole('img', { name: 'Lab Hex', exact: true }) }).click();
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

  const trail = handCard(page, 'Game Trail');
  await expect(trail).toHaveClass(/actionable/);
  await trail.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

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

  const village = handCard(page, 'Fortified Village');
  await expect(village).toHaveClass(/actionable/);
  await village.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

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

  const snarl = handCard(page, 'Shineshadow Snarl');
  await expect(snarl).toHaveClass(/actionable/);
  await snarl.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

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

  const mountain = handCard(page, 'Mountain');
  await expect(mountain).toHaveClass(/actionable/);
  await mountain.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
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

  const forest = handCard(page, 'Forest');
  await expect(forest).toHaveClass(/actionable/);
  await forest.click();
  const playLand = page.getByRole('button', { name: 'Play land' });
  if (await playLand.isVisible()) {
    await playLand.click();
  } else {
    await confirm(page);
  }

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
