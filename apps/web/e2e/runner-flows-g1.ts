import { expect, type Locator, type Page } from '@playwright/test';
import { permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for the evasion and blocking-restriction scenarios (group g1). */
export function g1Flows(h: Helpers): Record<string, Flow> {
  const { passUntil } = h;

  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone).getByRole('img', { name, exact: true });

  /** Declare the attack of `creature` on P2, the rest not attacking. */
  async function attack(page: Page, creature: string): Promise<void> {
    const declare = page.getByRole('button', { name: /Declare attackers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: creature })
      .getByRole('button', { name: 'P2' })
      .click();
    await page.getByRole('button', { name: 'Confirm attacks' }).click();
  }

  /** Click the button named `name` once it is offered. */
  async function press(page: Page, name: string | RegExp): Promise<void> {
    const button = page.getByRole('button', { name, exact: typeof name === 'string' }).first();
    await passUntil(page, button);
    await button.click();
  }

  /** Where `name` ends up once combat is over: 'battlefield' or 'graveyard' of `seat`. */
  async function expectZone(page: Page, seat: string, zone: string, name: string): Promise<void> {
    if (zone === 'battlefield') await expect(permanent(page, seat, name)).toHaveCount(1);
    else await expect(inZone(page, seat, 'Graveyard', name)).toHaveCount(1);
  }

  type Outcome = {
    /** Prompts P1 answers between the attack and the end of combat. */
    prompts?: Array<string | RegExp>;
    /** Final P2 life, and P1 life when it matters. */
    p2: number;
    p1?: number;
    /** [seat, zone, card] the scenario expects. */
    zones: Array<[string, 'battlefield' | 'graveyard', string]>;
  };

  async function finish(page: Page, outcome: Outcome): Promise<void> {
    for (const prompt of outcome.prompts ?? []) await press(page, prompt);
    await passUntil(page, logLine(page, /game over/));
    await expect(life(page, 'P2')).toHaveText(String(outcome.p2));
    if (outcome.p1 !== undefined) await expect(life(page, 'P1')).toHaveText(String(outcome.p1));
    for (const [seat, zone, name] of outcome.zones) await expectZone(page, seat, zone, name);
  }

  /** The attack is never offered to a blocker: the damage goes through and P2's creature is untouched. */
  const unblocked =
    (creature: string, outcome: Outcome): Flow =>
    async (page) => {
      await attack(page, creature);
      await finish(page, outcome);
      await expect(logLine(page, /P2 blocks|blocked by/i)).toHaveCount(0);
    };

  /** P2, a scripted seat, blocks the attacker. */
  const blocked =
    (creature: string, outcome: Outcome): Flow =>
    async (page) => {
      await attack(page, creature);
      await finish(page, outcome);
    };

  const bear = (): Outcome['zones'] => [['P2', 'battlefield', 'Scenario Bear']];
  const noDraw = ['No'];

  return {
    'shadowmage-infiltrator-unblockable-by-nonblack': unblocked('Shadowmage Infiltrator', {
      prompts: noDraw,
      p2: 39,
      zones: bear(),
    }),
    'shadowmage-infiltrator-blockable-by-black': blocked('Shadowmage Infiltrator', {
      p2: 40,
      zones: [['P2', 'battlefield', 'Scenario Zombie']],
    }),
    'ratcatcher-unblockable-by-nonblack': unblocked('Ratcatcher', { p2: 36, zones: bear() }),
    'ratcatcher-blockable-by-black': blocked('Ratcatcher', {
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Zombie']],
    }),
    'vampire-cutthroat-unblockable-by-greater-power': unblocked('Vampire Cutthroat', {
      p2: 39,
      p1: 41,
      zones: bear(),
    }),
    'vampire-cutthroat-blockable-by-equal-power': blocked('Vampire Cutthroat', {
      p2: 40,
      p1: 41,
      zones: [['P2', 'graveyard', 'Scenario Mouse']],
    }),
    'rancid-rats-unblockable-by-greater-power': unblocked('Rancid Rats', {
      p2: 39,
      zones: bear(),
    }),
    'rancid-rats-blockable-by-equal-power': blocked('Rancid Rats', {
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Mouse']],
    }),
    'cold-eyed-selkie-unblockable-with-island': unblocked('Cold-Eyed Selkie', {
      prompts: noDraw,
      p2: 39,
      zones: bear(),
    }),
    'cold-eyed-selkie-blockable-without-island': blocked('Cold-Eyed Selkie', {
      p2: 40,
      zones: [['P1', 'graveyard', 'Cold-Eyed Selkie']],
    }),
    'inkwell-leviathan-unblockable-with-island': unblocked('Inkwell Leviathan', {
      p2: 33,
      zones: bear(),
    }),
    'inkwell-leviathan-blockable-without-island': blocked('Inkwell Leviathan', {
      prompts: [/^All 7 damage to Scenario Bear/],
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Bear']],
    }),
    'merrow-harbinger-unblockable-with-island': unblocked('Merrow Harbinger', {
      p2: 38,
      zones: bear(),
    }),
    'merrow-harbinger-blockable-without-island': blocked('Merrow Harbinger', {
      p2: 40,
      zones: [['P1', 'battlefield', 'Merrow Harbinger']],
    }),
    'dwarven-grunt-unblockable-with-mountain': unblocked('Dwarven Grunt', {
      p2: 39,
      zones: bear(),
    }),
    'dwarven-grunt-blockable-without-mountain': blocked('Dwarven Grunt', {
      p2: 40,
      zones: [['P1', 'graveyard', 'Dwarven Grunt']],
    }),
    'zodiac-monkey-unblockable-with-forest': unblocked('Zodiac Monkey', {
      p2: 38,
      zones: bear(),
    }),
    'zodiac-monkey-blockable-without-forest': blocked('Zodiac Monkey', {
      p2: 40,
      zones: [['P1', 'graveyard', 'Zodiac Monkey']],
    }),
    'shadow-sliver-unblockable-by-nonshadow': unblocked('Shadow Sliver', {
      p2: 39,
      zones: bear(),
    }),
    'shadow-sliver-blockable-by-other-sliver': blocked('Shadow Sliver', {
      p2: 40,
      zones: [['P1', 'graveyard', 'Shadow Sliver']],
    }),
    'silhana-ledgewalker-unblockable-by-nonflyer': unblocked('Silhana Ledgewalker', {
      p2: 39,
      zones: bear(),
    }),
    'silhana-ledgewalker-blockable-by-flyer': blocked('Silhana Ledgewalker', {
      p2: 40,
      zones: [
        ['P2', 'battlefield', 'Scenario Bird'],
        ['P1', 'graveyard', 'Silhana Ledgewalker'],
      ],
    }),
    'greater-sandwurm-unblockable-by-power-two': unblocked('Greater Sandwurm', {
      p2: 33,
      zones: bear(),
    }),
    'greater-sandwurm-blocked-by-power-three': blocked('Greater Sandwurm', {
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Ogre']],
    }),
    'stormkeld-vanguard-unblockable-by-power-two': unblocked('Stormkeld Vanguard', {
      p2: 34,
      zones: bear(),
    }),
    'stormkeld-vanguard-blocked-by-power-three': blocked('Stormkeld Vanguard', {
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Ogre']],
    }),
    'beloved-princess-unblockable-by-power-three': unblocked('Beloved Princess', {
      p2: 39,
      p1: 41,
      zones: [['P2', 'battlefield', 'Scenario Ogre']],
    }),
    'beloved-princess-blocked-by-power-two': blocked('Beloved Princess', {
      p2: 40,
      p1: 41,
      zones: [['P1', 'graveyard', 'Beloved Princess']],
    }),
    'ox-drover-unblockable-by-ox': async (page) => {
      await attack(page, 'Ox Drover');
      await page.locator('.opponent[data-seat="P2"] > header').click();
      await press(page, 'Confirm');
      await finish(page, { p2: 36, zones: [] });
    },
    'ox-drover-blockable-by-non-ox': async (page) => {
      await attack(page, 'Ox Drover');
      await page.locator('.opponent[data-seat="P2"] > header').click();
      await press(page, 'Confirm');
      await finish(page, { p2: 40, zones: [['P2', 'graveyard', 'Scenario Bear']] });
    },
    'steel-leaf-champion-blocked-by-power-three': blocked('Steel Leaf Champion', {
      p2: 40,
      zones: [['P2', 'graveyard', 'Scenario Ogre']],
    }),
    'steel-leaf-champion-unblockable-by-power-two': unblocked('Steel Leaf Champion', {
      p2: 35,
      zones: bear(),
    }),
  };
}
