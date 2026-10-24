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
import { PR12_ALL_SCENARIOS } from '../../../packages/server/src/cards/pr12-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR12_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil, attack } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR12 title ${id}`);
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

/** Cast a hand card through the real payment panel, choosing `targets` in order. */
async function cast(page: Page, name: string, targets: Target[] = []): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await expect(confirmButton(page)).toBeVisible();
  for (const target of targets) await pickTarget(page, target);
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

/**
 * Cast a two-faced hand card through its source menu: the spell face when `face`, else the front.
 * When only one face is affordable the menu is skipped and the payment panel opens directly.
 */
async function castFace(page: Page, name: string, face: boolean): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const buttons = page.locator('.source-actions .source-action-row button');
  await expect(buttons.first().or(confirmButton(page))).toBeVisible();
  if ((await buttons.count()) > 0) {
    if (face) await buttons.filter({ hasText: /\((adventure|omen)\)/i }).click();
    else await buttons.filter({ has: page.locator('span', { hasText: /^Cast$/ }) }).click();
  }
  await confirmButton(page).click();
}

/** Pass priority until the card-layout choice `verb` for `card` is offered, then take it. */
async function pick(page: Page, card: string, verb: string): Promise<void> {
  const option = cardChoice(page, card, verb).or(button(page, `${verb.split(' ')[0]} ${card}`));
  await passUntil(page, option.first());
  await option.first().click();
}

const BLACK_BOLT = 'Black Bolt, Inhuman King';
const SIVITRI = 'Sivitri, Dragon Master';
const ZURGO = 'Zurgo and Ojutai';
const BLOOMVINE = 'Bloomvine Regent // Claim Territory';
const MARANG = 'Marang River Regent // Coil and Catch';
const MANUAL = 'Monster Manual // Zoological Study';

test.describe('PR12 reopened-card viewer scenarios', () => {
  for (const { id } of PR12_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'pr12-black-bolt-inhuman-king-viewer-lethal-voice': async (page) => {
    // P2 casts Lab Shock at Black Bolt; Lab Relic is the only nonland permanent P2 controls.
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'PR12 Lab Relic'));
    await expect(permanent(page, 'P1', BLACK_BOLT)).toBeVisible();
  },
  'pr12-black-bolt-inhuman-king-viewer-noncreature-pump': async (page) => {
    await cast(page, 'PR12 Lab Relic');
    await resolveStack(page, 'PR12 Lab Relic');
    await expect(permanent(page, 'P1', BLACK_BOLT).locator('.pt')).toHaveText('5/5');
    await attack(page, BLACK_BOLT);
    await passUntil(page, life(page, 'P2').filter({ hasText: '35' }));
  },
  'pr12-black-bolt-inhuman-king-viewer-creature-spell': async (page) => {
    await cast(page, 'PR12 Lab Bear');
    await resolveStack(page, 'PR12 Lab Bear');
    await expect(permanent(page, 'P1', BLACK_BOLT).locator('.pt')).toHaveText('3/3');
    await attack(page, BLACK_BOLT);
    await passUntil(page, life(page, 'P2').filter({ hasText: '37' }));
  },

  'pr12-dingus-staff-viewer-opponent-creature': async (page) => {
    await cast(page, 'PR12 Lab Shock', [['P2', 'PR12 Lab Bear']]);
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pr12-dingus-staff-viewer-own-creature': async (page) => {
    await cast(page, 'PR12 Lab Shock', [['P1', 'PR12 Lab Bear']]);
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await expect(life(page, 'P2')).toHaveText('40');
  },

  'pr12-sivitri-dragon-master-viewer-attack-tax': async (page) => {
    await activate(page, 'P1', SIVITRI, /pays 2 life/);
    await resolveStack(page, SIVITRI);
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
    await expect(life(page, 'P2')).toHaveText('38');
  },
  'pr12-sivitri-dragon-master-viewer-unaffordable-tax': async (page) => {
    await activate(page, 'P1', SIVITRI, /pays 2 life/);
    await resolveStack(page, SIVITRI);
    await passUntil(page, gameOver(page));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(life(page, 'P2')).toHaveText('1');
  },
  'pr12-sivitri-dragon-master-viewer-tutor': async (page) => {
    await activate(page, 'P1', SIVITRI, /Search your library for a Dragon/);
    await pick(page, 'PR12 Lab Dragon', 'Put into your hand');
    await passUntil(page, hand(page, 'PR12 Lab Dragon'));
  },
  'pr12-sivitri-dragon-master-viewer-wrath': async (page) => {
    await activate(page, 'P1', SIVITRI, /Destroy all non-Dragon/);
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'PR12 Lab Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR12 Lab Bear')).toBeVisible();
    await expect(permanent(page, 'P1', 'PR12 Lab Dragon')).toBeVisible();
  },

  'pr12-zurgo-and-ojutai-viewer-return': async (page) => {
    await attack(page, ZURGO);
    await pick(page, 'PR12 Lab Relic', 'Put into your hand');
    await choose(page, 'Keep current order');
    await pick(page, ZURGO, 'Return');
    await passUntil(page, hand(page, ZURGO));
    await expect(hand(page, 'PR12 Lab Relic')).toBeVisible();
    await expect(life(page, 'P2')).toHaveText('36');
  },
  'pr12-zurgo-and-ojutai-viewer-keep': async (page) => {
    await attack(page, ZURGO);
    await pick(page, 'PR12 Lab Relic', 'Put into your hand');
    await choose(page, 'Keep current order');
    await choose(page, 'Return none');
    await passUntil(page, hand(page, 'PR12 Lab Relic'));
    await expect(permanent(page, 'P1', ZURGO)).toBeVisible();
  },
  'pr12-zurgo-and-ojutai-viewer-multiplayer': async (page) => {
    const declare = page.getByRole('button', { name: /Declare attackers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: ZURGO })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: 'PR12 Lab Dragon' })
      .getByRole('button', { name: 'P3', exact: true })
      .click();
    await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
    await choose(page, /Zurgo and Ojutai.*event player: P2/);
    await pick(page, 'PR12 Lab Relic', 'Put into your hand');
    await choose(page, 'Keep current order');
    await pick(page, 'PR12 Lab Dragon', 'Return');
    await pick(page, 'PR12 Lab Dragon', 'Put into your hand');
    await choose(page, 'Keep current order');
    await pick(page, ZURGO, 'Return');
    await passUntil(page, hand(page, ZURGO));
    await expect(hand(page, 'PR12 Lab Dragon')).toHaveCount(2);
    await expect(hand(page, 'PR12 Lab Relic')).toBeVisible();
    await expect(hand(page, ZURGO)).toBeVisible();
    await expect(life(page, 'P2')).toHaveText('36');
    await expect(life(page, 'P3')).toHaveText('36');
    await expect(permanent(page, 'P1', ZURGO)).toHaveCount(0);
    await expect(permanent(page, 'P1', 'PR12 Lab Dragon')).toHaveCount(0);
  },

  'pr12-bloomvine-regent-claim-territory-viewer-claim-territory': async (page) => {
    await castFace(page, BLOOMVINE, true);
    await pick(page, 'Forest', 'Put onto the battlefield tapped');
    await pick(page, 'Forest', 'Put into your hand');
    await passUntil(page, hand(page, 'Forest'));
    await expect(logLine(page, /Put Forest onto the battlefield tapped/)).toBeVisible();
    await expect(hand(page, BLOOMVINE)).toHaveCount(0);
  },
  'pr12-bloomvine-regent-claim-territory-viewer-enters': async (page) => {
    await castFace(page, BLOOMVINE, false);
    await passUntil(page, life(page, 'P1').filter({ hasText: '43' }));
    await expect(permanent(page, 'P1', BLOOMVINE)).toBeVisible();
  },

  'pr12-marang-river-regent-coil-and-catch-viewer-coil-and-catch': async (page) => {
    await castFace(page, MARANG, true);
    await pick(page, 'PR12 Lab Trinket', 'Discard');
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'PR12 Lab Trinket'));
    await expect(page.locator('.hand-card')).toHaveCount(3);
  },
  'pr12-marang-river-regent-coil-and-catch-viewer-enters': async (page) => {
    await castFace(page, MARANG, false);
    await choose(page, 'Target PR12 Lab Bear');
    await choose(page, 'Target PR12 Lab Relic');
    await passUntil(page, permanent(page, 'P1', MARANG));
    await resolveStack(page, MARANG);
    await expect(permanent(page, 'P2', 'PR12 Lab Bear')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'PR12 Lab Relic')).toHaveCount(0);
  },

  'pr12-monster-manual-zoological-study-viewer-zoological-study': async (page) => {
    await castFace(page, MANUAL, true);
    await pick(page, 'PR12 Lab Bear', 'Return');
    await passUntil(page, hand(page, 'PR12 Lab Bear'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR12 Lab Dragon')).toBeVisible();
    const fromExile = page
      .locator('.playable-now')
      .getByRole('button', { name: `Cast ${MANUAL}`, exact: true });
    await passUntil(page, fromExile);
    await fromExile.click();
    await confirmIfShown(page);
    await passUntil(page, permanent(page, 'P1', MANUAL));
  },
  'pr12-monster-manual-zoological-study-viewer-put-creature': async (page) => {
    await activate(page, 'P1', MANUAL, /put a creature card/);
    // The creature cards in hand are the choices: click the one to put onto the battlefield.
    const dragon = hand(page, 'PR12 Lab Dragon');
    await passUntil(page, button(page, 'Put none of them'));
    await dragon.click();
    await confirmIfShown(page);
    await passUntil(page, permanent(page, 'P1', 'PR12 Lab Dragon'));
  },
};

test.afterAll(() =>
  expect([...exercised].sort()).toEqual(PR12_ALL_SCENARIOS.map(({ id }) => id).sort()),
);
