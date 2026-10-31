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
import { RUNNER_ALL_SCENARIOS } from '../../../packages/server/src/cards/runner-scenario-catalog';

/**
 * Viewer evidence for the scenarios the engine-test runner also drives (ADR 0034 decision 10).
 * The scenario files script every seat; here the viewer plays P1's steps by hand, and the other
 * seats answer their own steps as the server's scripted seats.
 */
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(RUNNER_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();
const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing runner scenario title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

/** The decision-panel button `verb` for the option about the card named `card`. */
const cardChoice = (page: Page, card: string, verb: string): Locator =>
  page
    .locator('.decision-panel .panel-group')
    .filter({ has: page.getByText(card, { exact: true }) })
    .getByRole('button', { name: verb, exact: true });

/** Cast Chrome Mox (it costs nothing and targets nothing) and wait for its imprint trigger. */
async function castChromeMox(page: Page): Promise<void> {
  const mox = hand(page, 'Chrome Mox');
  await passUntil(page, mox.and(page.locator('.actionable')));
  await mox.click();
  await confirmButton(page).click();
}

async function expectNotCastable(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/actionable/);
}

/** Cast Path to Exile at P2's Scenario Bear and wait for it to resolve. */
async function pathTheBear(page: Page): Promise<void> {
  const path = hand(page, 'Path to Exile');
  await passUntil(page, path.and(page.locator('.actionable')));
  await path.click();
  await expect(confirmButton(page)).toBeVisible();
  const bear = permanent(page, 'P2', 'Scenario Bear').first();
  await expect(bear).toHaveClass(/targetable|actionable/);
  await bear.click();
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, /Path to Exile[^]*resolves/));
  await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
  await expect(
    seatZone(page, 'P2', 'Exile').getByRole('img', { name: 'Scenario Bear' }),
  ).toHaveCount(1);
}

/**
 * Cast from a hand or zone card: pick the cast mode whose button matches `mode` when the card
 * offers more than one, then each target as [seat, name], then confirm, and wait for it to resolve.
 */
async function castWith(
  page: Page,
  source: Locator,
  options: { mode?: RegExp; targets?: Array<[string, string]>; resolves: RegExp },
): Promise<void> {
  await passUntil(page, source.and(page.locator('.actionable')));
  await source.click();
  const modes = page.locator('.source-actions .source-action-row button');
  if (options.mode !== undefined) await modes.filter({ hasText: options.mode }).click();
  else if ((await modes.count()) > 1)
    await modes
      .filter({ has: page.locator('span', { hasText: /^Cast$/ }) })
      .first()
      .click();
  for (const [seat, name] of options.targets ?? []) {
    const target = permanent(page, seat, name).first();
    await expect(target).toHaveClass(/targetable|actionable/);
    await target.click();
  }
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, options.resolves));
}

const life = (page: Page, seat: string): Locator =>
  page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);

/** Declare each [creature, defender] attack in the attack panel, the rest not attacking. */
async function attack(page: Page, attacks: Array<[string, string]>): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  for (const [creature, defender] of attacks)
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: creature })
      .getByRole('button', { name: defender })
      .click();
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
}

/** Activate the ability matching `ability` of a permanent, once it is offered. */
async function activate(page: Page, source: Locator, ability: RegExp): Promise<void> {
  await passUntil(page, source.and(page.locator('.actionable')));
  await source.click();
  const action = page.locator('.source-actions .source-action-row button').filter({
    hasText: ability,
  });
  if ((await action.count()) > 0) await action.first().click();
  const confirm = confirmButton(page);
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}

/** A permanent's keyword badge naming `keyword`; count 0 when it does not have it. */
const keywordOn = (page: Page, seat: string, name: string, keyword: string): Locator =>
  permanent(page, seat, name).locator(`.keywords[title*="${keyword}" i]`);

/** Choose each [seat, name] permanent as a target of the pending prompt, then confirm. */
async function targetAndConfirm(page: Page, targets: Array<[string, string]>): Promise<void> {
  for (const [seat, name] of targets) {
    const target = permanent(page, seat, name).first();
    await passUntil(page, target.and(page.locator('.targetable, .actionable')));
    await target.click();
  }
  await confirmButton(page).click();
}

/** Activate Takenuma's channel ability from your hand and confirm its payment. */
async function channelTakenuma(page: Page): Promise<void> {
  const card = hand(page, 'Takenuma, Abandoned Mire');
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await page
    .locator('.source-actions .source-action-row button')
    .filter({ hasText: /Discard this card/ })
    .first()
    .click();
  const confirm = confirmButton(page);
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}

/** Cast Mox Diamond; its entering replacement asks before it finishes resolving. */
async function castMoxDiamond(page: Page): Promise<void> {
  const mox = hand(page, 'Mox Diamond');
  await passUntil(page, mox.and(page.locator('.actionable')));
  await mox.click();
  await confirmButton(page).click();
}

const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
  seatZone(page, seat, zone).getByRole('img', { name, exact: true });

/** Pass to your draw step and use Sylvan Library's trigger. */
async function useSylvanLibrary(page: Page): Promise<void> {
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  await passUntil(page, yes);
  await yes.click();
}

/** Choose the named cards drawn this turn, in order; a last single candidate is chosen for you. */
async function chooseDrawn(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    const choice = cardChoice(page, name, 'Choose');
    await passUntil(page, choice.or(page.getByRole('button', { name: /^Pay 4 life|^Put / })));
    if ((await choice.count()) > 0) await choice.click();
  }
}

/** Answer one of Sylvan Library's pay-or-put-back questions. */
async function answerSylvan(page: Page, answer: RegExp): Promise<void> {
  const button = page.getByRole('button', { name: answer });
  await passUntil(page, button);
  await button.click();
}

/** Answer Orcish Bowmasters' "any target" prompt with a player seat or a [seat, name] permanent. */
async function bowmastersTarget(page: Page, target: string | [string, string]): Promise<void> {
  // A spell's trigger as it resolves says "Target 1 of 1"; one put on the stack during an
  // opponent's spell says "Choose targets for Orcish Bowmasters".
  await passUntil(
    page,
    page.getByText(/Target 1 of 1|Choose targets for Orcish Bowmasters/).first(),
  );
  if (typeof target === 'string')
    await page.locator(`.opponent[data-seat="${target}"] > header`).click();
  else await permanent(page, target[0], target[1]).first().click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await confirmButton(page).click();
}

/** Cast a free sorcery and wait for Academy Manufactor's tokens to appear. */
async function castForTokens(page: Page, name: string): Promise<void> {
  await castWith(page, hand(page, name), { resolves: new RegExp(`${name}[^]*resolves`) });
}

/** A seat's token stack named `name`, showing `count` copies (one tile when count is 1). */
async function expectTokens(page: Page, seat: string, name: string, count: number): Promise<void> {
  const tile = permanent(page, seat, name);
  await expect(tile).toHaveCount(1);
  if (count === 1) await expect(tile.locator('.stack-count-badge')).toHaveCount(0);
  else await expect(tile.locator('.stack-count-badge')).toHaveText(`×${count}`);
}

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'mizzium-mortars-target': async (page) => {
    await castWith(page, hand(page, 'Mizzium Mortars'), {
      targets: [['P2', 'Scenario Ox']],
      resolves: /Mizzium Mortars[^]*resolves/,
    });
    // The 3/5 Ox survives 4 damage; nothing else was hit.
    await expect(permanent(page, 'P2', 'Scenario Ox')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
  },
  'mizzium-mortars-overload': async (page) => {
    await castWith(page, hand(page, 'Mizzium Mortars'), {
      mode: /overload/i,
      resolves: /Mizzium Mortars[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(permanent(page, 'P3', 'Scenario Hexbear')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Ox')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
  },
  'electrickery-target': async (page) => {
    await castWith(page, hand(page, 'Electrickery'), {
      targets: [['P2', 'Scenario Bear']],
      resolves: /Electrickery[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Squirrel')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Squirrel')).toHaveCount(1);
  },
  'electrickery-overload': async (page) => {
    await castWith(page, hand(page, 'Electrickery'), {
      mode: /overload/i,
      resolves: /Electrickery[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Squirrel')).toHaveCount(0);
    await expect(permanent(page, 'P3', 'Scenario Squirrel')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Squirrel')).toHaveCount(1);
  },
  'ettercap-web-shot-then-creature': async (page) => {
    await castWith(page, hand(page, 'Ettercap // Web Shot'), {
      mode: /adventure/i,
      targets: [['P2', 'Scenario Bird']],
      resolves: /Web Shot[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Bird')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    // On an adventure: cast Ettercap from exile.
    const exiled = seatZone(page, 'P1', 'Exile')
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Ettercap // Web Shot' }) })
      .first();
    await castWith(page, exiled, { resolves: /Ettercap[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Ettercap // Web Shot')).toHaveCount(1);
  },
  'path-to-exile-search': async (page) => {
    await pathTheBear(page);
    // P2, a scripted seat, found a Plains; it entered tapped.
    await expect(permanent(page, 'P2', 'Plains')).toHaveCount(1);
  },
  'path-to-exile-decline-search': async (page) => {
    await pathTheBear(page);
    // P2, a scripted seat, declined: no land entered.
    await expect(permanent(page, 'P2', 'Plains')).toHaveCount(0);
  },
  'chrome-mox-imprint-then-tap': async (page) => {
    await castChromeMox(page);
    const exile = cardChoice(page, 'Scenario Flame', 'Exile');
    await passUntil(page, exile);
    await exile.click();
    await passUntil(
      page,
      seatZone(page, 'P1', 'Exile').getByRole('img', { name: 'Scenario Flame' }),
    );
    // The Mox now makes red: Scenario Imp is castable with it alone.
    await castWith(page, hand(page, 'Scenario Imp'), { resolves: /Scenario Imp[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Imp')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Chrome Mox').locator('.tap-badge')).toHaveCount(1);
  },
  'chrome-mox-only-the-exiled-colors': async (page) => {
    await castChromeMox(page);
    const exile = cardChoice(page, 'Scenario Sprout', 'Exile');
    await passUntil(page, exile);
    await exile.click();
    await passUntil(
      page,
      seatZone(page, 'P1', 'Exile').getByRole('img', { name: 'Scenario Sprout' }),
    );
    // Green mana only: the red Imp is not castable.
    await expectNotCastable(page, 'Scenario Imp');
  },
  'chrome-mox-decline': async (page) => {
    await castChromeMox(page);
    const nothing = page.getByRole('button', { name: 'Exile nothing', exact: true });
    await passUntil(page, nothing);
    await nothing.click();
    await passUntil(page, permanent(page, 'P1', 'Chrome Mox'));
    await expectNotCastable(page, 'Scenario Imp');
    await expectNotCastable(page, 'Scenario Flame');
  },
  'face-breaker-treasure-then-play': async (page) => {
    await attack(page, [['Professional Face-Breaker', 'P2']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P2')).toHaveText('38');
    await activate(
      page,
      permanent(page, 'P1', 'Professional Face-Breaker'),
      /Sacrifice a Treasure/,
    );
    const forest = seatZone(page, 'P1', 'Exile')
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Forest' }) })
      .first();
    await passUntil(page, forest.and(page.locator('.actionable')));
    await forest.click();
    const play = page.getByRole('button', { name: /^Play/ });
    if ((await play.count()) > 0) await play.first().click();
    await passUntil(page, permanent(page, 'P1', 'Forest'));
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
    await expect(
      seatZone(page, 'P1', 'Exile').getByRole('img', { name: 'Scenario Bear' }),
    ).toHaveCount(0);
  },
  'face-breaker-double-blocked': async (page) => {
    await attack(page, [['Professional Face-Breaker', 'P2']]);
    // P2, a scripted seat, blocks with both Bears; Face-Breaker's 2 damage goes to one of them.
    const assign = page.getByRole('button', { name: /^All 2 damage to Scenario Bear/ }).first();
    await passUntil(page, assign);
    await assign.click();
    await passUntil(page, permanent(page, 'P2', 'Scenario Bear').nth(0));
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(life(page, 'P2')).toHaveText('40');
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
  },
  'face-breaker-menace-lone-blocker': async (page) => {
    await attack(page, [['Professional Face-Breaker', 'P2']]);
    // P2's lone block is refused; it declares no block, so the damage and the Treasure follow.
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
  },
  'face-breaker-one-treasure': async (page) => {
    await attack(page, [
      ['Professional Face-Breaker', 'P2'],
      ['Scenario Bear', 'P2'],
    ]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P2')).toHaveText('36');
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(1);
  },
  'face-breaker-opponent-creature-no-treasure': async (page) => {
    // P2, a scripted seat, attacks you with Scenario Bear; you don't block.
    const declare = page.getByRole('button', { name: /Declare blockers/ });
    await passUntil(page, declare);
    await declare.click();
    await page.getByRole('button', { name: 'Confirm blocks' }).click();
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Treasure')).toHaveCount(0);
  },
  'face-breaker-no-treasure-no-sacrifice': async (page) => {
    await passUntil(page, hand(page, 'Scenario Bear').and(page.locator('.actionable')));
    // Scenario Trinket is an artifact but not a Treasure: Face-Breaker has nothing to offer.
    await expect(permanent(page, 'P1', 'Professional Face-Breaker')).not.toHaveClass(/actionable/);
  },
  'face-breaker-permission-ends': async (page) => {
    await attack(page, [['Professional Face-Breaker', 'P2']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await activate(
      page,
      permanent(page, 'P1', 'Professional Face-Breaker'),
      /Sacrifice a Treasure/,
    );
    const bear = seatZone(page, 'P1', 'Exile').getByRole('img', { name: 'Scenario Bear' });
    await expect(bear).toHaveCount(1);
    // Pass through the other seats' turns to your next precombat main phase.
    await passUntil(page, page.getByText(/Turn 8/).first());
    await expect(bear).toHaveCount(1);
    await expect(
      seatZone(page, 'P1', 'Exile')
        .locator('.zone-card-thumb')
        .filter({ has: page.getByRole('img', { name: 'Scenario Bear' }) }),
    ).not.toHaveClass(/actionable/);
  },
  'mithril-coat-attach-on-enter': async (page) => {
    await castWith(page, hand(page, 'Mithril Coat'), { resolves: /Mithril Coat[^]*resolves/ });
    // The enter trigger's only legal target is Scenario Legend.
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Legend', 'indestructible'));
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'indestructible')).toHaveCount(0);
    await expect(keywordOn(page, 'P1', 'Mithril Coat', 'indestructible')).toHaveCount(1);
  },
  'mithril-coat-choose-host': async (page) => {
    await castWith(page, hand(page, 'Mithril Coat'), { resolves: /Mithril Coat[^]*resolves/ });
    await targetAndConfirm(page, [['P1', 'Scenario Second Legend']]);
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Second Legend', 'indestructible'));
    await expect(keywordOn(page, 'P1', 'Scenario Legend', 'indestructible')).toHaveCount(0);
  },
  'mithril-coat-no-legendary-host': async (page) => {
    await castWith(page, hand(page, 'Mithril Coat'), { resolves: /Mithril Coat[^]*resolves/ });
    await passStackUntil(page, permanent(page, 'P1', 'Mithril Coat'));
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'indestructible')).toHaveCount(0);
    await expect(keywordOn(page, 'P2', 'Scenario Legend', 'indestructible')).toHaveCount(0);
  },
  'mithril-coat-flash': async (page) => {
    // It is P2's turn: cast Mithril Coat when P2 passes priority to you.
    await castWith(page, hand(page, 'Mithril Coat'), { resolves: /Mithril Coat[^]*resolves/ });
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Legend', 'indestructible'));
  },
  'mithril-coat-equip': async (page) => {
    const coat = permanent(page, 'P1', 'Mithril Coat');
    await passUntil(page, coat.and(page.locator('.actionable')));
    await coat.click();
    const equip = page.locator('.source-actions .source-action-row button').filter({
      hasText: /Equip/,
    });
    if ((await equip.count()) > 0) await equip.first().click();
    await targetAndConfirm(page, [['P1', 'Scenario Bear']]);
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Bear', 'indestructible'));
    await expect(keywordOn(page, 'P2', 'Scenario Ox', 'indestructible')).toHaveCount(0);
  },
  'mithril-coat-equipped-survives-destroy': async (page) => {
    await castWith(page, hand(page, 'Scenario Doom'), {
      targets: [['P1', 'Scenario Legend']],
      resolves: /Scenario Doom[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Scenario Legend')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Mithril Coat')).toHaveCount(1);
  },
  'mithril-coat-indestructible': async (page) => {
    await castWith(page, hand(page, 'Scenario Shatter'), {
      targets: [['P1', 'Mithril Coat']],
      resolves: /Scenario Shatter[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Mithril Coat')).toHaveCount(1);
  },
  'takenuma-mill-then-return-milled': async (page) => {
    await channelTakenuma(page);
    await passStackUntil(page, hand(page, 'Scenario Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Takenuma, Abandoned Mire')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
  },
  'takenuma-return-planeswalker': async (page) => {
    await channelTakenuma(page);
    await passStackUntil(page, hand(page, 'Scenario Walker'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Sorcery')).toHaveCount(1);
  },
  'takenuma-choose-among': async (page) => {
    await channelTakenuma(page);
    const ox = cardChoice(page, 'Scenario Ox', 'Return');
    await passStackUntil(page, ox);
    await ox.click();
    await passStackUntil(page, hand(page, 'Scenario Ox'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
  },
  'takenuma-legend-discount': async (page) => {
    await channelTakenuma(page);
    await passStackUntil(page, hand(page, 'Scenario Bear'));
  },
  'takenuma-no-discount': async (page) => {
    await passUntil(page, hand(page, 'Scenario Sorcery').and(page.locator('.actionable')));
    // Takenuma can be played as a land, but two Swamps do not pay for its channel ability.
    await hand(page, 'Takenuma, Abandoned Mire').click();
    await expect(
      page.locator('.source-actions .source-action-row button').filter({
        hasText: /Discard this card/,
      }),
    ).toHaveCount(0);
  },
  'takenuma-tap-for-black': async (page) => {
    await castWith(page, hand(page, 'Scenario Sorcery'), {
      resolves: /Scenario Sorcery[^]*resolves/,
    });
    await expect(life(page, 'P1')).toHaveText('41');
  },
  'takenuma-nothing-qualifies': async (page) => {
    await channelTakenuma(page);
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', 'Plains'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Sorcery')).toHaveCount(1);
    await expect(hand(page, 'Scenario Sorcery')).toHaveCount(0);
  },
  'mox-diamond-discard-land': async (page) => {
    await castMoxDiamond(page);
    const forest = cardChoice(page, 'Forest', 'Discard');
    await passStackUntil(page, forest);
    await forest.click();
    await passUntil(page, permanent(page, 'P1', 'Mox Diamond'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Forest')).toHaveCount(1);
    await castWith(page, hand(page, 'Scenario Imp'), { resolves: /Scenario Imp[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Imp')).toHaveCount(1);
  },
  'mox-diamond-decline': async (page) => {
    await castMoxDiamond(page);
    const nothing = page.getByRole('button', { name: /^Discard nothing/ });
    await passStackUntil(page, nothing);
    await nothing.click();
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Mox Diamond'));
    await expect(permanent(page, 'P1', 'Mox Diamond')).toHaveCount(0);
    await expect(hand(page, 'Forest')).toHaveCount(1);
  },
  'mox-diamond-no-land': async (page) => {
    await castMoxDiamond(page);
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Mox Diamond'));
    await expect(hand(page, 'Scenario Bear')).toHaveCount(1);
  },
  'mox-diamond-choose-land': async (page) => {
    await castMoxDiamond(page);
    const island = cardChoice(page, 'Island', 'Discard');
    await passStackUntil(page, island);
    await island.click();
    await passUntil(page, permanent(page, 'P1', 'Mox Diamond'));
    await expect(hand(page, 'Forest')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Island')).toHaveCount(1);
  },
  'mox-diamond-returned-by-effect': async (page) => {
    const recall = hand(page, 'Scenario Recall');
    await passUntil(page, recall.and(page.locator('.actionable')));
    await recall.click();
    const mox = seatZone(page, 'P1', 'Graveyard')
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Mox Diamond' }) })
      .first();
    await mox.click();
    await confirmButton(page).click();
    const forest = cardChoice(page, 'Forest', 'Discard');
    await passStackUntil(page, forest);
    await forest.click();
    await passUntil(page, permanent(page, 'P1', 'Mox Diamond'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Forest')).toHaveCount(1);
  },
  'everflowing-chalice-kicked-twice': async (page) => {
    await castWith(page, hand(page, 'Everflowing Chalice'), {
      mode: /kicker 2/,
      resolves: /Everflowing Chalice[^]*resolves/,
    });
    const chalice = permanent(page, 'P1', 'Everflowing Chalice');
    await expect(chalice.locator('.counters')).toContainText(/charge.*2/i);
    // Every Forest paid for the kicker; only Chalice's {C}{C} can pay for the Ox.
    await castWith(page, hand(page, 'Scenario Ox'), { resolves: /Scenario Ox[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Ox')).toHaveCount(1);
    await expect(chalice.locator('.tap-badge')).toHaveCount(1);
  },
  'everflowing-chalice-kicked-once': async (page) => {
    await castWith(page, hand(page, 'Everflowing Chalice'), {
      mode: /kicker 1/,
      resolves: /Everflowing Chalice[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Everflowing Chalice').locator('.counters')).toContainText(
      /charge.*1/i,
    );
  },
  'everflowing-chalice-unkicked': async (page) => {
    await castWith(page, hand(page, 'Everflowing Chalice'), {
      resolves: /Everflowing Chalice[^]*resolves/,
    });
    const chalice = permanent(page, 'P1', 'Everflowing Chalice');
    await expect(chalice).toHaveCount(1);
    await expect(chalice.locator('.counters')).toHaveCount(0);
    await expect(hand(page, 'Scenario Ox')).not.toHaveClass(/actionable/);
  },
  'sylvan-library-keep-both': async (page) => {
    await useSylvanLibrary(page);
    await chooseDrawn(page, ['Scenario Bear', 'Scenario Cat']);
    await answerSylvan(page, /^Pay 4 life: keep Scenario Bear/);
    await answerSylvan(page, /^Pay 4 life: keep Scenario Cat/);
    await expect(life(page, 'P1')).toHaveText('32');
    for (const name of ['Scenario Ant', 'Scenario Bear', 'Scenario Cat'])
      await expect(hand(page, name)).toHaveCount(1);
  },
  'sylvan-library-put-back-both': async (page) => {
    await useSylvanLibrary(page);
    await chooseDrawn(page, ['Scenario Ant', 'Scenario Cat']);
    await answerSylvan(page, /^Put Scenario Ant on top/);
    await answerSylvan(page, /^Put Scenario Cat on top/);
    await expect(hand(page, 'Scenario Ant')).toHaveCount(0);
    await expect(hand(page, 'Scenario Cat')).toHaveCount(0);
    await expect(hand(page, 'Scenario Bear')).toHaveCount(1);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'sylvan-library-pay-one': async (page) => {
    await useSylvanLibrary(page);
    await chooseDrawn(page, ['Scenario Ant', 'Scenario Bear']);
    await answerSylvan(page, /^Pay 4 life: keep Scenario Ant/);
    await answerSylvan(page, /^Put Scenario Bear on top/);
    await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
    await expect(life(page, 'P1')).toHaveText('36');
  },
  'sylvan-library-decline': async (page) => {
    const no = page.getByRole('button', { name: 'No', exact: true });
    await passUntil(page, no);
    await no.click();
    await passUntil(page, hand(page, 'Scenario Ant'));
    await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'sylvan-library-low-life': async (page) => {
    await useSylvanLibrary(page);
    await chooseDrawn(page, ['Scenario Bear', 'Scenario Cat']);
    // At 3 life there is nothing to pay with: both go back without a question.
    await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
    await expect(hand(page, 'Scenario Cat')).toHaveCount(0);
    await expect(life(page, 'P1')).toHaveText('3');
  },
  'sylvan-library-old-card-kept': async (page) => {
    await useSylvanLibrary(page);
    await passUntil(page, cardChoice(page, 'Scenario Ant', 'Choose'));
    await expect(cardChoice(page, 'Scenario Old Card', 'Choose')).toHaveCount(0);
    await chooseDrawn(page, ['Scenario Ant', 'Scenario Bear']);
    await answerSylvan(page, /^Put Scenario Ant on top/);
    await answerSylvan(page, /^Put Scenario Bear on top/);
    await expect(hand(page, 'Scenario Old Card')).toHaveCount(1);
    await expect(hand(page, 'Scenario Cat')).toHaveCount(1);
  },
  'sylvan-library-opponent-draw-step': async (page) => {
    // P1's turn ends and P2's runs through its draw step; P1 is never asked about the Library.
    await passUntil(page, logLine(page, /turn 5 — P2/));
    await passUntil(page, logLine(page, /game over/));
    await expect(page.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(0);
  },
  'bowmasters-enters-ping': async (page) => {
    await castWith(page, hand(page, 'Orcish Bowmasters'), {
      resolves: /Orcish Bowmasters[^]*resolves/,
    });
    await bowmastersTarget(page, ['P2', 'Scenario Elf']);
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '1/1' }));
    await expect(permanent(page, 'P2', 'Scenario Elf')).toHaveCount(0);
  },
  'bowmasters-flash': async (page) => {
    // It is P2's turn: cast Bowmasters when P2 passes priority to you.
    await castWith(page, hand(page, 'Orcish Bowmasters'), {
      resolves: /Orcish Bowmasters[^]*resolves/,
    });
    await bowmastersTarget(page, 'P2');
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '1/1' }));
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'bowmasters-opponent-draws': async (page) => {
    await bowmastersTarget(page, 'P2');
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '1/1' }));
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'bowmasters-draws-two': async (page) => {
    const order = page
      .locator('.decision-panel')
      .getByRole('button', { name: /Orcish Bowmasters/ })
      .first();
    await passUntil(page, order);
    await order.click();
    await bowmastersTarget(page, 'P2');
    await bowmastersTarget(page, 'P2');
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '2/2' }));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(permanent(page, 'P1', 'Orc Army')).toHaveCount(1);
  },
  'bowmasters-first-draw-exempt': async (page) => {
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('40');
    await expect(permanent(page, 'P1', 'Orc Army')).toHaveCount(0);
  },
  'bowmasters-own-draw': async (page) => {
    await castWith(page, hand(page, 'Scenario Insight'), {
      resolves: /Scenario Insight[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(page.getByText(/Target 1 of 1/)).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Orc Army')).toHaveCount(0);
  },
  'bowmasters-existing-army': async (page) => {
    await castWith(page, hand(page, 'Orcish Bowmasters'), {
      resolves: /Orcish Bowmasters[^]*resolves/,
    });
    await bowmastersTarget(page, 'P2');
    await passStackUntil(
      page,
      permanent(page, 'P1', 'Scenario Zombie Army').filter({ hasText: '2/2' }),
    );
    await expect(permanent(page, 'P1', 'Orc Army')).toHaveCount(0);
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'manufactor-treasure': async (page) => {
    await castForTokens(page, 'Scenario Hoard');
    for (const kind of ['Clue', 'Food', 'Treasure']) await expectTokens(page, 'P1', kind, 1);
  },
  'manufactor-food': async (page) => {
    await castForTokens(page, 'Scenario Picnic');
    for (const kind of ['Clue', 'Food', 'Treasure']) await expectTokens(page, 'P1', kind, 1);
  },
  'manufactor-two-treasures': async (page) => {
    await castForTokens(page, 'Scenario Twin Hoard');
    for (const kind of ['Clue', 'Food', 'Treasure']) await expectTokens(page, 'P1', kind, 2);
  },
  'manufactor-two-manufactors': async (page) => {
    await castForTokens(page, 'Scenario Hoard');
    for (const kind of ['Clue', 'Food', 'Treasure']) await expectTokens(page, 'P1', kind, 3);
  },
  'manufactor-other-token': async (page) => {
    await castForTokens(page, 'Scenario Muster');
    await expectTokens(page, 'P1', 'Soldier', 1);
    for (const kind of ['Clue', 'Food', 'Treasure'])
      await expect(permanent(page, 'P1', kind)).toHaveCount(0);
  },
  'manufactor-opponent-treasure': async (page) => {
    await passUntil(page, permanent(page, 'P2', 'Treasure'));
    await passUntil(page, logLine(page, /game over/));
    for (const kind of ['Clue', 'Food']) await expect(permanent(page, 'P2', kind)).toHaveCount(0);
    for (const kind of ['Clue', 'Food', 'Treasure'])
      await expect(permanent(page, 'P1', kind)).toHaveCount(0);
  },
  'manufactor-crack-clue': async (page) => {
    await castForTokens(page, 'Scenario Hoard');
    await activate(page, permanent(page, 'P1', 'Clue'), /Draw a card/);
    await passStackUntil(page, logLine(page, /Clue[^]*resolves/));
    await expect(permanent(page, 'P1', 'Clue')).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'inspiring-call-two-countered': async (page) => {
    await castWith(page, hand(page, 'Inspiring Call'), { resolves: /Inspiring Call[^]*resolves/ });
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'indestructible')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Scenario Elk', 'indestructible')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Scenario Cat', 'indestructible')).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'inspiring-call-opponent-creature': async (page) => {
    await castWith(page, hand(page, 'Inspiring Call'), { resolves: /Inspiring Call[^]*resolves/ });
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'indestructible')).toHaveCount(1);
    await expect(keywordOn(page, 'P2', 'Scenario Rival', 'indestructible')).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'inspiring-call-minus-counter': async (page) => {
    await castWith(page, hand(page, 'Inspiring Call'), { resolves: /Inspiring Call[^]*resolves/ });
    await expect(keywordOn(page, 'P1', 'Scenario Elk', 'indestructible')).toHaveCount(0);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(0);
  },
  'inspiring-call-survives-wrath': async (page) => {
    await castWith(page, hand(page, 'Inspiring Call'), { resolves: /Inspiring Call[^]*resolves/ });
    await castWith(page, hand(page, 'Scenario Wrath'), { resolves: /Scenario Wrath[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Cat')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
  },
  'ragavan-hit-cast': async (page) => {
    await attack(page, [['Ragavan, Nimble Pilferer', 'P2']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P2')).toHaveText('38');
    // The exiled card is P2's, shown in P2's exile, and you may cast it.
    const spark = page
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Scenario Spark' }) })
      .first();
    await passUntil(page, spark.and(page.locator('.actionable')));
    await spark.click();
    await page.locator('.opponent[data-seat="P2"] > header').click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Scenario Spark[^]*resolves/));
    await expect(life(page, 'P2')).toHaveText('37');
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
  },
  'ragavan-blocked': async (page) => {
    await attack(page, [['Ragavan, Nimble Pilferer', 'P2']]);
    // P2, a scripted seat, blocks with Scenario Wall.
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('40');
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
  },
  'ragavan-land-exiled': async (page) => {
    await attack(page, [['Ragavan, Nimble Pilferer', 'P2']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P2')).toHaveText('38');
    const forest = page
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Forest' }) })
      .first();
    await passUntil(page, logLine(page, /game over/));
    await expect(forest.and(page.locator('.actionable'))).toHaveCount(0);
  },
  'ragavan-dash': async (page) => {
    await castWith(page, hand(page, 'Ragavan, Nimble Pilferer'), {
      mode: /dash/i,
      resolves: /Ragavan, Nimble Pilferer[^]*resolves/,
    });
    await attack(page, [['Ragavan, Nimble Pilferer', 'P2']]);
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await passUntil(page, hand(page, 'Ragavan, Nimble Pilferer'));
    await expect(permanent(page, 'P1', 'Ragavan, Nimble Pilferer')).toHaveCount(0);
  },
  'ragavan-cast-normally': async (page) => {
    // One Mountain: the dash cost is not affordable, so the plain cast is the only one.
    await castWith(page, hand(page, 'Ragavan, Nimble Pilferer'), {
      resolves: /Ragavan, Nimble Pilferer[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(page.getByRole('button', { name: /Declare attackers/ })).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Ragavan, Nimble Pilferer')).toHaveCount(1);
    await expect(life(page, 'P2')).toHaveText('40');
  },
  'chrome-mox-no-artifact-or-land': async (page) => {
    await castChromeMox(page);
    await passUntil(page, permanent(page, 'P1', 'Chrome Mox'));
    // Neither the artifact nor the land is offered: no imprint choice appears.
    await expect(cardChoice(page, 'Scenario Trinket', 'Exile')).toHaveCount(0);
    await expect(cardChoice(page, 'Mountain', 'Exile')).toHaveCount(0);
    await expect(hand(page, 'Scenario Trinket')).toHaveCount(1);
  },
};

test.describe('Runner scenarios in the Card Test Lab', () => {
  for (const { id } of RUNNER_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      const flow = scenarioFlows[id];
      if (flow === undefined) throw new Error(`No viewer flow for runner scenario ${id}`);
      await runScenario(page, id);
      await flow(page);
    });
  }

  test.afterAll(() => {
    expect([...exercised].sort()).toEqual([...titles.keys()].sort());
  });
});
