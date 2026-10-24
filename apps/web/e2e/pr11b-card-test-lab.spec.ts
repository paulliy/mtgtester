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
import { PR11B_ALL_SCENARIOS } from '../../../packages/server/src/cards/pr11b-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR11B_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR11b title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

/** A target: a seat id, a permanent as [seat, name], or a card in a zone as [seat, name, zone]. */
type Target = string | [string, string] | [string, string, string];

const life = (page: Page, seat: string): Locator =>
  page.locator(
    seat === 'P1' ? '.human-zone .life-badge' : `.opponent[data-seat="${seat}"] .life-badge`,
  );
const button = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('button', { name, exact: typeof name === 'string' }).first();
const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();
const gameOver = (page: Page): Locator => page.getByText(/game over/i).first();
const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
  seatZone(page, seat, zone).getByRole('img', { name, exact: true });

/** The decision-panel button `verb` for the option about the card named `card`. */
const cardChoice = (page: Page, card: string, verb: string): Locator =>
  page
    .locator('.decision-panel .panel-group')
    .filter({ has: page.getByText(card, { exact: true }) })
    .getByRole('button', { name: verb, exact: true });

/** Pass priority until `name` is offered as a decision button, then take it. */
async function choose(page: Page, name: string | RegExp): Promise<void> {
  const option = button(page, name);
  await passUntil(page, option);
  await option.click();
}

async function pickTarget(page: Page, target: Target): Promise<void> {
  if (typeof target === 'string') {
    const player = page.locator(`.opponent[data-seat="${target}"]`);
    await expect(player).toHaveClass(/targetable/);
    await player.locator('header').click();
  } else if (target[2] !== undefined) {
    const card = seatZone(page, target[0], target[2])
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: target[1], exact: true }) })
      .first();
    await expect(card).toHaveClass(/targetable/);
    await card.click();
  } else {
    const object = permanent(page, target[0], target[1]).first();
    await expect(object).toHaveClass(/targetable|actionable/);
    await object.click();
  }
}

async function confirmIfShown(page: Page): Promise<void> {
  const confirm = confirmButton(page);
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}

/**
 * Cast a hand card through the real payment panel, choosing `targets` in order. A card with more
 * than one way to be played (a back face, a split half, a fuse) first offers `offer`.
 */
async function cast(
  page: Page,
  name: string,
  targets: Target[] = [],
  offer?: string | RegExp,
): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  // A card image that finishes loading can shift the hand under the click, so retry the click.
  await expect(async () => {
    if (!(await confirmButton(page).isVisible())) {
      await card.click();
      if (offer !== undefined) await button(page, offer).click({ timeout: 3_000 });
    }
    await expect(confirmButton(page)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  for (const target of targets) await pickTarget(page, target);
  await confirmButton(page).click();
}

/** The "Playable now" offer for a spell that is not in hand, such as a prepared copy in exile. */
const playable = (page: Page, label: RegExp): Locator =>
  page.locator('.playable-now').getByRole('button', { name: label }).first();

/**
 * Cast the prepared copy offered in "Playable now", through the real payment panel. With `pass`
 * false the offer is already due (it is the next decision), so priority is never passed.
 */
async function castPrepared(page: Page, label: RegExp, pass = true): Promise<void> {
  const offer = playable(page, label);
  if (pass) await passUntil(page, offer);
  else await expect(offer).toBeVisible({ timeout: 30_000 });
  await offer.click();
  await expect(confirmButton(page)).toBeVisible();
  await confirmButton(page).click();
}

/** Click a permanent and take its ability whose button label matches `label`. */
async function activate(
  page: Page,
  seat: string,
  name: string,
  label: RegExp,
  targets: Target[] = [],
): Promise<void> {
  const source = permanent(page, seat, name).first();
  await expect(source).toHaveClass(/actionable/, { timeout: 15_000 });
  await source.click();
  const choice = page.getByRole('button', { name: label }).first();
  await expect(choice.or(confirmButton(page)).first()).toBeVisible();
  if (await choice.isVisible()) await choice.click();
  for (const target of targets) await pickTarget(page, target);
  await confirmIfShown(page);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pass priority while the stack is non-empty until `source`'s spell or ability has resolved. */
async function resolveStack(page: Page, source: string): Promise<void> {
  await passStackUntil(page, logLine(page, new RegExp(`${escapeRegExp(source)}[^]*resolves`)));
}

/** Declare each named creature as an attacker of P2 and confirm the attack. */
async function attackWith(page: Page, attackers: string[]): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  for (const attacker of attackers)
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: attacker })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
}

const tapped = (page: Page, seat: string, name: string): Locator =>
  permanent(page, seat, name).locator('.tap-badge');
const pt = (page: Page, seat: string, name: string): Locator =>
  permanent(page, seat, name).locator('.pt');

test.describe('PR11b layout-card viewer scenarios', () => {
  for (const { id } of PR11B_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'pr11b-malakir-rebirth-viewer-return': async (page) => {
    await cast(page, 'Malakir Rebirth', [['P1', 'PR11b Lab Bear']], /^Cast \{B\}/);
    await resolveStack(page, 'Malakir Rebirth');
    await expect(life(page, 'P1')).toHaveText('38');
    await cast(page, 'PR11b Lab Shock', [['P1', 'PR11b Lab Bear']]);
    await passUntil(page, tapped(page, 'P1', 'PR11b Lab Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11b Lab Shock')).toBeVisible();
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11b Lab Bear')).toHaveCount(0);
  },
  'pr11b-malakir-rebirth-viewer-land-face': async (page) => {
    const card = hand(page, 'Malakir Rebirth');
    await passUntil(page, card.and(page.locator('.actionable')));
    // Only the land face is affordable, so the one offer is taken without a menu.
    await card.click();
    await expect(tapped(page, 'P1', 'Malakir Mire')).toHaveCount(1);
  },

  'pr11b-valakut-awakening-viewer-redraw': async (page) => {
    await cast(page, 'Valakut Awakening', [], /^Cast \{2\}\{R\}/);
    for (const name of ['PR11b Lab Bear', 'PR11b Lab Relic']) {
      const bottom = cardChoice(page, name, 'Put on bottom');
      await passUntil(page, bottom);
      await bottom.click();
    }
    await choose(page, 'Done choosing cards');
    await choose(page, 'Choose a new order');
    const next = cardChoice(page, 'PR11b Lab Relic', 'Put next on the bottom');
    await passUntil(page, next);
    await next.click();
    await passUntil(page, hand(page, 'Forest'));
    await expect(page.locator('.hand-card')).toHaveCount(4);
    await expect(hand(page, 'PR11b Lab Bear')).toHaveCount(0);
    await expect(hand(page, 'PR11b Lab Relic')).toHaveCount(0);
  },
  'pr11b-valakut-awakening-viewer-land-face': async (page) => {
    const card = hand(page, 'Valakut Awakening');
    await passUntil(page, card.and(page.locator('.actionable')));
    await card.click();
    await expect(tapped(page, 'P1', 'Valakut Stoneforge')).toHaveCount(1);
  },

  'pr11b-defacing-duskmage-viewer-prepared': async (page) => {
    // Not prepared yet, so there is no copy to cast.
    await expect(playable(page, /Vandal's Edit/)).toHaveCount(0);
    await castPrepared(page, /^Cast Vandal's Edit/);
    await expect(logLine(page, /becomes prepared/)).toBeVisible();
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    for (const seat of ['P2', 'P3', 'P4']) await expect(life(page, seat)).toHaveText('38');
    await expect(page.locator('.hand-card')).toHaveCount(3);
  },
  'pr11b-defacing-duskmage-viewer-first-draw': async (page) => {
    await passUntil(page, logLine(page, /PR11b Lab Cantrip resolves/));
    await passUntil(page, gameOver(page));
    await expect(page.locator('.log')).not.toContainText(/prepared/);
  },

  'pr11b-eiganjo-dynastorian-viewer-prepared': async (page) => {
    await attackWith(page, ['Eiganjo Dynastorian', 'PR11b Lab Bear']);
    // The second main phase's priority window is the next decision after the attack.
    await castPrepared(page, /^Cast Replenish/, false);
    await expect(logLine(page, /becomes prepared/)).toBeVisible();
    await passUntil(page, permanent(page, 'P1', 'PR11b Lab Charm'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11b Lab Charm')).toHaveCount(0);
  },
  'pr11b-eiganjo-dynastorian-viewer-one-attacker': async (page) => {
    await attackWith(page, ['Eiganjo Dynastorian']);
    await passUntil(page, gameOver(page));
    await expect(page.locator('.log')).not.toContainText(/prepared/);
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11b Lab Charm')).toBeVisible();
  },

  'pr11b-wandering-archaic-viewer-copy': async (page) => {
    await choose(page, /^Copy PR11b Lab Shock/);
    await choose(page, 'Target P2');
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('38');
  },
  'pr11b-wandering-archaic-viewer-paid': async (page) => {
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await passUntil(page, gameOver(page));
    await expect(life(page, 'P2')).toHaveText('40');
    await expect(page.locator('.log')).not.toContainText(/Wandering Archaic[^]*copies/);
  },

  'pr11b-wear-tear-viewer-fused': async (page) => {
    await cast(
      page,
      'Wear // Tear',
      [
        ['P2', 'PR11b Lab Relic'],
        ['P2', 'PR11b Lab Charm'],
      ],
      /fused/,
    );
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'PR11b Lab Charm'));
    await expect(inZone(page, 'P2', 'Graveyard', 'PR11b Lab Relic')).toBeVisible();
  },
  'pr11b-wear-tear-viewer-half': async (page) => {
    // Only Tear is affordable with one Plains, so the one offer is taken without a menu.
    await cast(page, 'Wear // Tear', [['P2', 'PR11b Lab Charm']]);
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'PR11b Lab Charm'));
    await expect(permanent(page, 'P2', 'PR11b Lab Relic')).toBeVisible();
  },

  'pr11b-the-war-in-heaven-viewer-chapter-one': async (page) => {
    await cast(page, 'The War in Heaven');
    await passUntil(page, life(page, 'P1').filter({ hasText: '37' }));
    await expect(page.locator('.hand-card')).toHaveCount(4);
    await expect(permanent(page, 'P1', 'The War in Heaven')).toContainText(/lore/i);
  },
  'pr11b-the-war-in-heaven-viewer-chapter-three': async (page) => {
    await choose(page, 'Target PR11b Lab Bear');
    await choose(page, 'Target PR11b Lab Red Bear');
    await choose(page, 'Target PR11b Lab Giant');
    await passUntil(page, permanent(page, 'P1', 'PR11b Lab Giant'));
    await expect(permanent(page, 'P1', 'PR11b Lab Giant')).toContainText(/necrodermis/i);
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'The War in Heaven'));
    await expect(permanent(page, 'P1', 'The War in Heaven')).toHaveCount(0);
  },

  'pr11b-intermediate-chirography-viewer-level-two': async (page) => {
    await activate(page, 'P1', 'Intermediate Chirography', /Gain Class level 2/);
    await resolveStack(page, 'Intermediate Chirography');
    await cast(page, 'PR11b Lab Drain');
    // The Bear is the trigger's only legal target, so it is chosen without a prompt.
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await passUntil(page, pt(page, 'P1', 'PR11b Lab Bear').filter({ hasText: '3/3' }));
  },
  'pr11b-intermediate-chirography-viewer-level-one': async (page) => {
    await cast(page, 'PR11b Lab Drain');
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await passUntil(page, gameOver(page));
    await expect(pt(page, 'P1', 'PR11b Lab Bear')).toHaveText('2/2');
  },

  'pr11b-urza-s-saga-viewer-construct': async (page) => {
    const saga = hand(page, "Urza's Saga");
    await passUntil(page, saga.and(page.locator('.actionable')));
    await saga.click();
    await confirmIfShown(page);
    await passUntil(page, logLine(page, /Urza's Saga[^]*resolves/));
    // Chapter II arrives with the next precombat main phase.
    await passUntil(
      page,
      permanent(page, 'P1', "Urza's Saga").first().and(page.locator('.actionable')),
    );
    await activate(page, 'P1', "Urza's Saga", /Create a 0\/0 Construct/);
    await resolveStack(page, "Urza's Saga");
    await expect(pt(page, 'P1', 'Construct')).toHaveText('2/2');
  },
  'pr11b-urza-s-saga-viewer-chapter-three': async (page) => {
    const bauble = page
      .locator('.decision-panel .panel-group')
      .filter({ has: page.getByText('PR11b Lab Bauble', { exact: true }) })
      .getByRole('button')
      .first();
    await passUntil(page, bauble);
    // Only artifacts with mana cost {0} or {1} are searchable: the {3} Relic is not offered.
    await expect(page.locator('.decision-panel').getByText('PR11b Lab Relic')).toHaveCount(0);
    await bauble.click();
    await passUntil(page, permanent(page, 'P1', 'PR11b Lab Bauble'));
    await passUntil(page, inZone(page, 'P1', 'Graveyard', "Urza's Saga"));
    await expect(permanent(page, 'P1', "Urza's Saga")).toHaveCount(0);
  },

  'pr11b-legion-s-landing-viewer-transform': async (page) => {
    await attackWith(page, ['PR11b Lab Bear', 'PR11b Lab Red Bear', 'PR11b Lab Pinger']);
    await passUntil(page, permanent(page, 'P1', 'Adanto, the First Fort'));
    await expect(permanent(page, 'P1', "Legion's Landing")).toHaveCount(0);
  },
  'pr11b-legion-s-landing-viewer-two-attackers': async (page) => {
    await attackWith(page, ['PR11b Lab Bear', 'PR11b Lab Red Bear']);
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', "Legion's Landing")).toBeVisible();
    await expect(permanent(page, 'P1', 'Adanto, the First Fort')).toHaveCount(0);
  },

  'pr11b-dollmaker-s-shop-viewer-unlock': async (page) => {
    await cast(page, "Dollmaker's Shop // Porcelain Gallery", [], /as Dollmaker's Shop/);
    await resolveStack(page, "Dollmaker's Shop");
    await activate(page, 'P1', "Dollmaker's Shop", /Unlock Porcelain Gallery/);
    for (const name of ['PR11b Lab Bear', 'PR11b Lab Red Bear', 'PR11b Lab Pinger'])
      await passUntil(page, pt(page, 'P1', name).filter({ hasText: '3/3' }));
  },
  'pr11b-dollmaker-s-shop-viewer-toy-attack': async (page) => {
    await cast(page, "Dollmaker's Shop // Porcelain Gallery");
    await resolveStack(page, "Dollmaker's Shop");
    await attackWith(page, ['PR11b Lab Bear', 'PR11b Lab Red Bear']);
    await passUntil(page, permanent(page, 'P1', 'Toy'));
    await expect(pt(page, 'P1', 'Toy')).toHaveText('1/1');
    await passUntil(page, life(page, 'P2').filter({ hasText: '36' }));
  },
  'pr11b-dollmaker-s-shop-viewer-multiplayer': async (page) => {
    await cast(page, "Dollmaker's Shop // Porcelain Gallery");
    await resolveStack(page, "Dollmaker's Shop");
    const declare = page.getByRole('button', { name: /Declare attackers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: 'PR11b Lab Bear' })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: 'PR11b Lab Red Bear' })
      .getByRole('button', { name: 'P3', exact: true })
      .click();
    await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
    await choose(page, /Dollmaker's Shop/);
    const toys = permanent(page, 'P1', 'Toy');
    // The viewer groups identical tokens into one tile and shows their actual count.
    const count = toys.locator('.stack-count-badge');
    await passUntil(page, count.filter({ hasText: '×2' }));
    await expect(toys).toHaveCount(1);
    await expect(count).toHaveText('×2');
    await expect(toys.locator('.pt')).toHaveText('1/1');
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('38');
  },
  'pr11b-dollmaker-s-shop-viewer-graveyard-budget': async (page) => {
    const roomName = "Dollmaker's Shop // Porcelain Gallery";
    const graveyard = page.locator('.zones-strip .zone', { hasText: 'Graveyard' });
    const roomCards = graveyard
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name: roomName, exact: true }) });
    const actionableRooms = graveyard
      .locator('.zone-card-thumb.actionable')
      .filter({ has: page.getByRole('img', { name: roomName, exact: true }) });
    await expect(roomCards).toHaveCount(2);
    await actionableRooms.first().click();
    const shopDoor = page
      .locator('.source-actions .source-action-row button')
      .filter({ hasText: /Dollmaker's Shop/ })
      .first();
    await expect(shopDoor).toBeVisible();
    await shopDoor.click();
    await expect(confirmButton(page)).toBeVisible();
    await confirmButton(page).click();
    await resolveStack(page, "Dollmaker's Shop");
    await expect(permanent(page, 'P1', "Dollmaker's Shop")).toBeVisible();
    await expect(roomCards).toHaveCount(1);
    await expect(roomCards.first()).not.toHaveClass(/actionable/);
  },

  'pr11b-mila-crafty-companion-viewer-walker-attack': async (page) => {
    await passUntil(page, logLine(page, /Mila, Crafty Companion[^]*loyalty counter/));
    // P2's Bear attacks the walker; take no blocks.
    const declare = button(page, /Declare blockers/);
    await passUntil(page, declare);
    await declare.click();
    await page.getByRole('button', { name: 'Confirm blocks' }).click();
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', 'PR11b Lab Second Walker')).toContainText('3');
  },
  'pr11b-mila-crafty-companion-viewer-lukka': async (page) => {
    // Only the back face is affordable, so it is cast without a menu.
    await cast(page, 'Mila, Crafty Companion');
    await resolveStack(page, 'Lukka, Wayward Bonder');
    await activate(page, 'P1', 'Lukka, Wayward Bonder', /Return target creature card/, [
      ['P1', 'PR11b Lab Bear', 'Graveyard'],
    ]);
    await passUntil(page, permanent(page, 'P1', 'PR11b Lab Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11b Lab Bear')).toHaveCount(0);
  },
};

test.afterAll(() =>
  expect([...exercised].sort()).toEqual(PR11B_ALL_SCENARIOS.map(({ id }) => id).sort()),
);
