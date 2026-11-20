import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Pass = (page: Page, target: Locator) => Promise<void>;
type Flow = (page: Page) => Promise<void>;

const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();
const life = (page: Page, seat: string): Locator =>
  page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
  seatZone(page, seat, zone).getByRole('img', { name, exact: true });
const keywordOn = (page: Page, seat: string, name: string, keyword: string): Locator =>
  permanent(page, seat, name).locator(`.keywords[title*="${keyword}" i]`);

/** Evasion and blocking-restriction scenarios (CR 509.1b, 702.14, 702.28, 702.36). */
export function g3Flows(h: { passUntil: Pass; passStackUntil: Pass }): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

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

  /** A source with one ability goes straight to its prompt; with several it lists them first. */
  async function pickAbility(page: Page, ability: RegExp): Promise<void> {
    const action = page
      .locator('.source-actions .source-action-row button')
      .filter({ hasText: ability })
      .first();
    const prompt = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(action.or(prompt)).toBeVisible();
    if (await action.isVisible()) await action.click();
  }

  /** Activate the ability of `source` matching `ability`, target [seat, name], and let it resolve. */
  async function activateAt(
    page: Page,
    source: Locator,
    ability: RegExp,
    target: [string, string],
  ): Promise<void> {
    await passUntil(page, source.and(page.locator('.actionable')));
    await source.click();
    await pickAbility(page, ability);
    const chosen = permanent(page, target[0], target[1]).first();
    await passUntil(page, chosen.and(page.locator('.targetable, .actionable')));
    await chosen.click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /resolves/));
  }

  /** P1 assigns combat damage among the blockers, then combat ends the game's scripted run. */
  async function assignAll(page: Page): Promise<void> {
    const assign = page.getByRole('button', { name: /^All \d+ damage/ }).first();
    await passUntil(page, assign);
    await assign.click();
  }

  const gameOver = (page: Page): Promise<void> => passUntil(page, logLine(page, /game over/));

  /** The attacker is blocked by one creature only: the other blocker stays untouched. */
  const singleBlockOnly =
    (attacker: string): Flow =>
    async (page) => {
      await attack(page, [[attacker, 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
      await expect(permanent(page, 'P1', attacker)).toHaveCount(1);
    };

  /** Both Bears block the attacker, P1 assigns damage, and the attacker dies. */
  const doubleBlockAllowed =
    (attacker: string): Flow =>
    async (page) => {
      await attack(page, [[attacker, 'P2']]);
      await assignAll(page);
      await passUntil(page, inZone(page, 'P1', 'Graveyard', attacker));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P1', attacker)).toHaveCount(0);
    };

  /** The attacker cannot be blocked: no blocker is offered and it connects. */
  const unblockable =
    (attacker: string, blockerName: string, expectedLife: string): Flow =>
    async (page) => {
      await attack(page, [[attacker, 'P2']]);
      await passUntil(page, logLine(page, /game over/));
      await expect(life(page, 'P2')).toHaveText(expectedLife);
      await expect(permanent(page, 'P2', blockerName)).toHaveCount(1);
    };

  /** The attacker is blocked and both creatures die. */
  const tradeBlock =
    (attacker: string, blockerName: string): Flow =>
    async (page) => {
      await attack(page, [[attacker, 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', blockerName));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P2', blockerName)).toHaveCount(0);
    };

  return {
    'serpent-of-yawning-depths-kraken-may-block': async (page) => {
      await attack(page, [['Serpent of Yawning Depths', 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Kraken'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P2', 'Scenario Kraken')).toHaveCount(0);
    },
    'serpent-of-yawning-depths-bear-cannot-block': unblockable(
      'Serpent of Yawning Depths',
      'Scenario Bear',
      '34',
    ),
    'serpent-of-yawning-depths-other-creature-unaffected': async (page) => {
      await attack(page, [['Scenario Ogre', 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    },
    'flopsie-single-block-only': singleBlockOnly("Flopsie, Bumi's Buddy"),
    'flopsie-double-block-allowed': doubleBlockAllowed('Scenario Cub'),
    'challenger-troll-single-block-only': singleBlockOnly('Challenger Troll'),
    'challenger-troll-double-block-allowed': doubleBlockAllowed('Scenario Cub'),
    'michelangelo-single-block-only': singleBlockOnly('Scenario Ogre'),
    'michelangelo-double-block-allowed': doubleBlockAllowed('Scenario Ogre'),
    'sunder-shaman-single-block-only': singleBlockOnly('Sunder Shaman'),
    'sunder-shaman-double-block-allowed': doubleBlockAllowed('Scenario Cub'),
    'troll-of-khazad-dum-two-blockers-not-enough': unblockable(
      'Troll of Khazad-dûm',
      'Scenario Bear',
      '34',
    ),
    'troll-of-khazad-dum-three-blockers-may-block': async (page) => {
      await attack(page, [['Troll of Khazad-dûm', 'P2']]);
      await assignAll(page);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P1', 'Troll of Khazad-dûm')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Mite')).not.toHaveCount(0);
    },
    'rampaging-ceratops-two-blockers-not-enough': unblockable(
      'Rampaging Ceratops',
      'Scenario Bear',
      '35',
    ),
    'rampaging-ceratops-three-blockers-may-block': async (page) => {
      await attack(page, [['Rampaging Ceratops', 'P2']]);
      await assignAll(page);
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P1', 'Rampaging Ceratops')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Mite')).not.toHaveCount(0);
    },
    'ant-man-greater-power-cannot-block': unblockable(
      'Ant-Man, Elusive Avenger',
      'Scenario Bear',
      '39',
    ),
    'ant-man-equal-power-may-block': tradeBlock('Ant-Man, Elusive Avenger', 'Scenario Mite'),
    'shizo-deaths-storehouse-fear-green-creature-cannot-block': async (page) => {
      await activateAt(page, permanent(page, 'P1', "Shizo, Death's Storehouse"), /gains fear/, [
        'P1',
        'Scenario Legend',
      ]);
      await expect(keywordOn(page, 'P1', 'Scenario Legend', 'fear')).toHaveCount(1);
      await unblockable('Scenario Legend', 'Scenario Bear', '38')(page);
    },
    'shizo-deaths-storehouse-fear-black-creature-may-block': async (page) => {
      await activateAt(page, permanent(page, 'P1', "Shizo, Death's Storehouse"), /gains fear/, [
        'P1',
        'Scenario Legend',
      ]);
      await expect(keywordOn(page, 'P1', 'Scenario Legend', 'fear')).toHaveCount(1);
      await attack(page, [['Scenario Legend', 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Zombie'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Legend')).toHaveCount(1);
    },
    'shizo-deaths-storehouse-fear-only-legendary-target': async (page) => {
      const shizo = permanent(page, 'P1', "Shizo, Death's Storehouse");
      await passUntil(page, shizo.and(page.locator('.actionable')));
      await shizo.click();
      await pickAbility(page, /gains fear/);
      const legend = permanent(page, 'P1', 'Scenario Legend').first();
      await expect(legend).toHaveClass(/targetable|actionable/);
      await expect(permanent(page, 'P1', 'Scenario Bear').first()).not.toHaveClass(/targetable/);
      await legend.click();
      await confirmButton(page).click();
      await passStackUntil(page, logLine(page, /resolves/));
      await expect(keywordOn(page, 'P1', 'Scenario Legend', 'fear')).toHaveCount(1);
      await expect(keywordOn(page, 'P1', 'Scenario Bear', 'fear')).toHaveCount(0);
      await expect(
        permanent(page, 'P1', "Shizo, Death's Storehouse").locator('.tap-badge'),
      ).toHaveCount(1);
    },
    'shadow-rift-shadow-attacker-unblockable': async (page) => {
      await castShadowRift(page);
      await expect(keywordOn(page, 'P1', 'Scenario Bear', 'shadow')).toHaveCount(1);
      await expect(hand(page, 'Forest')).toHaveCount(1);
      await unblockable('Scenario Bear', 'Scenario Ogre', '38')(page);
    },
    'shadow-rift-shadow-blocker-may-block': async (page) => {
      await castShadowRift(page);
      await expect(keywordOn(page, 'P1', 'Scenario Bear', 'shadow')).toHaveCount(1);
      await attack(page, [['Scenario Bear', 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Shade'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    },
    'dauthi-embrace-shadow-attacker-unblockable': async (page) => {
      await activateAt(page, permanent(page, 'P1', 'Dauthi Embrace'), /gains shadow/, [
        'P1',
        'Scenario Bear',
      ]);
      await expect(keywordOn(page, 'P1', 'Scenario Bear', 'shadow')).toHaveCount(1);
      await unblockable('Scenario Bear', 'Scenario Ogre', '38')(page);
    },
    'dauthi-embrace-shadow-blocker-may-block': async (page) => {
      await activateAt(page, permanent(page, 'P1', 'Dauthi Embrace'), /gains shadow/, [
        'P1',
        'Scenario Bear',
      ]);
      await expect(keywordOn(page, 'P1', 'Scenario Bear', 'shadow')).toHaveCount(1);
      await attack(page, [['Scenario Bear', 'P2']]);
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Shade'));
      await gameOver(page);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    },
    'chasm-skulker-dies-with-counters-makes-squids': async (page) => {
      await attack(page, [['Chasm Skulker', 'P2']]);
      await passUntil(page, permanent(page, 'P1', 'Squid').first());
      // Identical tokens share one tile with a copy-count badge.
      await expect(permanent(page, 'P1', 'Squid').locator('.stack-count-badge')).toHaveText('×2');
      await expect(inZone(page, 'P1', 'Graveyard', 'Chasm Skulker')).toHaveCount(1);
    },
    'chasm-skulker-squid-has-islandwalk': async (page) => {
      await attack(page, [['Chasm Skulker', 'P2']]);
      await passUntil(page, permanent(page, 'P1', 'Squid').first());
      await expect(permanent(page, 'P1', 'Squid')).toHaveCount(1);
      await expect(keywordOn(page, 'P1', 'Squid', 'islandwalk')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Chasm Skulker')).toHaveCount(1);
    },
    'chasm-skulker-dies-without-counters-makes-none': async (page) => {
      await attack(page, [['Chasm Skulker', 'P2']]);
      await passUntil(page, inZone(page, 'P1', 'Graveyard', 'Chasm Skulker'));
      await gameOver(page);
      await expect(permanent(page, 'P1', 'Squid')).toHaveCount(0);
    },
  };

  /** Cast Shadow Rift at P1's Scenario Bear and wait for it to resolve. */
  async function castShadowRift(page: Page): Promise<void> {
    const rift = hand(page, 'Shadow Rift');
    await passUntil(page, rift.and(page.locator('.actionable')));
    await rift.click();
    const bear = permanent(page, 'P1', 'Scenario Bear').first();
    await expect(bear).toHaveClass(/targetable|actionable/);
    await bear.click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Shadow Rift[^]*resolves/));
  }
}
