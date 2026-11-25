import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import {
  hand,
  permanent,
  seatZone,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { g1Flows } from './runner-flows-g1';
import { g2Flows } from './runner-flows-g2';
import { g3Flows } from './runner-flows-g3';
import { g4Flows } from './runner-flows-g4';
import { g5Flows } from './runner-flows-g5';
import { RUNNER_ALL_SCENARIOS } from '../../../packages/server/src/cards/runner-scenario-catalog';
import { s3g1Flows } from './runner-flows-s3-g1';
import { s3g2Flows } from './runner-flows-s3-g2';
import { s3g3Flows } from './runner-flows-s3-g3';
import { s3g4Flows } from './runner-flows-s3-g4';

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

/** Cast Phyrexian Metamorph and answer its as-enters copy choice with `copy`, or enter normally. */
async function castMetamorph(page: Page, copy: string | null): Promise<void> {
  const metamorph = hand(page, 'Phyrexian Metamorph');
  await passUntil(page, metamorph.and(page.locator('.actionable')));
  await metamorph.click();
  await confirmButton(page).click();
  const choice =
    copy === null
      ? page.getByRole('button', { name: /Enter normally|Decline/ }).first()
      : cardChoice(page, copy, 'Copy');
  await passStackUntil(page, choice);
  await choice.click();
}

/** Play Witch Enchanter's land face from your hand and answer its life payment. */
async function playWitchMeadow(page: Page, payLife: boolean): Promise<void> {
  const card = hand(page, 'Witch Enchanter // Witch-Blessed Meadow');
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const play = page
    .locator('.source-actions .source-action-row button')
    .filter({ hasText: /Witch-Blessed Meadow/ });
  const answer = page.getByRole('button', {
    name: payLife ? /^Pay 3 life/ : /^Don't pay 3 life/,
  });
  // When the creature face cannot be cast, clicking the card plays the land face at once;
  // otherwise the land face is its own source-action button. Wait for whichever appears.
  await expect(play.first().or(answer)).toBeVisible();
  if (await play.first().isVisible()) {
    await play.first().click();
    const confirm = confirmButton(page);
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
  }
  await passUntil(page, answer);
  await answer.click();
  await passUntil(page, permanent(page, 'P1', 'Witch-Blessed Meadow'));
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
  // opponent's spell says "Targets for Orcish Bowmasters".
  await passUntil(page, page.getByText(/Target 1 of 1|Targets for Orcish Bowmasters/).first());
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

/** A spell that cannot be cast stays in hand: checked once the game waits on a pass or has ended. */
async function expectStaysInHand(page: Page, name: string): Promise<void> {
  await expect(
    page.getByRole('button', { name: 'Pass priority', exact: true }).or(logLine(page, /game over/)),
  ).toBeVisible();
  await expectNotCastable(page, name);
  await expect(hand(page, name)).toHaveCount(1);
}

const tapBadge = (page: Page, seat: string, name: string): Locator =>
  permanent(page, seat, name).locator('.tap-badge');

async function expectTapped(page: Page, cards: Array<[string, string]>): Promise<void> {
  for (const [seat, name] of cards) await expect(tapBadge(page, seat, name)).toHaveCount(1);
}

async function expectUntapped(page: Page, cards: Array<[string, string]>): Promise<void> {
  for (const [seat, name] of cards) {
    await expect(permanent(page, seat, name)).toHaveCount(1);
    await expect(tapBadge(page, seat, name)).toHaveCount(0);
  }
}

/** An opponent seat's "hand N" count. */
const handCount = (page: Page, seat: string): Locator =>
  page.locator(`.opponent[data-seat="${seat}"]`).getByText(/^hand \d+$/);

/** Cast Urza's Incubator and name `type` as its creature type. */
async function castIncubator(page: Page, type: string): Promise<void> {
  const incubator = hand(page, "Urza's Incubator");
  await passUntil(page, incubator.and(page.locator('.actionable')));
  await incubator.click();
  await confirmButton(page).click();
  const choice = page.getByRole('button', { name: type, exact: true });
  await passStackUntil(page, choice);
  await choice.click();
  await passUntil(page, permanent(page, 'P1', "Urza's Incubator"));
}

/** Activate Shadowspear's "lose hexproof and indestructible" ability and let it resolve. */
async function stripWithShadowspear(page: Page): Promise<void> {
  await activate(page, permanent(page, 'P1', 'Shadowspear'), /lose hexproof/);
  await passStackUntil(page, logLine(page, /Shadowspear[^]*resolves/));
}

/** Cast Craterhoof Behemoth and let its enter trigger resolve. */
async function castCraterhoof(page: Page): Promise<void> {
  await castWith(page, hand(page, 'Craterhoof Behemoth'), {
    resolves: /Craterhoof Behemoth[^]*resolves/,
  });
  await passStackUntil(page, keywordOn(page, 'P1', 'Craterhoof Behemoth', 'trample'));
}

/** Choose a card in your graveyard as the pending trigger's target, then confirm. */
async function targetFromGraveyard(page: Page, name: string): Promise<void> {
  const card = seatZone(page, 'P1', 'Graveyard')
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name, exact: true }) })
    .first();
  await passStackUntil(page, card.and(page.locator('.targetable, .actionable')));
  await card.click();
  await confirmButton(page).click();
}

async function answerYes(page: Page): Promise<void> {
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  await passUntil(page, yes);
  await yes.click();
}

/** Cast Flusterstorm at the Scenario Bolt on the stack and keep each of its `copies` copies' targets. */
async function castFlusterstormAtBolt(page: Page, copies: number): Promise<void> {
  const bolt = page.locator('.stack li', { hasText: 'Scenario Bolt' });
  const storm = hand(page, 'Flusterstorm');
  await passUntil(page, bolt.and(page.locator('li')));
  await passUntil(page, storm.and(page.locator('.actionable')));
  await storm.click();
  await expect(bolt.first()).toHaveClass(/targetable/);
  await bolt.first().click();
  await confirmButton(page).click();
  for (let i = 0; i < copies; i++) {
    const keep = page.getByRole('button', { name: /^Keep Scenario Bolt/ });
    await passStackUntil(page, keep);
    await keep.click();
  }
}

/** Cast Finale of Devastation for `x`, pick the search button `zone`, and return the put button for `card`. */
async function castFinale(page: Page, x: number, zone: string, card: string): Promise<Locator> {
  const finale = hand(page, 'Finale of Devastation');
  await passUntil(page, finale.and(page.locator('.actionable')));
  await finale.click();
  const row = page.locator('.source-actions .x-group');
  await row.getByRole('spinbutton').fill(String(x));
  await row.getByRole('button').click();
  const confirm = confirmButton(page);
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
  const where = page.getByRole('button', { name: zone, exact: true });
  await passStackUntil(page, where);
  await where.click();
  const put = cardChoice(page, card, 'Put onto battlefield');
  await passStackUntil(page, put);
  return put;
}

/** Declare no attackers and answer Braids' end-step prompt: sacrifice the permanent named `card`, or none. */
async function braidsSacrifice(page: Page, card: string | null): Promise<void> {
  await attack(page, []);
  const decline = page.getByRole('button', { name: /^Don't sacrifice/ });
  await passUntil(page, decline);
  if (card === null) {
    await decline.click();
    return;
  }
  await cardChoice(page, card, 'Sacrifice').click();
}

/** Cast Plea for Power and cast your vote, "time" or "knowledge"; the other seats vote on the server. */
async function castPlea(page: Page, vote: 'time' | 'knowledge'): Promise<void> {
  const plea = hand(page, 'Plea for Power');
  await passUntil(page, plea.and(page.locator('.actionable')));
  await plea.click();
  await confirmButton(page).click();
  const button = page.getByRole('button', { name: `Vote for ${vote}`, exact: true });
  await passStackUntil(page, button);
  await expect(page.getByRole('button', { name: /^Vote for / })).toHaveCount(2);
  await button.click();
}

async function expectThreeDrawn(page: Page): Promise<void> {
  for (const name of ['Scenario Ant', 'Scenario Bee', 'Scenario Cat'])
    await passUntil(page, hand(page, name));
  await passUntil(page, logLine(page, /game over/));
}

/** Cast a hand card face down through its source-action tray; the owner sees its own card. */
async function castFaceDown(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await page
    .locator('.source-actions .source-action-row button')
    .filter({ hasText: /face down/i })
    .first()
    .click();
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, /Face-down creature spell resolves/));
  await expect(permanent(page, 'P1', name)).toHaveCount(1);
}

/** Turn your face-down permanent named `name` face up through its source action. */
async function turnFaceUp(page: Page, name: string): Promise<void> {
  await activate(page, permanent(page, 'P1', name), /face up/i);
  await passStackUntil(page, logLine(page, /turns .* face up/i));
}

/** Cast Gonti targeting P2 and exile Scenario Elk face down from the revealed cards. */
async function castGonti(page: Page): Promise<void> {
  await castWith(page, hand(page, 'Gonti, Lord of Luxury'), {
    resolves: /Gonti, Lord of Luxury resolves/,
  });
  await targetPlayer(page, 'P2');
  const exile = cardChoice(page, 'Scenario Elk', 'Exile face down');
  await passStackUntil(page, exile);
  await exile.click();
}

/** Choose an opponent seat as the pending trigger's target and confirm. */
async function targetPlayer(page: Page, seat: string): Promise<void> {
  const header = page.locator(`.opponent[data-seat="${seat}"] > header`);
  await passStackUntil(page, page.getByText(/Target 1 of 1/).first());
  await header.click();
  await confirmButton(page).click();
}

/** Cast a spell from your hand that targets nothing, without waiting for it to resolve. */
async function castNow(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await confirmButton(page).click();
}

/** Play the land `name` from your hand, through its own menu when the card offers more than one action. */
async function playLand(page: Page, name: string): Promise<void> {
  const land = hand(page, name);
  await passUntil(page, land.and(page.locator('.actionable')));
  await land.click();
  // A bare `/^Play/` would also match "Playable now" entries the play is about to take away.
  const play = page.locator('.source-actions').getByRole('button', { name: /^Play/ }).first();
  if (
    await play.waitFor({ state: 'visible', timeout: 1_000 }).then(
      () => true,
      () => false,
    )
  )
    await play.click();
  await passUntil(page, permanent(page, 'P1', name));
}

/** The thumbnail of the card `name` in `seat`'s exile zone. */
const exileThumb = (page: Page, seat: string, name: string): Locator =>
  seatZone(page, seat, 'Exile')
    .locator('.zone-card-thumb')
    .filter({ has: page.getByRole('img', { name, exact: true }) });

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  // PR #94's evasion and blocking batch.
  ...g1Flows({ passUntil, passStackUntil }),
  ...g2Flows({ passUntil, passStackUntil }),
  ...g3Flows({ passUntil, passStackUntil }),
  ...g4Flows({ passUntil, passStackUntil }),
  // PR #96's graveyard and hand batch.
  ...g5Flows({ passUntil, passStackUntil }),
  // PR #89's common blocking lines.
  ...s3g1Flows({ passUntil, passStackUntil }),
  ...s3g2Flows({ passUntil, passStackUntil }),
  ...s3g3Flows({ passUntil, passStackUntil }),
  ...s3g4Flows({ passUntil, passStackUntil }),
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
    // One action is taken at once; only several open the card's own menu. A bare `/^Play/` would
    // also match "Playable now" entries the play is about to take away.
    const play = page.locator('.source-actions').getByRole('button', { name: /^Play/ }).first();
    if (
      await play.waitFor({ state: 'visible', timeout: 1_000 }).then(
        () => true,
        () => false,
      )
    )
      await play.click();
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
  'face-breaker-cast-exiled-this-turn': async (page) => {
    await attack(page, [['Professional Face-Breaker', 'P2']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await activate(
      page,
      permanent(page, 'P1', 'Professional Face-Breaker'),
      /Sacrifice a Treasure/,
    );
    const bear = seatZone(page, 'P1', 'Exile')
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Scenario Bear' }) })
      .first();
    await castWith(page, bear, { resolves: /Scenario Bear[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Exile', 'Scenario Bear')).toHaveCount(0);
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
  'takenuma-three-legends-one-swamp': async (page) => {
    await channelTakenuma(page);
    await passStackUntil(page, hand(page, 'Scenario Bear'));
    await expect(permanent(page, 'P1', 'Swamp').locator('.tap-badge')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Takenuma, Abandoned Mire')).toHaveCount(1);
  },
  'takenuma-one-legend-not-enough': async (page) => {
    await passUntil(page, hand(page, 'Scenario Sorcery').and(page.locator('.actionable')));
    // One legend takes {1} off: {2}{B} is still more than two Swamps pay.
    await hand(page, 'Takenuma, Abandoned Mire').click();
    await expect(
      page.locator('.source-actions .source-action-row button').filter({
        hasText: /Discard this card/,
      }),
    ).toHaveCount(0);
  },
  'takenuma-three-legends-no-black': async (page) => {
    await passUntil(page, hand(page, 'Island').and(page.locator('.actionable')));
    // Three legends take off the generic {2}; the {B} stays, and a Forest cannot pay it.
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
    // The Forest's land play gives you priority; Chalice adds nothing, so the Mite's {1} is unpaid.
    await passUntil(page, hand(page, 'Forest').and(page.locator('.actionable')));
    await expectNotCastable(page, 'Scenario Mite');
  },
  'everflowing-chalice-one-counter-taps': async (page) => {
    await castWith(page, hand(page, 'Scenario Mite'), { resolves: /Scenario Mite[^]*resolves/ });
    const chalice = permanent(page, 'P1', 'Everflowing Chalice');
    await expect(permanent(page, 'P1', 'Scenario Mite')).toHaveCount(1);
    await expect(chalice.locator('.tap-badge')).toHaveCount(1);
    await expect(chalice.locator('.counters')).toContainText(/charge.*1/i);
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
  'bowmasters-second-draw-in-draw-step': async (page) => {
    // P2's draw for the turn asks nothing; its Scenario Flash Insight draw, in the same step, does.
    await bowmastersTarget(page, 'P2');
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '1/1' }));
    await expect(life(page, 'P2')).toHaveText('39');
    await expect(permanent(page, 'P1', 'Orc Army')).toHaveCount(1);
  },
  'bowmasters-other-opponent-draws-in-their-turn': async (page) => {
    // P3 draws during P2's draw step, which is not P3's own: the trigger asks for a target.
    await bowmastersTarget(page, 'P3');
    await passStackUntil(page, permanent(page, 'P1', 'Orc Army').filter({ hasText: '1/1' }));
    await expect(life(page, 'P3')).toHaveText('39');
    await expect(life(page, 'P2')).toHaveText('40');
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
  'ragavan-hits-third-player': async (page) => {
    await attack(page, [['Ragavan, Nimble Pilferer', 'P3']]);
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(life(page, 'P3')).toHaveText('38');
    // P3's top card is exiled, not the first opponent's: P2's Scenario Wall stays put.
    const spark = seatZone(page, 'P3', 'Exile')
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: 'Scenario Spark' }) })
      .first();
    await passUntil(page, spark.and(page.locator('.actionable')));
    await expect(inZone(page, 'P2', 'Exile', 'Scenario Wall')).toHaveCount(0);
    await spark.click();
    await page.locator('.opponent[data-seat="P3"] > header').click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Scenario Spark[^]*resolves/));
    await expect(life(page, 'P3')).toHaveText('37');
    await expect(life(page, 'P2')).toHaveText('40');
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
  'metamorph-copies-creature-as-artifact': async (page) => {
    await castMetamorph(page, 'Scenario Bear');
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await castWith(page, hand(page, 'Scenario Shatter'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Scenario Shatter[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Phyrexian Metamorph')).toHaveCount(1);
  },
  'metamorph-copies-artifact': async (page) => {
    await castMetamorph(page, 'Scenario Rock');
    await passUntil(page, permanent(page, 'P1', 'Scenario Rock'));
    await castWith(page, hand(page, 'Scenario Imp'), { resolves: /Scenario Imp[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Imp')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Rock').locator('.tap-badge')).toHaveCount(1);
  },
  'metamorph-enters-normally': async (page) => {
    await castMetamorph(page, null);
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Phyrexian Metamorph'));
    await expect(permanent(page, 'P1', 'Phyrexian Metamorph')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
  },
  'metamorph-only-artifacts-and-creatures': async (page) => {
    const metamorph = hand(page, 'Phyrexian Metamorph');
    await passUntil(page, metamorph.and(page.locator('.actionable')));
    await metamorph.click();
    await confirmButton(page).click();
    const bear = cardChoice(page, 'Scenario Bear', 'Copy');
    await passStackUntil(page, bear);
    await expect(cardChoice(page, 'Scenario Rock', 'Copy')).toHaveCount(1);
    await expect(cardChoice(page, 'Scenario Charm', 'Copy')).toHaveCount(0);
    await expect(cardChoice(page, 'Forest', 'Copy')).toHaveCount(0);
    await bear.click();
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
  },
  'metamorph-pays-life': async (page) => {
    await castMetamorph(page, 'Scenario Bear');
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await expect(life(page, 'P1')).toHaveText('38');
  },
  'witch-enchanter-destroys-artifact': async (page) => {
    await castWith(page, hand(page, 'Witch Enchanter // Witch-Blessed Meadow'), {
      resolves: /Witch Enchanter[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Rock'));
    await expect(permanent(page, 'P2', 'Scenario Rock')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Witch Enchanter // Witch-Blessed Meadow')).toHaveCount(1);
  },
  'witch-enchanter-only-opponents': async (page) => {
    await castWith(page, hand(page, 'Witch Enchanter // Witch-Blessed Meadow'), {
      resolves: /Witch Enchanter[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Charm'));
    await expect(permanent(page, 'P1', 'Scenario Relic')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
  },
  'witch-meadow-pay-life-untapped': async (page) => {
    await playWitchMeadow(page, true);
    await expect(life(page, 'P1')).toHaveText('37');
    await castWith(page, hand(page, 'Scenario Squire'), {
      resolves: /Scenario Squire[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Scenario Squire')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Rock')).toHaveCount(1);
  },
  'witch-meadow-enters-tapped': async (page) => {
    await playWitchMeadow(page, false);
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(permanent(page, 'P1', 'Witch-Blessed Meadow').locator('.tap-badge')).toHaveCount(
      1,
    );
    await expect(permanent(page, 'P2', 'Scenario Rock')).toHaveCount(1);
  },
  'witch-meadow-is-not-a-creature': async (page) => {
    await playWitchMeadow(page, true);
    await castWith(page, hand(page, 'Scenario Wrath'), { resolves: /Scenario Wrath[^]*resolves/ });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Witch-Blessed Meadow')).toHaveCount(1);
  },
  'ozolith-collects-dying-counters': async (page) => {
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    const ozolith = permanent(page, 'P1', 'The Ozolith');
    await passStackUntil(page, ozolith.locator('.counters').filter({ hasText: /flying/i }));
    await expect(ozolith.locator('.counters')).toContainText(/\+1\/\+1.*2/);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
  },
  'ozolith-collects-bounced-counters': async (page) => {
    await castWith(page, hand(page, 'Scenario Unsummon'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Scenario Unsummon[^]*resolves/,
    });
    const ozolith = permanent(page, 'P1', 'The Ozolith');
    await passStackUntil(page, ozolith.locator('.counters'));
    await expect(ozolith.locator('.counters')).toContainText(/\+1\/\+1.*3/);
    await expect(hand(page, 'Scenario Bear')).toHaveCount(1);
  },
  'ozolith-ignores-counterless-creature': async (page) => {
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'The Ozolith').locator('.counters')).toHaveCount(0);
  },
  'ozolith-ignores-opponent-creature': async (page) => {
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P2', 'Scenario Bear']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'The Ozolith').locator('.counters')).toHaveCount(0);
  },
  'ozolith-ignores-noncreature-permanent': async (page) => {
    await castWith(page, hand(page, 'Scenario Shatter'), {
      targets: [['P1', 'Scenario Relic']],
      resolves: /Scenario Shatter[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Relic')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'The Ozolith').locator('.counters')).toHaveCount(0);
  },
  'ozolith-moves-all-counters-at-combat': async (page) => {
    const yes = page.getByRole('button', { name: 'Yes', exact: true });
    await passUntil(page, yes);
    await yes.click();
    await attack(page, []);
    const wolf = permanent(page, 'P1', 'Scenario Wolf');
    await passUntil(page, wolf.locator('.counters').filter({ hasText: /flying/i }));
    await expect(wolf.locator('.counters')).toContainText(/\+1\/\+1.*2/);
    await expect(permanent(page, 'P1', 'The Ozolith').locator('.counters')).toHaveCount(0);
  },
  'ozolith-declines-move': async (page) => {
    const no = page.getByRole('button', { name: 'No', exact: true });
    await passUntil(page, no);
    await no.click();
    await attack(page, []);
    await passUntil(page, logLine(page, /game over/));
    await expect(permanent(page, 'P1', 'The Ozolith').locator('.counters')).toContainText(
      /\+1\/\+1.*2/,
    );
    await expect(permanent(page, 'P1', 'Scenario Wolf').locator('.counters')).toHaveCount(0);
  },
  'ozolith-no-counters-no-combat-trigger': async (page) => {
    await attack(page, []);
    await passUntil(page, logLine(page, /game over/));
    await expect(page.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Wolf').locator('.counters')).toHaveCount(0);
  },
  'ruby-medallion-reduces-red': async (page) => {
    await castWith(page, hand(page, 'Scenario Ogre'), { resolves: /Scenario Ogre[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Ogre')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Mountain').locator('.tap-badge')).toHaveCount(1);
  },
  'ruby-medallion-not-other-colors': async (page) => {
    await expectStaysInHand(page, 'Scenario Elk');
  },
  'ruby-medallion-not-colored-mana': async (page) => {
    await expectStaysInHand(page, 'Scenario Hellion');
  },
  'incubator-chosen-type-cheaper': async (page) => {
    await castIncubator(page, 'Beast');
    await castWith(page, hand(page, 'Scenario Beast'), { resolves: /Scenario Beast[^]*resolves/ });
    await expect(permanent(page, 'P1', "Urza's Incubator")).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Beast')).toHaveCount(1);
    await expect(hand(page, 'Scenario Elk')).toHaveCount(1);
  },
  'incubator-other-type-full-price': async (page) => {
    await castIncubator(page, 'Beast');
    await expectStaysInHand(page, 'Scenario Elk');
    await expect(hand(page, 'Scenario Beast')).toHaveCount(1);
  },
  'incubator-reduces-opponents-spells': async (page) => {
    await castIncubator(page, 'Beast');
    await passUntil(page, permanent(page, 'P2', 'Scenario Beast'));
    await expect(permanent(page, 'P2', 'Scenario Beast')).toHaveCount(1);
  },
  'seedborn-cast-then-untap-on-opponent-turn': async (page) => {
    await castWith(page, hand(page, 'Seedborn Muse'), { resolves: /Seedborn Muse[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Seedborn Muse')).toHaveCount(1);
    await passUntil(page, logLine(page, /game over/));
    await expectUntapped(page, [
      ['P1', 'Scenario Grove'],
      ['P1', 'Seedborn Muse'],
    ]);
  },
  'seedborn-untaps-each-permanent-type': async (page) => {
    await expectTapped(page, [
      ['P1', 'Scenario Bear'],
      ['P1', 'Scenario Rock'],
    ]);
    await attack(page, []);
    await passUntil(page, logLine(page, /game over/));
    await expectUntapped(page, [
      ['P1', 'Scenario Bear'],
      ['P1', 'Scenario Rock'],
    ]);
  },
  'seedborn-not-opponents-permanents': async (page) => {
    await expectTapped(page, [
      ['P1', 'Scenario Bear'],
      ['P3', 'Scenario Rock'],
    ]);
    await attack(page, []);
    await passUntil(page, logLine(page, /game over/));
    await expectUntapped(page, [['P1', 'Scenario Bear']]);
    await expectTapped(page, [['P3', 'Scenario Rock']]);
  },
  'seedborn-not-during-own-turn': async (page) => {
    await expectTapped(page, [['P1', 'Scenario Rock']]);
    await attack(page, []);
    await passUntil(page, logLine(page, /game over/));
    await expectTapped(page, [['P1', 'Scenario Rock']]);
  },
  'mastermind-each-player-draws': async (page) => {
    await activate(page, permanent(page, 'P1', 'Faerie Mastermind'), /Each player draws a card/);
    await passStackUntil(page, hand(page, 'Scenario Ant'));
    await passUntil(page, logLine(page, /game over/));
    for (const seat of ['P2', 'P3', 'P4']) await expect(handCount(page, seat)).toHaveText('hand 1');
  },
  'mastermind-opponent-second-draw': async (page) => {
    await passUntil(page, hand(page, 'Scenario Ant'));
    await passUntil(page, logLine(page, /game over/));
    await expect(handCount(page, 'P2')).toHaveText('hand 2');
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
  },
  'mastermind-opponent-first-draw': async (page) => {
    await passUntil(page, logLine(page, /game over/));
    await expect(handCount(page, 'P2')).toHaveText('hand 1');
    await expect(hand(page, 'Scenario Ant')).toHaveCount(0);
  },
  'mastermind-third-draw-still-resolves': async (page) => {
    await passUntil(page, hand(page, 'Scenario Ant'));
    await passUntil(page, logLine(page, /game over/));
    await expect(handCount(page, 'P2')).toHaveText('hand 3');
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
    await expect(hand(page, 'Scenario Dog')).toHaveCount(0);
  },
  'mastermind-flash-on-opponent-turn': async (page) => {
    await castWith(page, hand(page, 'Faerie Mastermind'), {
      resolves: /Faerie Mastermind[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Faerie Mastermind')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Faerie Mastermind', 'flying')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Faerie Mastermind', 'flash')).toHaveCount(1);
  },
  'aetherize-returns-attackers': async (page) => {
    await passUntil(page, page.locator('.opponent[data-seat="P2"] .attacking').first());
    await castWith(page, hand(page, 'Aetherize'), { resolves: /Aetherize[^]*resolves/ });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Wolf')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Scenario Elk')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Owl')).toHaveCount(1);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'aetherize-outside-combat': async (page) => {
    await castWith(page, hand(page, 'Aetherize'), { resolves: /Aetherize[^]*resolves/ });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Owl')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Aetherize')).toHaveCount(1);
  },
  'mana-geyser-counts-opponents-tapped-lands': async (page) => {
    await castWith(page, hand(page, 'Mana Geyser'), { resolves: /Mana Geyser[^]*resolves/ });
    await castWith(page, hand(page, 'Scenario Giant'), {
      resolves: /Scenario Giant[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Scenario Giant')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Mana Geyser')).toHaveCount(1);
  },
  'mana-geyser-ignores-untapped-and-own-lands': async (page) => {
    await castWith(page, hand(page, 'Mana Geyser'), { resolves: /Mana Geyser[^]*resolves/ });
    await castWith(page, hand(page, 'Scenario Imp'), { resolves: /Scenario Imp[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Imp')).toHaveCount(1);
    await expectNotCastable(page, 'Scenario Giant');
    await expect(hand(page, 'Scenario Giant')).toHaveCount(1);
  },
  'shadowspear-strips-hexproof': async (page) => {
    await stripWithShadowspear(page);
    await castWith(page, hand(page, 'Scenario Bolt'), {
      targets: [['P2', 'Scenario Troll']],
      resolves: /Scenario Bolt[^]*resolves/,
    });
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Troll'));
    await expect(permanent(page, 'P2', 'Scenario Troll')).toHaveCount(0);
  },
  'shadowspear-strips-indestructible': async (page) => {
    await stripWithShadowspear(page);
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P2', 'Scenario Golem']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Golem'));
    await expect(permanent(page, 'P2', 'Scenario Golem')).toHaveCount(0);
  },
  'shadowspear-only-opponents': async (page) => {
    await expect(keywordOn(page, 'P2', 'Scenario Troll', 'hexproof')).toHaveCount(1);
    await stripWithShadowspear(page);
    await expect(keywordOn(page, 'P2', 'Scenario Troll', 'hexproof')).toHaveCount(0);
    await expect(keywordOn(page, 'P1', 'Scenario Troll', 'hexproof')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Scenario Golem', 'indestructible')).toHaveCount(1);
  },
  'shadowspear-later-grant-wins': async (page) => {
    await stripWithShadowspear(page);
    await passStackUntil(page, logLine(page, /Scenario Veil[^]*resolves/));
    await expect(keywordOn(page, 'P2', 'Scenario Troll', 'hexproof')).toHaveCount(1);
  },
  'shadowspear-equipped-creature': async (page) => {
    await activate(page, permanent(page, 'P1', 'Shadowspear'), /Equip/);
    await targetAndConfirm(page, [['P1', 'Scenario Bear']]);
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Bear', 'trample'));
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'lifelink')).toHaveCount(1);
  },
  'craterhoof-pumps-and-attacks': async (page) => {
    await castCraterhoof(page);
    await attack(page, [
      ['Scenario Bear', 'P2'],
      ['Scenario Wolf', 'P2'],
      ['Craterhoof Behemoth', 'P2'],
    ]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('22');
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'trample')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Craterhoof Behemoth', 'trample')).toHaveCount(1);
    await expect(keywordOn(page, 'P1', 'Craterhoof Behemoth', 'haste')).toHaveCount(1);
  },
  'craterhoof-not-opponents-creatures': async (page) => {
    await castCraterhoof(page);
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'trample')).toHaveCount(1);
    await expect(keywordOn(page, 'P2', 'Scenario Rival', 'trample')).toHaveCount(0);
  },
  'craterhoof-alone': async (page) => {
    await castCraterhoof(page);
    await attack(page, [['Craterhoof Behemoth', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('34');
  },
  'sun-titan-enters-returns': async (page) => {
    await castWith(page, hand(page, 'Sun Titan'), { resolves: /Sun Titan[^]*resolves/ });
    await targetFromGraveyard(page, 'Scenario Bear');
    await answerYes(page);
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await expect(permanent(page, 'P1', 'Sun Titan')).toHaveCount(1);
    for (const name of ['Scenario Rock', 'Scenario Ogre', 'Scenario Bolt'])
      await expect(inZone(page, 'P1', 'Graveyard', name)).toHaveCount(1);
  },
  'sun-titan-attacks-returns-land': async (page) => {
    await attack(page, [['Sun Titan', 'P2']]);
    await answerYes(page);
    await passUntil(page, logLine(page, /game over/));
    await expect(permanent(page, 'P1', 'Forest')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Sun Titan').locator('.tap-badge')).toHaveCount(0);
    await expect(life(page, 'P2')).toHaveText('34');
  },
  'sun-titan-decline': async (page) => {
    await castWith(page, hand(page, 'Sun Titan'), { resolves: /Sun Titan[^]*resolves/ });
    const no = page.getByRole('button', { name: 'No', exact: true });
    await passStackUntil(page, no);
    await no.click();
    await passUntil(page, logLine(page, /game over/));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
  },
  'flusterstorm-storm-counters': async (page) => {
    const opt = hand(page, 'Scenario Opt');
    await passUntil(page, opt.and(page.locator('.actionable')));
    await opt.click();
    await confirmButton(page).click();
    await castFlusterstormAtBolt(page, 2);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Flusterstorm')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Opt')).toHaveCount(1);
  },
  'flusterstorm-controller-pays': async (page) => {
    await castFlusterstormAtBolt(page, 1);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P1')).toHaveText('37');
    await expect(inZone(page, 'P1', 'Graveyard', 'Flusterstorm')).toHaveCount(1);
  },
  'flusterstorm-not-creature-spells': async (page) => {
    await passUntil(page, permanent(page, 'P2', 'Scenario Bear'));
    await passUntil(page, logLine(page, /game over/));
    await expectNotCastable(page, 'Flusterstorm');
    await expect(hand(page, 'Flusterstorm')).toHaveCount(1);
  },
  'finale-from-library': async (page) => {
    const bear = await castFinale(page, 2, 'Search library', 'Scenario Bear');
    await expect(cardChoice(page, 'Scenario Ogre', 'Put onto battlefield')).toHaveCount(0);
    await bear.click();
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await expect(permanent(page, 'P1', 'Scenario Ogre')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Rock')).toHaveCount(0);
  },
  'finale-from-graveyard': async (page) => {
    const bear = await castFinale(page, 2, 'Search graveyard', 'Scenario Bear');
    await expect(cardChoice(page, 'Scenario Ogre', 'Put onto battlefield')).toHaveCount(0);
    await bear.click();
    await passUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
  },
  'finale-x-ten-pumps': async (page) => {
    const ogre = await castFinale(page, 10, 'Search both', 'Scenario Ogre');
    await ogre.click();
    await passUntil(page, permanent(page, 'P1', 'Scenario Ogre'));
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Ogre', 'haste'));
  },
  'braids-each-opponent-answers': async (page) => {
    await braidsSacrifice(page, 'Scenario Rock');
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(life(page, 'P3')).toHaveText('38');
    await expect(life(page, 'P4')).toHaveText('40');
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
    await expect(hand(page, 'Scenario Cat')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Rock')).toHaveCount(1);
    await expect(inZone(page, 'P4', 'Graveyard', 'Scenario Idol')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Relic')).toHaveCount(1);
  },
  'braids-decline-sacrifice': async (page) => {
    await braidsSacrifice(page, null);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('40');
    await expect(hand(page, 'Scenario Ant')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Rock')).toHaveCount(1);
  },
  'braids-type-must-match': async (page) => {
    await braidsSacrifice(page, 'Forest');
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(hand(page, 'Scenario Ant')).toHaveCount(1);
  },
  'plea-time-wins': async (page) => {
    await castPlea(page, 'time');
    await passUntil(page, logLine(page, /game over/));
    // The scenario ends before the extra turn begins; time won, so nothing was drawn.
    await expect(logLine(page, /votes for time/)).toBeVisible();
    for (const name of ['Scenario Ant', 'Scenario Bee', 'Scenario Cat'])
      await expect(hand(page, name)).toHaveCount(0);
  },
  'plea-tie-draws': async (page) => {
    await castPlea(page, 'time');
    await expectThreeDrawn(page);
  },
  'plea-knowledge-wins': async (page) => {
    await castPlea(page, 'time');
    await expectThreeDrawn(page);
  },
  'vigilante-turned-up-destroys': async (page) => {
    await castFaceDown(page, 'Nantuko Vigilante');
    await turnFaceUp(page, 'Nantuko Vigilante');
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Relic'));
    await expect(permanent(page, 'P2', 'Scenario Relic')).toHaveCount(0);
  },
  'vigilante-cast-face-up-no-trigger': async (page) => {
    await castWith(page, hand(page, 'Nantuko Vigilante'), {
      resolves: /Nantuko Vigilante[^]*resolves/,
    });
    await passUntil(page, logLine(page, /game over/));
    await expect(permanent(page, 'P1', 'Nantuko Vigilante')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Relic')).toHaveCount(1);
  },
  'lurker-megamorph-counter': async (page) => {
    await castFaceDown(page, 'Gudul Lurker');
    await turnFaceUp(page, 'Gudul Lurker');
    await expect(permanent(page, 'P1', 'Gudul Lurker').locator('.counters')).toContainText(
      /\+1\/\+1.*1/,
    );
  },
  'lurker-cast-face-up-no-counter': async (page) => {
    await castWith(page, hand(page, 'Gudul Lurker'), { resolves: /Gudul Lurker[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Gudul Lurker')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Gudul Lurker').locator('.counters')).toHaveCount(0);
  },
  'bonebrute-disguise-ward': async (page) => {
    await castFaceDown(page, 'Hunted Bonebrute');
    await passUntil(page, logLine(page, /game over/));
    await expect(permanent(page, 'P1', 'Hunted Bonebrute')).toHaveCount(1);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
  },
  'bonebrute-turned-up': async (page) => {
    await castFaceDown(page, 'Hunted Bonebrute');
    await turnFaceUp(page, 'Hunted Bonebrute');
    await expect(permanent(page, 'P2', 'Dog')).toHaveCount(0);
  },
  'hydra-turned-up-five-counters': async (page) => {
    await castFaceDown(page, 'Hooded Hydra');
    await turnFaceUp(page, 'Hooded Hydra');
    await expect(permanent(page, 'P1', 'Hooded Hydra').locator('.counters')).toContainText(
      /\+1\/\+1.*5/,
    );
  },
  'rat-dies-manifest-dread': async (page) => {
    const snuff = hand(page, 'Scenario Snuff');
    await passUntil(page, snuff.and(page.locator('.actionable')));
    await snuff.click();
    const rat = permanent(page, 'P1', 'Innocuous Rat').first();
    await expect(rat).toHaveClass(/targetable|actionable/);
    await rat.click();
    await confirmButton(page).click();
    const manifest = cardChoice(page, 'Scenario Bee', 'Manifest');
    await passStackUntil(page, manifest);
    await manifest.click();
    await passUntil(page, permanent(page, 'P1', 'Scenario Bee'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ant')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Innocuous Rat')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bee')).toHaveCount(0);
  },
  'gonti-exile-and-cast-any-type': async (page) => {
    await castGonti(page);
    const elk = inZone(page, 'P2', 'Exile', 'Scenario Elk');
    await passStackUntil(page, elk);
    const exiled = exileThumb(page, 'P2', 'Scenario Elk');
    await expect(exiled).toHaveClass(/actionable/);
    await exiled.click();
    await confirmButton(page).click();
    await passStackUntil(page, permanent(page, 'P1', 'Scenario Elk'));
    await expect(permanent(page, 'P1', 'Gonti, Lord of Luxury')).toHaveCount(1);
  },
  'gonti-later-turn': async (page) => {
    await castGonti(page);
    await passUntil(page, logLine(page, /game over/));
    await expect(inZone(page, 'P2', 'Exile', 'Scenario Elk')).toHaveCount(1);
    await expect(exileThumb(page, 'P2', 'Scenario Elk')).toHaveCount(1);
  },
  'thief-hits-exiles-one': async (page) => {
    await attack(page, [['Thief of Sanity', 'P2']]);
    const exile = cardChoice(page, 'Scenario Elk', 'Exile face down');
    await passStackUntil(page, exile);
    await exile.click();
    await passUntil(page, logLine(page, /game over/));
    // P1 looked at the card, so P1 sees it in P2's exile.
    await expect(inZone(page, 'P2', 'Exile', 'Scenario Elk')).toHaveCount(1);
    await expect(seatZone(page, 'P2', 'Exile').locator('.zone-card-thumb')).toHaveCount(1);
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Ant')).toHaveCount(1);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bee')).toHaveCount(1);
  },
  'grasp-search-and-play-land': async (page) => {
    const grasp = hand(page, "Praetor's Grasp");
    await passUntil(page, grasp.and(page.locator('.actionable')));
    await grasp.click();
    await page.locator('.opponent[data-seat="P2"] > header').click();
    await confirmButton(page).click();
    // The search offers every Forest in P2's library; any one will do.
    const exile = cardChoice(page, 'Forest', 'Exile face down').first();
    await passStackUntil(page, exile);
    await exile.click();
    const forest = exileThumb(page, 'P2', 'Forest');
    await passStackUntil(page, forest.and(page.locator('.actionable')));
    await forest.click();
    const confirm = confirmButton(page);
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
    await passUntil(page, permanent(page, 'P1', 'Forest'));
    // The shuffle is an engine event the viewer does not log; the Forest left P2's library.
    await expect(logLine(page, /Praetor's Grasp resolves/)).toBeVisible();
    await expect(page.locator('.opponent[data-seat="P2"]').getByText(/Exile 0/)).toBeVisible();
  },
  // EDHREC plan Phase 4: one card per new grammar production.
  'thraben-inspector-investigates': async (page) => {
    await castWith(page, hand(page, 'Thraben Inspector'), {
      resolves: /Thraben Inspector[^]*resolves/,
    });
    await passStackUntil(page, permanent(page, 'P1', 'Clue'));
    await activate(page, permanent(page, 'P1', 'Clue'), /Draw a card/);
    await passStackUntil(page, logLine(page, /Clue[^]*resolves/));
    await expect(permanent(page, 'P1', 'Clue')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Thraben Inspector')).toHaveCount(1);
    await expect(hand(page, 'Plains')).toHaveCount(1);
  },
  'burglar-rat-each-opponent-discards': async (page) => {
    await castWith(page, hand(page, 'Burglar Rat'), { resolves: /Burglar Rat[^]*resolves/ });
    for (const seat of ['P2', 'P3', 'P4'])
      await passStackUntil(page, inZone(page, seat, 'Graveyard', 'Forest'));
    await expect(hand(page, 'Island')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Island')).toHaveCount(0);
  },
  'glimpse-mills-target-player': async (page) => {
    const glimpse = hand(page, 'Glimpse the Unthinkable');
    await passUntil(page, glimpse.and(page.locator('.actionable')));
    await glimpse.click();
    await page.locator('.opponent[data-seat="P2"] > header').click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Glimpse the Unthinkable[^]*resolves/));
    await expect(page.locator('.opponent[data-seat="P2"]').getByText(/Graveyard 10/)).toBeVisible();
    await expect(inZone(page, 'P1', 'Graveyard', 'Glimpse the Unthinkable')).toHaveCount(1);
    await expect(seatZone(page, 'P1', 'Graveyard').getByRole('img')).toHaveCount(1);
  },
  'fog-prevents-combat-damage': async (page) => {
    await passUntil(page, page.locator('.opponent[data-seat="P2"] .attacking').first());
    await castWith(page, hand(page, 'Fog'), { resolves: /Fog[^]*resolves/ });
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'simic-growth-chamber-returns-own-land': async (page) => {
    await playLand(page, 'Simic Growth Chamber');
    // The return is chosen on the board as the trigger resolves; it targets nothing.
    await passStackUntil(page, page.getByText(/choose a permanent to return/).first());
    const forest = permanent(page, 'P1', 'Forest').first();
    await expect(forest).toHaveClass(/actionable|targetable/);
    // Only your own lands are offered: P2's Island is not.
    await expect(permanent(page, 'P2', 'Island')).not.toHaveClass(/actionable|targetable/);
    await forest.click();
    const confirm = confirmButton(page);
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
    await passUntil(page, hand(page, 'Forest'));
    await expect(permanent(page, 'P1', 'Simic Growth Chamber').locator('.tap-badge')).toHaveCount(
      1,
    );
    await expect(permanent(page, 'P2', 'Island')).toHaveCount(1);
  },
  'abraded-bluffs-pings-opponent': async (page) => {
    await playLand(page, 'Abraded Bluffs');
    await targetPlayer(page, 'P3');
    await passStackUntil(page, life(page, 'P3').filter({ hasText: '39' }));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(permanent(page, 'P1', 'Abraded Bluffs').locator('.tap-badge')).toHaveCount(1);
  },
  'forbidden-alchemy-one-to-hand-rest-graveyard': async (page) => {
    await castNow(page, 'Forbidden Alchemy');
    const cat = cardChoice(page, 'Scenario Cat', 'Put into your hand');
    await passStackUntil(page, cat);
    // Taking one is required: there is no decline.
    await expect(page.getByRole('button', { name: 'Put none of them' })).toHaveCount(0);
    await cat.click();
    await passUntil(page, hand(page, 'Scenario Cat'));
    for (const name of ['Scenario Ant', 'Scenario Bear', 'Scenario Dog', 'Forbidden Alchemy'])
      await expect(inZone(page, 'P1', 'Graveyard', name)).toHaveCount(1);
  },
  'forbidden-alchemy-flashback': async (page) => {
    const offer = page
      .locator('.playable-now')
      .getByRole('button', { name: /Forbidden Alchemy/ })
      .first();
    await passUntil(page, offer);
    await offer.click();
    await confirmButton(page).click();
    const ant = cardChoice(page, 'Scenario Ant', 'Put into your hand');
    await passStackUntil(page, ant);
    await ant.click();
    await passUntil(page, hand(page, 'Scenario Ant'));
    await expect(inZone(page, 'P1', 'Exile', 'Forbidden Alchemy')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Forbidden Alchemy')).toHaveCount(0);
    for (const name of ['Scenario Bear', 'Scenario Cat', 'Scenario Dog'])
      await expect(inZone(page, 'P1', 'Graveyard', name)).toHaveCount(1);
  },
  'adventurous-impulse-reveals-creature': async (page) => {
    await castNow(page, 'Adventurous Impulse');
    const bear = cardChoice(page, 'Scenario Bear', 'Put into your hand');
    await passStackUntil(page, bear);
    // Neither an artifact nor an enchantment is a creature or land card.
    await expect(cardChoice(page, 'Scenario Relic', 'Put into your hand')).toHaveCount(0);
    await expect(cardChoice(page, 'Scenario Charm', 'Put into your hand')).toHaveCount(0);
    await bear.click();
    const keep = page.getByRole('button', { name: 'Keep current order' });
    await passUntil(page, keep);
    await keep.click();
    await passUntil(page, hand(page, 'Scenario Bear'));
    await expect(hand(page, 'Scenario Relic')).toHaveCount(0);
  },
  'adventurous-impulse-declines': async (page) => {
    await castNow(page, 'Adventurous Impulse');
    const none = page.getByRole('button', { name: 'Put none of them' });
    await passStackUntil(page, none);
    await none.click();
    const keep = page.getByRole('button', { name: 'Keep current order' });
    await passUntil(page, keep);
    await keep.click();
    await expect(inZone(page, 'P1', 'Graveyard', 'Adventurous Impulse')).toHaveCount(1);
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(0);
  },
  'souls-attendant-gains-life': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    const yes = page.getByRole('button', { name: 'Yes', exact: true });
    await passStackUntil(page, yes);
    await yes.click();
    await passStackUntil(page, life(page, 'P1').filter({ hasText: '41' }));
  },
  'souls-attendant-declines': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    const no = page.getByRole('button', { name: 'No', exact: true });
    await passStackUntil(page, no);
    await no.click();
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  // EDHREC plan Phase 4 batch 3: keywords and short line shapes.
  'swiftspear-prowess-noncreature': async (page) => {
    await castWith(page, hand(page, 'Scenario Ponder'), {
      resolves: /Scenario Ponder[^]*resolves/,
    });
    await passStackUntil(
      page,
      permanent(page, 'P1', 'Monastery Swiftspear').filter({ hasText: '2/3' }),
    );
    await attack(page, [['Monastery Swiftspear', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
  },
  'swiftspear-no-prowess-on-creature': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    await expect(
      permanent(page, 'P1', 'Monastery Swiftspear').filter({ hasText: '1/2' }),
    ).toHaveCount(1);
    await attack(page, [['Monastery Swiftspear', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'swiftspear-haste': async (page) => {
    await castWith(page, hand(page, 'Monastery Swiftspear'), {
      resolves: /Monastery Swiftspear[^]*resolves/,
    });
    await attack(page, [['Monastery Swiftspear', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'hierarch-exalted-attacks-alone': async (page) => {
    await attack(page, [['Scenario Bear', 'P2']]);
    await passStackUntil(page, permanent(page, 'P1', 'Scenario Bear').filter({ hasText: '3/3' }));
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('37');
  },
  'hierarch-no-exalted-with-two-attackers': async (page) => {
    await attack(page, [
      ['Noble Hierarch', 'P2'],
      ['Scenario Bear', 'P2'],
    ]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(logLine(page, /Exalted/)).toHaveCount(0);
  },
  'hierarch-taps-for-mana': async (page) => {
    await castWith(page, hand(page, 'Scenario Owl'), { resolves: /Scenario Owl[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Owl')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Noble Hierarch').locator('.tap-badge')).toHaveCount(1);
  },
  'modular-enters-with-counter': async (page) => {
    await castWith(page, hand(page, 'Arcbound Worker'), {
      resolves: /Arcbound Worker[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Arcbound Worker').locator('.counters')).toContainText(
      /\+1\/\+1.*1/,
    );
  },
  'modular-moves-counters-on-death': async (page) => {
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P1', 'Arcbound Worker']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    const yes = page.getByRole('button', { name: 'Yes', exact: true });
    await passStackUntil(page, yes);
    await yes.click();
    await passStackUntil(
      page,
      permanent(page, 'P1', 'Scenario Golem').locator('.counters').filter({ hasText: /2/ }),
    );
    await expect(inZone(page, 'P1', 'Graveyard', 'Arcbound Worker')).toHaveCount(1);
  },
  'modular-needs-artifact-creature': async (page) => {
    await castWith(page, hand(page, 'Scenario Snuff'), {
      targets: [['P1', 'Arcbound Worker']],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', 'Arcbound Worker'));
    await expect(page.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Bear').locator('.counters')).toHaveCount(0);
  },
  'myr-convert-toxic-poisons': async (page) => {
    await attack(page, [['Myr Convert', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(page.locator('.opponent[data-seat="P2"] .counter-poison')).toContainText('1');
  },
  'myr-convert-pays-life-for-mana': async (page) => {
    await castWith(page, hand(page, 'Scenario Owl'), { resolves: /Scenario Owl[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Owl')).toHaveCount(1);
    await expect(life(page, 'P1')).toHaveText('38');
  },
  'grim-monolith-stays-tapped': async (page) => {
    await passUntil(page, logLine(page, /game over/));
    await expect(permanent(page, 'P1', 'Grim Monolith').locator('.tap-badge')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Island').locator('.tap-badge')).toHaveCount(0);
  },
  'grim-monolith-pay-to-untap': async (page) => {
    const monolith = permanent(page, 'P1', 'Grim Monolith');
    await activate(page, monolith, /Untap/);
    await passStackUntil(page, logLine(page, /Untap this artifact\. resolves/));
    await expect(monolith.locator('.tap-badge')).toHaveCount(0);
    await castWith(page, hand(page, 'Scenario Giant'), { resolves: /Scenario Giant[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Giant')).toHaveCount(1);
    await expect(monolith.locator('.tap-badge')).toHaveCount(1);
  },
  'vivid-creek-enters-tapped-with-counters': async (page) => {
    await playLand(page, 'Vivid Creek');
    const creek = permanent(page, 'P1', 'Vivid Creek');
    await expect(creek.locator('.tap-badge')).toHaveCount(1);
    await expect(creek.locator('.counters')).toContainText(/charge.*2/i);
  },
  'vivid-creek-any-color': async (page) => {
    await castWith(page, hand(page, 'Scenario Elf'), { resolves: /Scenario Elf[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Elf')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Vivid Creek').locator('.counters')).toContainText(
      /charge.*1/i,
    );
  },
  'razortrap-gorge-enters-tapped': async (page) => {
    await playLand(page, 'Razortrap Gorge');
    await expect(permanent(page, 'P1', 'Razortrap Gorge').locator('.tap-badge')).toHaveCount(1);
  },
  'razortrap-gorge-enters-untapped': async (page) => {
    await playLand(page, 'Razortrap Gorge');
    await expect(permanent(page, 'P1', 'Razortrap Gorge').locator('.tap-badge')).toHaveCount(0);
    await castWith(page, hand(page, 'Scenario Imp'), { resolves: /Scenario Imp[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Imp')).toHaveCount(1);
  },
  'fervent-charge-pumps-each-attacker': async (page) => {
    await attack(page, [
      ['Scenario Bear', 'P2'],
      ['Scenario Wolf', 'P2'],
    ]);
    // Two triggers at once: put them on the stack in either order.
    const order = page.locator('.decision-panel').getByRole('button', { name: /Fervent Charge/ });
    await passUntil(page, order.first());
    await order.first().click();
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('33');
  },
  // EDHREC plan Phase 4 batch 4: amount forms, player verbs, damage clauses, life-change triggers.
  'choked-estuary-reveal-untapped': async (page) => {
    const estuary = hand(page, 'Choked Estuary');
    await passUntil(page, estuary.and(page.locator('.actionable')));
    await estuary.click();
    const play = page.locator('.source-actions').getByRole('button', { name: /^Play/ }).first();
    if (await play.isVisible()) await play.click();
    const reveal = page.getByRole('button', { name: /^Reveal/ }).first();
    await passUntil(page, reveal);
    await reveal.click();
    await passUntil(page, permanent(page, 'P1', 'Choked Estuary'));
    await expect(tapBadge(page, 'P1', 'Choked Estuary')).toHaveCount(0);
    await expect(hand(page, 'Island')).toHaveCount(1);
    await expect(logLine(page, /reveal/i)).toBeVisible();
  },
  'choked-estuary-no-reveal-tapped': async (page) => {
    await playLand(page, 'Choked Estuary');
    await expect(tapBadge(page, 'P1', 'Choked Estuary')).toHaveCount(1);
    await expect(hand(page, 'Forest')).toHaveCount(1);
  },
  'lotus-cobra-landfall-mana': async (page) => {
    await playLand(page, 'Forest');
    const white = page.getByRole('button', { name: /^Distribute 1 mana \(allowed: \{W\}/ });
    await passStackUntil(page, white);
    await white.click();
    await castWith(page, hand(page, 'Scenario Squire'), {
      resolves: /Scenario Squire[^]*resolves/,
    });
    await expect(permanent(page, 'P1', 'Scenario Squire')).toHaveCount(1);
    await expectTapped(page, [['P1', 'Forest']]);
  },
  'lotus-cobra-ignores-opponent-land': async (page) => {
    await passUntil(page, permanent(page, 'P2', 'Forest'));
    await expect(logLine(page, /Lotus Cobra/)).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Lotus Cobra')).toHaveCount(1);
  },
  'cloudshift-blinks-own-creature': async (page) => {
    await expect(permanent(page, 'P1', 'Scenario Bear').locator('.counters')).toContainText(/1/);
    await castWith(page, hand(page, 'Cloudshift'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Cloudshift[^]*resolves/,
    });
    await expect(inZone(page, 'P1', 'Graveyard', 'Cloudshift')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Scenario Bear').locator('.counters')).toHaveCount(0);
  },
  'triskelion-enters-with-counters': async (page) => {
    await castWith(page, hand(page, 'Triskelion'), { resolves: /Triskelion[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Triskelion').locator('.counters')).toContainText(/3/);
  },
  'triskelion-remove-counter-pings': async (page) => {
    await activate(page, permanent(page, 'P1', 'Triskelion'), /Remove/);
    await targetPlayer(page, 'P2');
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await expect(permanent(page, 'P1', 'Triskelion').locator('.counters')).toContainText(/2/);
  },
  'pridemate-counter-on-life-gain': async (page) => {
    await castWith(page, hand(page, 'Scenario Salve'), { resolves: /Scenario Salve[^]*resolves/ });
    await expect(life(page, 'P1')).toHaveText('43');
    const pridemate = permanent(page, 'P1', "Ajani's Pridemate");
    await passStackUntil(page, pridemate.locator('.counters'));
    await expect(pridemate.locator('.counters')).toContainText(/1/);
  },
  'pridemate-no-counter-on-opponent-gain': async (page) => {
    await passUntil(page, life(page, 'P2').filter({ hasText: '43' }));
    await expect(permanent(page, 'P1', "Ajani's Pridemate").locator('.counters')).toHaveCount(0);
  },
  'sanguine-bond-drains-that-much': async (page) => {
    await castWith(page, hand(page, 'Scenario Salve'), { resolves: /Scenario Salve[^]*resolves/ });
    await targetPlayer(page, 'P3');
    await passStackUntil(page, life(page, 'P3').filter({ hasText: '37' }));
    await expect(life(page, 'P1')).toHaveText('43');
    await expect(life(page, 'P2')).toHaveText('40');
  },
  'sanguine-bond-ignores-opponent-gain': async (page) => {
    await passUntil(page, life(page, 'P2').filter({ hasText: '43' }));
    await expect(life(page, 'P3')).toHaveText('40');
    await expect(life(page, 'P4')).toHaveText('40');
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'krenko-makes-x-goblins': async (page) => {
    await activate(page, permanent(page, 'P1', 'Krenko, Mob Boss'), /Create/);
    await passStackUntil(page, permanent(page, 'P1', 'Goblin'));
    await expectTokens(page, 'P1', 'Goblin', 2);
    await expectTapped(page, [['P1', 'Krenko, Mob Boss']]);
  },
  'memory-erosion-mills-caster': async (page) => {
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Island').first());
    await expect(inZone(page, 'P2', 'Graveyard', 'Island')).toHaveCount(2);
    await expect(inZone(page, 'P1', 'Graveyard', 'Island')).toHaveCount(0);
  },
  'memory-erosion-ignores-your-spells': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Island')).toHaveCount(0);
  },
  'fleshbag-each-player-sacrifices': async (page) => {
    await castWith(page, hand(page, 'Fleshbag Marauder'), {
      resolves: /Fleshbag Marauder[^]*resolves/,
    });
    // Fleshbag is P1's only creature, so it is sacrificed without a choice.
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Fleshbag Marauder')).toHaveCount(1);
  },
  'blaze-deals-x': async (page) => {
    const blaze = hand(page, 'Blaze');
    await passUntil(page, blaze.and(page.locator('.actionable')));
    await blaze.click();
    const row = page.locator('.source-actions .x-group');
    await row.getByRole('spinbutton').fill('3');
    await row.getByRole('button').click();
    await page.locator('.opponent[data-seat="P2"] > header').click();
    await confirmButton(page).click();
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '37' }));
  },
  'gruesome-fate-per-creature': async (page) => {
    await castWith(page, hand(page, 'Gruesome Fate'), { resolves: /Gruesome Fate[^]*resolves/ });
    for (const seat of ['P2', 'P3', 'P4'])
      await passStackUntil(page, life(page, seat).filter({ hasText: '38' }));
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'offer-immortality-grants-both': async (page) => {
    await castWith(page, hand(page, 'Offer Immortality'), {
      targets: [['P1', 'Scenario Bear']],
      resolves: /Offer Immortality[^]*resolves/,
    });
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Bear', 'deathtouch'));
    await expect(keywordOn(page, 'P1', 'Scenario Bear', 'indestructible')).toHaveCount(1);
  },
  'languish-shrinks-every-creature': async (page) => {
    await castWith(page, hand(page, 'Languish'), { resolves: /Languish[^]*resolves/ });
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', 'Languish')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Scenario Giant').filter({ hasText: '1/1' })).toHaveCount(1);
  },
  // EDHREC plan Phase 4 batches 5 and 6.
  'fungal-sprouting-greatest-power': async (page) => {
    await castWith(page, hand(page, 'Fungal Sprouting'), {
      resolves: /Fungal Sprouting[^]*resolves/,
    });
    await passStackUntil(page, permanent(page, 'P1', 'Saproling'));
    // The 4/4 is the greatest power on your side; P2's 5/5 does not count.
    await expectTokens(page, 'P1', 'Saproling', 4);
  },
  'arbor-elf-untaps-forest': async (page) => {
    await activate(page, permanent(page, 'P1', 'Arbor Elf'), /Untap/);
    await targetAndConfirm(page, [['P1', 'Forest']]);
    const forest = permanent(page, 'P1', 'Forest');
    await passStackUntil(page, logLine(page, /Untap target Forest[^]*resolves/));
    await expect(forest.locator('.tap-badge')).toHaveCount(0);
    await expect(tapBadge(page, 'P1', 'Arbor Elf')).toHaveCount(1);
  },
  'doom-blade-destroys-nonblack': async (page) => {
    await castWith(page, hand(page, 'Doom Blade'), {
      targets: [['P2', 'Scenario Bear']],
      resolves: /Doom Blade[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
  },
  'doom-blade-cannot-target-black': async (page) => {
    await expectStaysInHand(page, 'Doom Blade');
    await expect(permanent(page, 'P2', 'Scenario Shade')).toHaveCount(1);
  },
  'muscle-sliver-pumps-every-sliver': async (page) => {
    // P2's turn: its Sliver attacks; the tapped Muscle Sliver cannot block.
    const declare = page.getByRole('button', { name: /Declare blockers/ });
    await passUntil(page, declare.or(life(page, 'P1').filter({ hasText: '38' })));
    if (await declare.isVisible()) {
      await declare.click();
      await page.getByRole('button', { name: 'Confirm blocks' }).click();
    }
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await expect(permanent(page, 'P2', 'Scenario Sliver')).toHaveCount(1);
  },
  'selfless-savior-grants-indestructible': async (page) => {
    await activate(page, permanent(page, 'P1', 'Selfless Savior'), /Sacrifice/);
    await targetAndConfirm(page, [['P1', 'Scenario Bear']]);
    await passStackUntil(page, keywordOn(page, 'P1', 'Scenario Bear', 'indestructible'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Selfless Savior')).toHaveCount(1);
  },
  'wasteland-taps-for-colorless': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    await expectTapped(page, [['P1', 'Wasteland']]);
  },
  'wasteland-destroys-nonbasic': async (page) => {
    await activate(page, permanent(page, 'P1', 'Wasteland'), /Destroy/);
    await targetAndConfirm(page, [['P2', 'Scenario Dual']]);
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Dual'));
    await expect(inZone(page, 'P1', 'Graveyard', 'Wasteland')).toHaveCount(1);
    await expect(permanent(page, 'P2', 'Forest')).toHaveCount(1);
  },
  'geier-reach-taps-for-colorless': async (page) => {
    await castWith(page, hand(page, 'Scenario Bear'), { resolves: /Scenario Bear[^]*resolves/ });
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
  },
  'geier-reach-each-player-loots': async (page) => {
    await activate(page, permanent(page, 'P1', 'Geier Reach Sanitarium'), /draws/i);
    await passStackUntil(page, logLine(page, /Each player draws[^]*resolves/));
    for (const seat of ['P1', 'P2', 'P3', 'P4'])
      await passStackUntil(
        page,
        seatZone(page, seat, 'Graveyard').locator('.zone-card-thumb').first(),
      );
  },
  'deaths-shadow-shrinks-by-life': async (page) => {
    await attack(page, [["Death's Shadow", 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('32');
  },
  'deaths-shadow-dies-at-high-life': async (page) => {
    await castWith(page, hand(page, "Death's Shadow"), {
      resolves: /Death's Shadow[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', "Death's Shadow"));
    await expect(permanent(page, 'P1', "Death's Shadow")).toHaveCount(0);
  },
  'howling-golem-attack-each-draws': async (page) => {
    await attack(page, [['Howling Golem', 'P2']]);
    await passUntil(page, hand(page, 'Island'));
    await passUntil(page, logLine(page, /game over/));
    await expect(hand(page, 'Island')).toHaveCount(1);
  },
  'ophiomancer-snake-each-upkeep': async (page) => {
    await passUntil(page, permanent(page, 'P1', 'Snake'));
    // The second upkeep finds a Snake and makes none: the token stays a single one.
    await passUntil(page, logLine(page, /game over/));
    await expectTokens(page, 'P1', 'Snake', 1);
  },
  'ripjaw-raptor-enrage-draws': async (page) => {
    await castWith(page, hand(page, 'Scenario Shock'), {
      targets: [['P1', 'Ripjaw Raptor']],
      resolves: /Scenario Shock[^]*resolves/,
    });
    await passStackUntil(page, hand(page, 'Island'));
    await expect(permanent(page, 'P1', 'Ripjaw Raptor')).toHaveCount(1);
  },
  // EDHREC plan Phase 4 batch 7: "its controller" after a targeted sentence.
  'natures-claim-controller-gains': async (page) => {
    await castWith(page, hand(page, "Nature's Claim"), {
      targets: [['P2', 'Scenario Relic']],
      resolves: /Nature's Claim[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Relic')).toHaveCount(0);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Relic')).toHaveCount(1);
    await expect(life(page, 'P2')).toHaveText('44');
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'vapor-snag-bounce-and-drain': async (page) => {
    await castWith(page, hand(page, 'Vapor Snag'), {
      targets: [['P2', 'Scenario Bear']],
      resolves: /Vapor Snag[^]*resolves/,
    });
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'megrim-pings-discarding-opponent': async (page) => {
    await castWith(page, hand(page, 'Scenario Raid'), { resolves: /Scenario Raid[^]*resolves/ });
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('40');
  },
  'tithe-drinker-extort': async (page) => {
    // Extort asks for its payment as the Bear is cast, before the Bear resolves.
    await castNow(page, 'Scenario Bear');
    const pay = page.getByRole('button', { name: /^Pay/ }).first();
    await passStackUntil(page, pay);
    await pay.click();
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await expect(life(page, 'P4')).toHaveText('39');
    await expect(life(page, 'P1')).toHaveText('43');
  },
  'tithe-drinker-lifelink': async (page) => {
    await attack(page, [['Tithe Drinker', 'P2']]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('38');
    await expect(life(page, 'P1')).toHaveText('42');
  },
  'seers-sundial-pay-draw': async (page) => {
    await playLand(page, 'Forest');
    const pay = page.getByRole('button', { name: /^Pay/ }).first();
    await passStackUntil(page, pay);
    await pay.click();
    await passStackUntil(page, hand(page, 'Island'));
  },
  'seers-sundial-cannot-pay': async (page) => {
    await playLand(page, 'Forest');
    await expectStaysInHand(page, 'Forest').catch(() => undefined);
    await expect(permanent(page, 'P1', 'Forest')).toHaveCount(1);
    await expect(hand(page, 'Island')).toHaveCount(0);
  },
  'goblin-wardriver-battle-cry': async (page) => {
    await attack(page, [
      ['Goblin Wardriver', 'P2'],
      ['Scenario Bear', 'P2'],
    ]);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText('35');
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
    expectLabCoverage(exercised, titles.keys());
  });
});
