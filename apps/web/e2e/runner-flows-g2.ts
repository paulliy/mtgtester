import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flows = Record<string, (page: Page) => Promise<void>>;
type PassHelpers = {
  passUntil: (page: Page, target: Locator) => Promise<unknown>;
  passStackUntil: (page: Page, target: Locator) => Promise<unknown>;
};

const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

const life = (page: Page, seat: string): Locator =>
  page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);

const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
  seatZone(page, seat, zone).getByRole('img', { name, exact: true });

/** Evasion and block-restriction scenarios (landwalk, fear, skulk, lords, max-blockers). */
export function g2Flows({ passUntil }: PassHelpers): Flows {
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

  const gameOver = (page: Page): Promise<unknown> => passUntil(page, logLine(page, /game over/));

  /** P2 is never offered a block: the attacker's damage lands and the blocker survives. */
  const unblockable =
    (attacker: string, lifeAfter: string, blocker = 'Scenario Ogre') =>
    async (page: Page) => {
      await attack(page, [[attacker, 'P2']]);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText(lifeAfter);
      await expect(permanent(page, 'P2', blocker)).toHaveCount(1);
    };

  /** P2's scripted seat blocks the attacker, so no damage reaches P2. */
  const blocked =
    (attacker: string, dead: Array<[string, string]> = []) =>
    async (page: Page) => {
      await attack(page, [[attacker, 'P2']]);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      for (const [seat, name] of dead) {
        await expect(permanent(page, seat, name)).toHaveCount(0);
        await expect(inZone(page, seat, 'Graveyard', name)).toHaveCount(1);
      }
    };

  /** A lord's walker attacks alone (the lord stays home) and cannot be blocked. */
  const walker = (creature: string, lifeAfter: string) => unblockable(creature, lifeAfter);
  /** The lord itself attacks alone, and the Ogre may block it. */
  const lordBlocked = (lord: string) => async (page: Page) => {
    await attack(page, [[lord, 'P2']]);
    await gameOver(page);
    await expect(life(page, 'P2')).toHaveText('40');
  };

  const twoBlockersRepaired = async (page: Page) => {
    await attack(page, [['Scenario Bear', 'P2']]);
    await gameOver(page);
    await expect(life(page, 'P2')).toHaveText('40');
    // The repair stands down the lower-power blocker (the Wall) and keeps the Ogre, which kills
    // the Bear: exactly one of the two declared blockers is still blocking.
    await expect(logLine(page, 'Scenario Bear deals 2 to Scenario Ogre')).toBeVisible();
    await expect(logLine(page, 'Scenario Ogre deals 3 to Scenario Bear')).toBeVisible();
    await expect(logLine(page, /to Scenario Wall/)).toHaveCount(0);
    await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
  };

  return {
    'trailblazers-boots-unblockable': unblockable('Scenario Bear', '38'),
    'trailblazers-boots-blockable': blocked('Scenario Bear', [['P1', 'Scenario Bear']]),
    'prowlers-helm-unblockable': unblockable('Scenario Bear', '38'),
    'prowlers-helm-blockable': async (page) => {
      await blocked('Scenario Bear')(page);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      await expect(permanent(page, 'P2', 'Scenario Wall')).toHaveCount(1);
      await expect(permanent(page, 'P2', 'Scenario Ogre')).toHaveCount(1);
    },
    'mask-of-riddles-unblockable': async (page) => {
      await attack(page, [['Scenario Bear', 'P2']]);
      const yes = page.getByRole('button', { name: 'Yes', exact: true });
      await passUntil(page, yes);
      await yes.click();
      await passUntil(page, hand(page, 'Forest'));
      await expect(life(page, 'P2')).toHaveText('38');
    },
    'mask-of-riddles-blockable': async (page) => {
      await blocked('Scenario Bear', [
        ['P1', 'Scenario Bear'],
        ['P2', 'Scenario Knight'],
      ])(page);
    },
    'skeleton-key-unblockable': async (page) => {
      await attack(page, [['Scenario Bear', 'P2']]);
      const yes = page.getByRole('button', { name: 'Yes', exact: true });
      await passUntil(page, yes);
      await yes.click();
      const island = page
        .locator('.decision-panel .panel-group')
        .filter({ has: page.getByText('Island', { exact: true }) })
        .getByRole('button', { name: 'Discard', exact: true });
      await passUntil(page, island);
      await island.click();
      await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Island'));
      await expect(life(page, 'P2')).toHaveText('38');
    },
    'skeleton-key-blockable': blocked('Scenario Bear'),
    'vorrac-battlehorns-two-blockers-repaired': twoBlockersRepaired,
    'vorrac-battlehorns-one-blocker-allowed': blocked('Scenario Bear', [['P1', 'Scenario Bear']]),
    'alpha-authority-two-blockers-repaired': twoBlockersRepaired,
    'alpha-authority-one-blocker-allowed': blocked('Scenario Bear', [['P1', 'Scenario Bear']]),
    'goblin-king-walker-unblockable': walker('Scenario Goblin', '38'),
    'goblin-king-no-matching-land': blocked('Scenario Goblin', [['P1', 'Scenario Goblin']]),
    'goblin-king-lord-itself-blockable': lordBlocked('Goblin King'),
    'elvish-champion-walker-unblockable': walker('Scenario Elf', '38'),
    'elvish-champion-no-matching-land': blocked('Scenario Elf', [['P1', 'Scenario Elf']]),
    'elvish-champion-lord-itself-blockable': lordBlocked('Elvish Champion'),
    'master-of-the-pearl-trident-walker-unblockable': walker('Scenario Merfolk', '38'),
    'master-of-the-pearl-trident-no-matching-land': blocked('Scenario Merfolk', [
      ['P1', 'Scenario Merfolk'],
    ]),
    'master-of-the-pearl-trident-lord-itself-blockable': lordBlocked('Master of the Pearl Trident'),
    'lord-of-atlantis-walker-unblockable': walker('Scenario Merfolk', '38'),
    'lord-of-atlantis-no-matching-land': blocked('Scenario Merfolk', [['P1', 'Scenario Merfolk']]),
    'lord-of-atlantis-lord-itself-blockable': lordBlocked('Lord of Atlantis'),
    'eladamri-lord-of-leaves-walker-unblockable': walker('Scenario Elf', '39'),
    'eladamri-lord-of-leaves-no-matching-land': blocked('Scenario Elf', [['P1', 'Scenario Elf']]),
    'eladamri-lord-of-leaves-lord-itself-blockable': lordBlocked('Eladamri, Lord of Leaves'),
    'behind-the-scenes-greater-power-cant-block': unblockable('Scenario Bear', '38'),
    'behind-the-scenes-equal-power-may-block': blocked('Scenario Bear'),
    'shifting-sliver-non-sliver-cant-block': unblockable('Shifting Sliver', '38'),
    'shifting-sliver-sliver-may-block': blocked('Shifting Sliver', [['P2', 'Scenario Sliver']]),
    'cover-of-darkness-chosen-type-unblockable': async (page) => {
      await castCover(page);
      await attack(page, [['Scenario Goblin', 'P2']]);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('39');
      await expect(permanent(page, 'P1', 'Cover of Darkness')).toHaveCount(1);
    },
    'cover-of-darkness-other-type-blockable': async (page) => {
      await castCover(page);
      await attack(page, [['Scenario Bear', 'P2']]);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    },
  };

  /** Cast Cover of Darkness from hand and name Goblin as its creature type. */
  async function castCover(page: Page): Promise<void> {
    const cover = hand(page, 'Cover of Darkness');
    await passUntil(page, cover.and(page.locator('.actionable')));
    await cover.click();
    const modes = page.locator('.source-actions .source-action-row button');
    if ((await modes.count()) > 0) await modes.first().click();
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
    const goblin = page.getByRole('button', { name: 'Goblin', exact: true });
    await passUntil(page, goblin);
    await goblin.click();
    await passUntil(page, permanent(page, 'P1', 'Cover of Darkness'));
  }
}
