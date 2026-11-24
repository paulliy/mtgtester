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
import { PR11_ALL_SCENARIOS } from '../../../packages/server/src/cards/pr11-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR11_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil, attack } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR11 title ${id}`);
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

async function expectNotCastable(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/actionable/);
}

test.describe('PR11 protection, phasing and lifecycle viewer scenarios', () => {
  for (const { id } of PR11_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'pr11-arcane-lighthouse-viewer-positive': async (page) => {
    await activate(page, 'P1', 'Arcane Lighthouse', /lose hexproof and shroud/);
    await resolveStack(page, 'Arcane Lighthouse');
    await cast(page, 'PR11 Lab Shock', [['P2', 'PR11 Lab Hexproof Bear']]);
    await passUntil(page, inZone(page, 'P2', 'Graveyard', 'PR11 Lab Hexproof Bear'));
  },
  'pr11-arcane-lighthouse-viewer-negative': async (page) => {
    const card = hand(page, 'PR11 Lab Shock');
    await expect(card).toHaveClass(/actionable/);
    await card.click();
    await expect(confirmButton(page)).toBeVisible();
    await expect(permanent(page, 'P2', 'PR11 Lab Hexproof Bear')).not.toHaveClass(/targetable/);
    await pickTarget(page, 'P2');
    await confirmButton(page).click();
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(permanent(page, 'P2', 'PR11 Lab Hexproof Bear')).toBeVisible();
  },

  'pr11-smokestack-viewer-soot': async (page) => {
    // Place the sacrifice trigger first so the soot counter is added before it resolves.
    await choose(page, /Smokestack: At the beginning of each player's upkeep/);
    await choose(page, 'Yes');
    const sacrifice = cardChoice(page, 'PR11 Lab Bear', 'Sacrifice');
    await passUntil(page, sacrifice);
    await sacrifice.click();
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'PR11 Lab Bear'));
    await expect(permanent(page, 'P1', 'Smokestack')).toContainText(/soot/i);
  },
  'pr11-smokestack-viewer-sacrifice': async (page) => {
    await passUntil(page, gameOver(page));
    await expect(seatZone(page, 'P2', 'Graveyard').getByRole('img')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Smokestack')).toContainText(/soot/i);
  },

  'pr11-angel-s-grace-viewer-split-second': async (page) => {
    await cast(page, 'PR11 Lab Trinket');
    await resolveStack(page, 'PR11 Lab Trinket');
    await cast(page, "Angel's Grace");
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    // Lab Shock was cast only after Grace left the stack.
    const text = await page.locator('.log').innerText();
    expect(text.indexOf("Angel's Grace resolves")).toBeGreaterThanOrEqual(0);
    expect(text.lastIndexOf('PR11 Lab Shock')).toBeGreaterThan(-1);
  },
  'pr11-angel-s-grace-viewer-life-floor': async (page) => {
    await cast(page, "Angel's Grace");
    await passUntil(page, gameOver(page));
    await expect(life(page, 'P1')).toHaveText('1');
  },

  'pr11-gut-true-soul-zealot-viewer-sacrifice': async (page) => {
    await attack(page, 'Gut, True Soul Zealot');
    // Lab Bear is the only other creature, so accepting sacrifices it without a further choice.
    await choose(page, 'Yes');
    // The Skeleton enters attacking a player of your choice.
    const attackP2 = page
      .locator('.decision-panel .panel-group')
      .filter({ hasText: 'P2' })
      .getByRole('button', { name: 'Attack' });
    await passUntil(page, attackP2);
    await attackP2.click();
    await passUntil(page, life(page, 'P2').filter({ hasText: '34' }));
    await expect(permanent(page, 'P1', 'Skeleton')).toBeVisible();
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11 Lab Bear')).toBeVisible();
  },
  'pr11-gut-true-soul-zealot-viewer-decline': async (page) => {
    await attack(page, 'Gut, True Soul Zealot');
    await choose(page, 'No');
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    await expect(permanent(page, 'P1', 'Skeleton')).toHaveCount(0);
  },

  'pr11-out-of-the-tombs-viewer-upkeep': async (page) => {
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', 'Out of the Tombs')).toContainText(/eon/i);
    await expect(seatZone(page, 'P1', 'Graveyard').getByRole('img')).toHaveCount(2);
  },
  'pr11-out-of-the-tombs-viewer-empty-library': async (page) => {
    await passUntil(page, permanent(page, 'P1', 'PR11 Lab Bear'));
    await expect(seatZone(page, 'P1', 'Graveyard').getByRole('img')).toHaveCount(0);
  },

  'pr11-caged-sun-viewer-chosen-color': async (page) => {
    await cast(page, 'Caged Sun');
    await choose(page, 'Red');
    await passUntil(page, permanent(page, 'P1', 'Caged Sun'));
    await expect(permanent(page, 'P1', 'PR11 Lab Red Bear').locator('.pt')).toHaveText('3/3');
    await expect(permanent(page, 'P1', 'PR11 Lab Bear').locator('.pt')).toHaveText('2/2');
  },
  'pr11-caged-sun-viewer-mana': async (page) => {
    await cast(page, 'Caged Sun');
    await choose(page, 'Red');
    await passUntil(page, permanent(page, 'P1', 'Caged Sun'));
    await cast(page, 'PR11 Lab Fire Bolt', ['P2']);
    await passUntil(page, life(page, 'P2').filter({ hasText: '37' }));
  },
  'pr11-caged-sun-viewer-other-color': async (page) => {
    await cast(page, 'Caged Sun');
    await choose(page, 'Green');
    await passUntil(page, permanent(page, 'P1', 'Caged Sun'));
    await expect(hand(page, 'PR11 Lab Trinket')).toHaveClass(/actionable/);
    await expectNotCastable(page, 'PR11 Lab Fire Bolt');
  },

  'pr11-mystic-remora-viewer-draw': async (page) => {
    await choose(page, 'Yes');
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(page.locator('.hand-card')).toHaveCount(2);
  },
  'pr11-mystic-remora-viewer-pay-upkeep': async (page) => {
    await choose(page, 'Pay {1}');
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', 'Mystic Remora')).toContainText(/age/i);
  },
  'pr11-mystic-remora-viewer-skip-upkeep': async (page) => {
    await choose(page, "Don't pay {1}");
    await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Mystic Remora'));
    await expect(permanent(page, 'P1', 'Mystic Remora')).toHaveCount(0);
  },

  'pr11-chrome-mox-viewer-imprint': async (page) => {
    await cast(page, 'Chrome Mox');
    // Only nonartifact, nonland cards are offered: the Trinket is an artifact.
    const exile = cardChoice(page, 'PR11 Lab Red Bear', 'Exile');
    await passUntil(page, exile);
    await expect(cardChoice(page, 'PR11 Lab Shock', 'Exile')).toBeVisible();
    await expect(cardChoice(page, 'PR11 Lab Trinket', 'Exile')).toHaveCount(0);
    await exile.click();
    await passUntil(page, permanent(page, 'P1', 'Chrome Mox'));
    await cast(page, 'PR11 Lab Shock', ['P2']);
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
  },
  'pr11-chrome-mox-viewer-no-imprint': async (page) => {
    await cast(page, 'Chrome Mox');
    await choose(page, 'Exile nothing');
    await passUntil(page, permanent(page, 'P1', 'Chrome Mox'));
    await expect(hand(page, 'PR11 Lab Trinket')).toHaveClass(/actionable/);
    await expectNotCastable(page, 'PR11 Lab Shock');
  },

  'pr11-gemstone-caverns-viewer-luck': async (page) => {
    await cast(page, 'PR11 Lab Shock', ['P2']);
    await passUntil(page, life(page, 'P2').filter({ hasText: '38' }));
  },
  'pr11-gemstone-caverns-viewer-no-luck': async (page) => {
    await expect(hand(page, 'PR11 Lab Trinket')).toHaveClass(/actionable/);
    await expectNotCastable(page, 'PR11 Lab Shock');
  },

  'pr11-teferi-s-protection-viewer-protection': async (page) => {
    await cast(page, "Teferi's Protection");
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(permanent(page, 'P1', 'PR11 Lab Bear')).toHaveCount(0);
    await expect(inZone(page, 'P1', 'Exile', "Teferi's Protection")).toBeVisible();
  },
  'pr11-teferi-s-protection-viewer-phase-in': async (page) => {
    await cast(page, "Teferi's Protection");
    await passUntil(page, permanent(page, 'P1', 'PR11 Lab Bear'));
    await expect(permanent(page, 'P1', 'Plains')).toBeVisible();
  },

  'pr11-mana-vault-viewer-mana': async (page) => {
    await cast(page, 'PR11 Lab Relic');
    await passUntil(page, permanent(page, 'P1', 'PR11 Lab Relic'));
    await expect(permanent(page, 'P1', 'Mana Vault').locator('.tap-badge')).toHaveCount(1);
  },
  'pr11-mana-vault-viewer-pay-untap': async (page) => {
    await choose(page, 'Pay {4}');
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', 'Mana Vault').locator('.tap-badge')).toHaveCount(0);
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pr11-mana-vault-viewer-damage': async (page) => {
    await choose(page, "Don't pay");
    await passUntil(page, life(page, 'P1').filter({ hasText: '39' }));
    await expect(permanent(page, 'P1', 'Mana Vault').locator('.tap-badge')).toHaveCount(1);
  },

  'pr11-the-one-ring-viewer-cast': async (page) => {
    await cast(page, 'The One Ring');
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(life(page, 'P1')).toHaveText('40');
  },
  'pr11-the-one-ring-viewer-draw': async (page) => {
    await activate(page, 'P1', 'The One Ring', /burden counter/);
    await resolveStack(page, 'The One Ring');
    await expect(page.locator('.hand-card')).toHaveCount(2);
    await expect(permanent(page, 'P1', 'The One Ring')).toContainText(/burden/i);
  },
  'pr11-the-one-ring-viewer-upkeep': async (page) => {
    await passUntil(page, life(page, 'P1').filter({ hasText: '38' }));
  },

  'pr11-clever-concealment-viewer-phase-out': async (page) => {
    await cast(page, 'Clever Concealment');
    await choose(page, 'Target PR11 Lab Bear');
    await choose(page, 'Target PR11 Lab Relic');
    await passUntil(page, logLine(page, /Clever Concealment resolves/i));
    await expect(permanent(page, 'P1', 'PR11 Lab Bear')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'PR11 Lab Relic')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Plains')).toBeVisible();
  },
  'pr11-clever-concealment-viewer-convoke': async (page) => {
    await cast(page, 'Clever Concealment');
    await choose(page, 'Target PR11 Lab Bear');
    await choose(page, 'Choose no more targets');
    await passUntil(page, logLine(page, /Clever Concealment resolves/i));
    await expect(permanent(page, 'P1', 'PR11 Lab Bear')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'PR11 Lab Red Bear').locator('.tap-badge')).toHaveCount(1);
  },

  'pr11-shanna-sisay-s-legacy-viewer-power': async (page) => {
    await expect(permanent(page, 'P1', "Shanna, Sisay's Legacy").locator('.pt')).toHaveText('3/3');
  },
  'pr11-shanna-sisay-s-legacy-viewer-ability-target': async (page) => {
    await passUntil(page, logLine(page, /PR11 Lab Pinger/));
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', "Shanna, Sisay's Legacy")).toBeVisible();
    await expect(page.locator('.log')).not.toContainText(/Pinger deals 1 damage to Shanna/);
  },
  'pr11-shanna-sisay-s-legacy-viewer-spell-target': async (page) => {
    await passUntil(page, inZone(page, 'P1', 'Graveyard', "Shanna, Sisay's Legacy"));
  },

  'pr11-basri-s-lieutenant-viewer-enters': async (page) => {
    await cast(page, "Basri's Lieutenant");
    const bear = permanent(page, 'P1', 'PR11 Lab Bear').first();
    await passUntil(page, bear.and(page.locator('.targetable')));
    await bear.click();
    await confirmIfShown(page);
    await passUntil(
      page,
      permanent(page, 'P1', 'PR11 Lab Bear').locator('.pt').filter({ hasText: '3/3' }),
    );
  },
  'pr11-basri-s-lieutenant-viewer-multicolored': async (page) => {
    await passUntil(page, logLine(page, /PR11 Lab Gold Bolt/));
    await passUntil(page, gameOver(page));
    await expect(permanent(page, 'P1', "Basri's Lieutenant")).toBeVisible();
  },
  'pr11-basri-s-lieutenant-viewer-dies': async (page) => {
    await cast(page, 'PR11 Lab Fire Bolt', [['P1', 'PR11 Lab Red Bear']]);
    await passUntil(page, permanent(page, 'P1', 'Knight'));
    await expect(inZone(page, 'P1', 'Graveyard', 'PR11 Lab Red Bear')).toBeVisible();
  },

  'pr11-negative-zone-portal-viewer-creature': async (page) => {
    await activate(page, 'P1', 'Negative Zone Portal', /Exile target card/, [
      ['P2', 'PR11 Lab Bear', 'Graveyard'],
    ]);
    await resolveStack(page, 'Negative Zone Portal');
    await expect(page.locator('.hand-card')).toHaveCount(2);
    await expect(inZone(page, 'P2', 'Graveyard', 'PR11 Lab Bear')).toHaveCount(0);
  },
  'pr11-negative-zone-portal-viewer-noncreature': async (page) => {
    await activate(page, 'P1', 'Negative Zone Portal', /Exile target card/, [
      ['P2', 'PR11 Lab Shock', 'Graveyard'],
    ]);
    await resolveStack(page, 'Negative Zone Portal');
    await expect(page.locator('.hand-card')).toHaveCount(1);
    await expect(inZone(page, 'P2', 'Graveyard', 'PR11 Lab Shock')).toHaveCount(0);
  },

  'pr11-spirit-mantle-viewer-cast': async (page) => {
    await cast(page, 'Spirit Mantle', [['P1', 'PR11 Lab Bear']]);
    await passUntil(
      page,
      permanent(page, 'P1', 'PR11 Lab Bear').locator('.pt').filter({ hasText: '3/3' }),
    );
  },
  'pr11-spirit-mantle-viewer-ability-target': async (page) => {
    await passUntil(page, logLine(page, /PR11 Lab Pinger/));
    await passUntil(page, gameOver(page));
    await expect(page.locator('.log')).not.toContainText(/Pinger deals 1 damage to PR11 Lab Bear/);
  },

  'pr11-unquestioned-authority-viewer-cast': async (page) => {
    await cast(page, 'Unquestioned Authority', [['P1', 'PR11 Lab Bear']]);
    await passUntil(page, permanent(page, 'P1', 'Unquestioned Authority'));
    await expect(page.locator('.hand-card')).toHaveCount(2);
  },
};

test.afterAll(() =>
  expectLabCoverage(
    exercised,
    PR11_ALL_SCENARIOS.map(({ id }) => id),
  ),
);
