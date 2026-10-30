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
