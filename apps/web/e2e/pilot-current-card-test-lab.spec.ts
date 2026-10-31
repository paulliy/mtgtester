import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  hand,
  permanent,
  seatZone,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { PILOT_CURRENT_ALL_SCENARIOS } from '../../../packages/server/src/cards/pilot-current-scenario-catalog';

/** Viewer evidence for the phase 6 pilot's current-workflow batch (`pilot-current`). */
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PILOT_CURRENT_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();
const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing pilot-current title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

const life = (page: Page, seat: string): Locator =>
  page.locator(
    seat === 'P1' ? '.human-zone .life-badge' : `.opponent[data-seat="${seat}"] .life-badge`,
  );
const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

/** Cast a hand card that takes no target, confirm its payment, and wait for it to resolve. */
async function cast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, new RegExp(`${name}[^]*resolves`)));
}

/** Cast a hand card at one [seat, name] permanent, confirm, and wait for it to resolve. */
async function castAt(page: Page, name: string, seat: string, target: string): Promise<void> {
  const card = hand(page, name).first();
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const chosen = permanent(page, seat, target).first();
  await expect(chosen).toHaveClass(/targetable|actionable/);
  await chosen.click();
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, new RegExp(`${name}[^]*resolves`)));
}

/** Play a land from hand and wait for it to leave the hand (the board groups same-name lands). */
async function playLand(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const play = page.getByRole('button', { name: /^Play/ });
  if ((await play.count()) > 0) await play.first().click();
  await expect(hand(page, name)).toHaveCount(0);
  await expect(permanent(page, 'P1', name).first()).toBeVisible();
}

/** Play Secluded Courtyard and choose Elf as it enters. */
async function playCourtyardChoosingElf(page: Page): Promise<void> {
  const card = hand(page, 'Secluded Courtyard');
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const play = page.getByRole('button', { name: /^Play/ });
  if ((await play.count()) > 0) await play.first().click();
  const elf = page.getByRole('button', { name: 'Elf', exact: true });
  await passStackUntil(page, elf);
  await elf.click();
  await expect(permanent(page, 'P1', 'Secluded Courtyard')).toHaveCount(1);
}

/** Activate Syr Konrad's {1}{B} mill ability and confirm its payment. */
async function activateKonrad(page: Page): Promise<void> {
  const konrad = permanent(page, 'P1', 'Syr Konrad, the Grim');
  await passUntil(page, konrad.and(page.locator('.actionable')));
  await konrad.click();
  const ability = page
    .locator('.source-actions .source-action-row button')
    .filter({ hasText: /mills a card/ });
  if ((await ability.count()) > 0) await ability.first().click();
  await confirmButton(page).click();
}

/** Click Untimely Malfunction in hand and pick the mode whose button matches `mode`. */
async function chooseMalfunctionMode(page: Page, mode: RegExp): Promise<void> {
  const card = hand(page, 'Untimely Malfunction');
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  // With one legal mode the cast is already selected and there is no row to pick.
  const row = page.locator('.source-actions .source-action-row button').filter({ hasText: mode });
  if ((await row.count()) > 0) await row.click();
}

/** The card named `name` in P1's "Top of library" strip. */
const libraryTop = (page: Page, name: string): Locator =>
  page
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name, exact: true }) })
    .first();

/** Declare Etali, Primal Storm as P2's only attacker. */
async function attackWithEtali(page: Page): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: 'Etali, Primal Storm' })
    .getByRole('button', { name: 'P2' })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
}

const FLOWS: Record<string, (page: Page) => Promise<void>> = {
  'pilot-current-jet-medallion-viewer-reduced': async (page) => {
    await cast(page, 'Pilot Lab Black Sorcery');
    await expect(life(page, 'P1')).toHaveText('42');
    await expect(permanent(page, 'P1', 'Swamp').locator('.tap-badge')).toHaveCount(1);
  },
  'pilot-current-jet-medallion-viewer-not-red': async (page) => {
    // The free Trinket is castable, so P1 has priority; the red sorcery is not.
    await passUntil(page, hand(page, 'Pilot Lab Trinket').and(page.locator('.actionable')));
    await expect(hand(page, 'Pilot Lab Red Sorcery')).toBeVisible();
    await expect(hand(page, 'Pilot Lab Red Sorcery')).not.toHaveClass(/actionable/);
  },
  'pilot-current-great-henge-viewer-cast-reduced': async (page) => {
    await cast(page, 'The Great Henge');
    await expect(permanent(page, 'P1', 'The Great Henge')).toHaveCount(1);
  },
  'pilot-current-great-henge-viewer-enter-trigger': async (page) => {
    await cast(page, 'Pilot Lab Bear');
    await passStackUntil(page, permanent(page, 'P1', 'Pilot Lab Bear').filter({ hasText: '3/3' }));
    await expect(life(page, 'P1')).toHaveText('42');
    // The Trinket and the card drawn.
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'pilot-current-great-henge-viewer-token-ignored': async (page) => {
    await cast(page, 'Pilot Lab Saproling');
    await passStackUntil(page, permanent(page, 'P1', 'Saproling').filter({ hasText: '1/1' }));
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'pilot-current-great-henge-viewer-opponent-creature': async (page) => {
    // P2, a scripted seat, casts Pilot Lab Bear on its turn.
    await passStackUntil(page, permanent(page, 'P2', 'Pilot Lab Bear').filter({ hasText: '2/2' }));
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'pilot-current-gamble-viewer-tutor': async (page) => {
    const gamble = hand(page, 'Gamble');
    await passUntil(page, gamble.and(page.locator('.actionable')));
    await gamble.click();
    await confirmButton(page).click();
    const find = page
      .locator('.decision-panel .panel-group')
      .filter({ has: page.getByText('Pilot Lab Bear', { exact: true }) })
      .getByRole('button')
      .first();
    await passStackUntil(page, find);
    await find.click();
    await passStackUntil(page, logLine(page, /Gamble[^]*resolves/));
    // The Trinket and the Bear were in hand; one was discarded at random.
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
    await expect(seatZone(page, 'P1', 'Graveyard').getByRole('img')).toHaveCount(2);
  },
  'pilot-current-secluded-courtyard-viewer-cast-chosen': async (page) => {
    await playCourtyardChoosingElf(page);
    await cast(page, 'Pilot Lab Elf');
    await expect(permanent(page, 'P1', 'Pilot Lab Elf')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Secluded Courtyard').locator('.tap-badge')).toHaveCount(1);
  },
  'pilot-current-secluded-courtyard-viewer-other-type': async (page) => {
    await playCourtyardChoosingElf(page);
    // The free Trinket is castable, so P1 has priority; the Goblin is not.
    await passUntil(page, hand(page, 'Pilot Lab Trinket').and(page.locator('.actionable')));
    await expect(hand(page, 'Pilot Lab Goblin')).toBeVisible();
    await expect(hand(page, 'Pilot Lab Goblin')).not.toHaveClass(/actionable/);
  },
  'pilot-current-secluded-courtyard-viewer-activate': async (page) => {
    await playCourtyardChoosingElf(page);
    const warrior = permanent(page, 'P1', 'Pilot Lab Elf Warrior');
    await passUntil(page, warrior.and(page.locator('.actionable')));
    await warrior.click();
    const ability = page
      .locator('.source-actions .source-action-row button')
      .filter({ hasText: /\+1\/\+1/ });
    if ((await ability.count()) > 0) await ability.first().click();
    const confirm = confirmButton(page);
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
    await passStackUntil(page, warrior.filter({ hasText: '2/2' }));
    await expect(permanent(page, 'P1', 'Secluded Courtyard').locator('.tap-badge')).toHaveCount(1);
  },
  'pilot-current-morbid-opportunist-viewer-draw': async (page) => {
    await castAt(page, 'Pilot Lab Doom', 'P2', 'Pilot Lab Bear');
    await passStackUntil(page, logLine(page, /Morbid Opportunist[^]*resolves/));
    await expect(permanent(page, 'P2', 'Pilot Lab Bear')).toHaveCount(0);
    // The Trinket and the card drawn.
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'pilot-current-morbid-opportunist-viewer-once': async (page) => {
    await castAt(page, 'Pilot Lab Doom', 'P2', 'Pilot Lab Bear');
    await passStackUntil(page, logLine(page, /Morbid Opportunist[^]*resolves/));
    await castAt(page, 'Pilot Lab Doom', 'P2', 'Pilot Lab Giant');
    await passUntil(page, hand(page, 'Pilot Lab Trinket').and(page.locator('.actionable')));
    await expect(permanent(page, 'P2', 'Pilot Lab Giant')).toHaveCount(0);
    // Both Dooms are gone; the Trinket and one drawn card remain.
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'pilot-current-morbid-opportunist-viewer-wrath': async (page) => {
    await cast(page, 'Pilot Lab Wrath');
    await passStackUntil(page, logLine(page, /Morbid Opportunist[^]*resolves/));
    await expect(permanent(page, 'P1', 'Morbid Opportunist')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Pilot Lab Giant')).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'pilot-current-syr-konrad-viewer-mill-creature': async (page) => {
    await activateKonrad(page);
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await expect(life(page, 'P3')).toHaveText('39');
    await expect(life(page, 'P4')).toHaveText('39');
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pilot-current-syr-konrad-viewer-mill-lands': async (page) => {
    await activateKonrad(page);
    await passStackUntil(page, logLine(page, /Each player mills a card[^]*resolves/));
    await passUntil(page, hand(page, 'Pilot Lab Trinket').and(page.locator('.actionable')));
    for (const seat of ['P1', 'P2', 'P3', 'P4']) await expect(life(page, seat)).toHaveText('40');
  },
  'pilot-current-untimely-malfunction-viewer-destroy-artifact': async (page) => {
    await chooseMalfunctionMode(page, /Destroy target artifact/);
    const relic = permanent(page, 'P2', 'Pilot Lab Relic').first();
    await expect(relic).toHaveClass(/targetable/);
    await relic.click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Untimely Malfunction[^]*resolves/));
    await expect(permanent(page, 'P2', 'Pilot Lab Relic')).toHaveCount(0);
  },
  'pilot-current-untimely-malfunction-viewer-redirect': async (page) => {
    // P2, a scripted seat, casts Pilot Lab Doom at your Pilot Lab Bear.
    const doom = page.locator('.stack li').filter({ hasText: 'Pilot Lab Doom' }).first();
    await passUntil(page, doom);
    await chooseMalfunctionMode(page, /Change the target/);
    await doom.click();
    await confirmButton(page).click();
    const giant = page.getByRole('button', { name: /Pilot Lab Giant/ }).first();
    await passStackUntil(page, giant);
    await giant.click();
    await passStackUntil(page, logLine(page, /Pilot Lab Doom[^]*resolves/));
    await expect(permanent(page, 'P2', 'Pilot Lab Giant')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Pilot Lab Bear')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Pilot Lab Elf')).toHaveCount(1);
  },
  'pilot-current-untimely-malfunction-viewer-cant-block': async (page) => {
    await chooseMalfunctionMode(page, /can't block/);
    await confirmButton(page).click();
    const giant = page.getByRole('button', { name: /^Target Pilot Lab Giant$/ });
    await passStackUntil(page, giant);
    await giant.click();
    await page.getByRole('button', { name: /^Choose no more targets$/ }).click();
    await passStackUntil(page, logLine(page, /Untimely Malfunction[^]*resolves/));
    const declare = page.getByRole('button', { name: /Declare attackers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: 'Pilot Lab Bear' })
      .getByRole('button', { name: 'P2' })
      .click();
    await page.getByRole('button', { name: 'Confirm attacks' }).click();
    // P2 declares no blocks; the Giant could not have.
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
  },
  'pilot-current-bolas-citadel-viewer-cast-for-life': async (page) => {
    const doom = libraryTop(page, 'Pilot Lab Doom');
    await passUntil(page, doom.and(page.locator('.actionable')));
    await doom.click();
    const giant = permanent(page, 'P2', 'Pilot Lab Giant').first();
    await expect(giant).toHaveClass(/targetable|actionable/);
    await giant.click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Pilot Lab Doom[^]*resolves/));
    await expect(life(page, 'P1')).toHaveText('39');
    await expect(permanent(page, 'P2', 'Pilot Lab Giant')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Swamp').locator('.tap-badge')).toHaveCount(0);
  },
  'pilot-current-bolas-citadel-viewer-play-land': async (page) => {
    const mountain = libraryTop(page, 'Mountain');
    await passUntil(page, mountain.and(page.locator('.actionable')));
    await mountain.click();
    const play = page.getByRole('button', { name: /^Play/ });
    if ((await play.count()) > 0) await play.first().click();
    await expect(permanent(page, 'P1', 'Mountain')).toHaveCount(1);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pilot-current-bolas-citadel-viewer-sacrifice-ten': async (page) => {
    const citadel = permanent(page, 'P1', "Bolas's Citadel");
    await passUntil(page, citadel.and(page.locator('.actionable')));
    await citadel.click();
    const confirm = confirmButton(page);
    if ((await confirm.count()) > 0) await confirm.click();
    // Each sacrifice is picked on the board: the Citadel, then eight of the nine grouped Relics;
    // the last pick has one candidate left. The Swamp is never highlighted.
    const picks = ["Bolas's Citadel", ...Array<string>(8).fill('Pilot Lab Relic')];
    for (const [index, name] of picks.entries()) {
      await expect(
        page.getByText(`choose permanent ${index + 1} of 10 to sacrifice`),
      ).toBeVisible();
      await expect(permanent(page, 'P1', 'Swamp')).not.toHaveClass(/targetable|actionable/);
      const pick = permanent(page, 'P1', name).first();
      await expect(pick).toHaveClass(/targetable|actionable/);
      await pick.click();
      await confirmButton(page).click();
    }
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '30' }));
    await expect(life(page, 'P3')).toHaveText('30');
    await expect(life(page, 'P4')).toHaveText('30');
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(permanent(page, 'P1', "Bolas's Citadel")).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Swamp')).toHaveCount(1);
  },
  'pilot-current-etali-primal-storm-viewer-cast-both': async (page) => {
    await attackWithEtali(page);
    // Each exiled spell is a row with its own button; the Forests from P3 and P4 have none.
    for (const name of ['Pilot Lab Saproling', 'Pilot Lab Red Sorcery']) {
      const cast = page
        .locator('.decision-panel .panel-group')
        .filter({ hasText: name })
        .getByRole('button', { name: 'Cast for free', exact: true })
        .first();
      await passStackUntil(page, cast);
      await cast.click();
    }
    await passUntil(page, life(page, 'P2').filter({ hasText: '34' }));
    await expect(life(page, 'P1')).toHaveText('42');
    await expect(permanent(page, 'P1', 'Saproling')).toHaveCount(1);
  },
  'pilot-current-etali-primal-storm-viewer-cast-none': async (page) => {
    await attackWithEtali(page);
    const done = page.getByRole('button', { name: /^(Done|Cast no more spells)/ }).first();
    await passStackUntil(page, done);
    await done.click();
    await passUntil(page, life(page, 'P2').filter({ hasText: '34' }));
    await expect(permanent(page, 'P1', 'Saproling')).toHaveCount(0);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pilot-current-explore-viewer-second-land': async (page) => {
    await playLand(page, 'Forest');
    await cast(page, 'Explore');
    await playLand(page, 'Plains');
    // Two lands played this turn: Island is not offered as a third.
    await expect(hand(page, 'Island')).toBeVisible();
    await expect(hand(page, 'Island')).not.toHaveClass(/actionable/);
  },
};

test.describe('pilot-current Card Test Lab scenarios', () => {
  for (const { id } of PILOT_CURRENT_ALL_SCENARIOS)
    test(id, async ({ page }) => {
      const flow = FLOWS[id];
      if (flow === undefined) throw new Error(`No viewer flow for ${id}`);
      await runScenario(page, id);
      await flow(page);
    });

  test.afterAll(() => {
    expect([...exercised].sort()).toEqual([...titles.keys()].sort());
  });
});
