import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for PR #89's common blocking line scenarios (group s3-g1). */
export function s3g1Flows(h: Helpers): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

  const confirmButton = (page: Page): Locator =>
    page.getByRole('button', { name: 'Confirm', exact: true });
  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
  const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone).getByRole('img', { name, exact: true });
  const actionable = (page: Page): Locator => page.locator('.actionable');

  /** A spell that cannot be cast stays in hand: checked once the game waits on a pass or has ended. */
  async function expectStaysInHand(page: Page, name: string): Promise<void> {
    await expect(
      page
        .getByRole('button', { name: 'Pass priority', exact: true })
        .or(logLine(page, /game over/)),
    ).toBeVisible();
    const card = hand(page, name);
    await expect(card).toBeVisible();
    await expect(card).not.toHaveClass(/actionable/);
    await expect(card).toHaveCount(1);
  }

  /**
   * Cast a hand card: pick the "Cast" mode when the card offers several, choose each [seat, name]
   * permanent target, confirm, and wait for the spell to resolve.
   */
  async function cast(
    page: Page,
    name: string,
    options: { targets?: Array<[string, string]>; player?: string; resolves: RegExp },
  ): Promise<void> {
    const source = hand(page, name);
    await passUntil(page, source.and(actionable(page)));
    await source.click();
    const modes = page.locator('.source-actions .source-action-row button');
    if ((await modes.count()) > 1)
      await modes
        .filter({ has: page.locator('span', { hasText: /^Cast$/ }) })
        .first()
        .click();
    for (const [seat, target] of options.targets ?? []) {
      const chosen = permanent(page, seat, target).first();
      await expect(chosen).toHaveClass(/targetable|actionable/);
      await chosen.click();
    }
    if (options.player !== undefined) await clickSeat(page, options.player);
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, options.resolves));
  }

  /** Click a player's name bar, the way a player target is chosen. */
  async function clickSeat(page: Page, seat: string): Promise<void> {
    const header =
      seat === 'P1'
        ? page.locator('.human-zone > header')
        : page.locator(`.opponent[data-seat="${seat}"] > header`);
    await header.click();
  }

  /** Answer the pending trigger's "Target 1 of 1" prompt with a player seat. */
  async function targetPlayer(page: Page, seat: string): Promise<void> {
    await passStackUntil(page, page.getByText(/Target 1 of 1/).first());
    await clickSeat(page, seat);
    await confirmButton(page).click();
  }

  /** Cast a spell that targets a player (here P2) and wait for it to resolve. */
  async function castAtPlayer(page: Page, name: string, seat: string, resolves: RegExp) {
    await cast(page, name, { player: seat, resolves });
  }

  /** Play a land from your hand through its own menu when the card offers more than one action. */
  async function playLand(page: Page, name: string): Promise<void> {
    const land = hand(page, name);
    await passUntil(page, land.and(actionable(page)));
    await land.click();
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
    await passStackUntil(page, button);
    await button.click();
  }

  const gameOver = (page: Page): Promise<void> => passUntil(page, logLine(page, /game over/));

  // ── Exile target player's graveyard (Agent of Erebos, Boggart Trawler) ───────────────────────
  const exiledFromGraveyard = async (page: Page, seat: string): Promise<void> => {
    await passStackUntil(page, inZone(page, seat, 'Exile', 'Scenario Bear'));
    await expect(inZone(page, seat, 'Graveyard', 'Scenario Bear')).toHaveCount(0);
  };

  // ── Protection from the chosen color, then an attack the red Goblin can or can't block ───────
  async function finishProtected(
    page: Page,
    outcome: { p2: number; goblin: 'battlefield' | 'graveyard' },
  ): Promise<void> {
    await attack(page, 'Scenario Bear');
    await gameOver(page);
    await expect(life(page, 'P2')).toHaveText(String(outcome.p2));
    if (outcome.goblin === 'battlefield')
      await expect(permanent(page, 'P2', 'Scenario Goblin')).toHaveCount(1);
    else {
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Goblin')).toHaveCount(1);
      await expect(permanent(page, 'P2', 'Scenario Goblin')).toHaveCount(0);
    }
  }
  /** Emerge Unscathed / Gods Willing: cast on the Bear, pick a color, attack. */
  const protectFlow =
    (
      name: string,
      color: 'R' | 'G',
      outcome: { p2: number; goblin: 'battlefield' | 'graveyard' },
      scry = false,
    ): Flow =>
    async (page) => {
      const source = hand(page, name);
      await passUntil(page, source.and(actionable(page)));
      await source.click();
      const target = permanent(page, 'P1', 'Scenario Bear').first();
      await expect(target).toHaveClass(/targetable|actionable/);
      await target.click();
      await confirmButton(page).click();
      await press(page, `Protection from ${color}`);
      if (scry) await press(page, 'Keep Forest on top');
      await finishProtected(page, outcome);
    };

  /** P2's scripted Scenario Bear is on the stack; `respond` is what P1 does about it. */
  async function bearOnStack(page: Page): Promise<Locator> {
    const bear = page.locator('.stack li', { hasText: 'Scenario Bear' });
    await passUntil(page, bear.and(page.locator('li')));
    return bear;
  }

  async function counterBear(page: Page, spell: string): Promise<void> {
    const bear = await bearOnStack(page);
    const card = hand(page, spell);
    await passUntil(page, card.and(actionable(page)));
    await card.click();
    await expect(bear.first()).toHaveClass(/targetable/);
    await bear.first().click();
    await confirmButton(page).click();
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(inZone(page, 'P1', 'Graveyard', spell)).toHaveCount(1);
  }

  async function cannotCounterBear(page: Page, spell: string): Promise<void> {
    // With nothing castable the viewer may yield for P1, so wait for Bear to resolve or the game to end.
    await gameOver(page);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(1);
    await expect(hand(page, spell)).toHaveCount(1);
    await expect(hand(page, spell)).not.toHaveClass(/actionable/);
  }

  /** Destroy your own creature with Scenario Snuff; its dies trigger picks its only legal target. */
  async function snuffOwn(page: Page, creature: string): Promise<void> {
    await cast(page, 'Scenario Snuff', {
      targets: [['P1', creature]],
      resolves: /Scenario Snuff[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', creature));
  }

  const dies = (creature: string) => ({
    returns: (async (page: Page) => {
      await snuffOwn(page, creature);
      await passStackUntil(page, hand(page, 'Scenario Relic'));
      await expect(inZone(page, 'P1', 'Graveyard', creature)).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Relic')).toHaveCount(0);
    }) as Flow,
    staysPut: (async (page: Page) => {
      await snuffOwn(page, creature);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(hand(page, creature)).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', creature)).toHaveCount(1);
    }) as Flow,
  });

  return {
    'agent-of-erebos-exiles-target-graveyard': async (page) => {
      await cast(page, 'Agent of Erebos', { resolves: /Agent of Erebos[^]*resolves/ });
      await targetPlayer(page, 'P2');
      await exiledFromGraveyard(page, 'P2');
    },
    'agent-of-erebos-nonenchantment-does-not-trigger': async (page) => {
      await cast(page, 'Scenario Bear', { resolves: /Scenario Bear[^]*resolves/ });
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Bear')).toHaveCount(0);
    },
    'boggart-trawler-exiles-target-graveyard': async (page) => {
      await cast(page, 'Boggart Trawler // Boggart Bog', {
        resolves: /Boggart Trawler[^]*resolves/,
      });
      await targetPlayer(page, 'P2');
      await exiledFromGraveyard(page, 'P2');
    },
    'boggart-trawler-leaves-other-graveyards': async (page) => {
      await cast(page, 'Boggart Trawler // Boggart Bog', {
        resolves: /Boggart Trawler[^]*resolves/,
      });
      await targetPlayer(page, 'P1');
      await exiledFromGraveyard(page, 'P1');
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Bear')).toHaveCount(0);
    },
    'arcane-laboratory-second-spell-blocked': async (page) => {
      await cast(page, 'Scenario Tonic', { resolves: /Scenario Tonic[^]*resolves/ });
      await expect(life(page, 'P1')).toHaveText('41');
      await expectStaysInHand(page, 'Scenario Salve');
    },
    'arcane-laboratory-first-spell-and-land-allowed': async (page) => {
      await cast(page, 'Scenario Tonic', { resolves: /Scenario Tonic[^]*resolves/ });
      await expect(life(page, 'P1')).toHaveText('41');
      await playLand(page, 'Swamp');
      await expect(hand(page, 'Swamp')).toHaveCount(0);
    },
    'cyan-vengeful-samurai-cost-reduced-per-creature-card': async (page) => {
      await cast(page, 'Cyan, Vengeful Samurai', {
        resolves: /Cyan, Vengeful Samurai[^]*resolves/,
      });
      await expect(permanent(page, 'P1', 'Cyan, Vengeful Samurai')).toHaveCount(1);
    },
    'cyan-vengeful-samurai-noncreature-cards-do-not-reduce': async (page) => {
      await expectStaysInHand(page, 'Cyan, Vengeful Samurai');
    },
    'junk-diver-returns-another-artifact-card': dies('Junk Diver').returns,
    'junk-diver-does-not-return-itself': dies('Junk Diver').staysPut,
    'myr-retriever-returns-another-artifact-card': dies('Myr Retriever').returns,
    'myr-retriever-does-not-return-itself': dies('Myr Retriever').staysPut,
    'torpor-orb-creature-enters-trigger-suppressed': async (page) => {
      await cast(page, 'Scenario Mystic', { resolves: /Scenario Mystic[^]*resolves/ });
      await expect(permanent(page, 'P1', 'Scenario Mystic')).toHaveCount(1);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(life(page, 'P1')).toHaveText('40');
    },
    'torpor-orb-noncreature-enters-trigger-works': async (page) => {
      await cast(page, 'Scenario Shrine', { resolves: /Scenario Shrine[^]*resolves/ });
      await expect(life(page, 'P1')).toHaveText('43');
    },
    'wizards-lightning-cost-reduced-with-wizard': async (page) => {
      await castAtPlayer(page, "Wizard's Lightning", 'P2', /Wizard's Lightning[^]*resolves/);
      await expect(life(page, 'P2')).toHaveText('37');
    },
    'wizards-lightning-full-cost-without-wizard': async (page) => {
      await expectStaysInHand(page, "Wizard's Lightning");
      await expect(life(page, 'P2')).toHaveText('40');
    },
    'stoic-rebuttal-metalcraft-reduces-cost': (page) => counterBear(page, 'Stoic Rebuttal'),
    'stoic-rebuttal-full-cost-below-metalcraft': (page) =>
      cannotCounterBear(page, 'Stoic Rebuttal'),
    'lookouts-dispersal-cost-reduced-with-pirate': (page) =>
      counterBear(page, "Lookout's Dispersal"),
    'lookouts-dispersal-full-cost-without-pirate': (page) =>
      cannotCounterBear(page, "Lookout's Dispersal"),
    'primeval-protector-cost-reduced-per-opponent-creature': async (page) => {
      await cast(page, 'Primeval Protector', { resolves: /Primeval Protector[^]*resolves/ });
      await expect(permanent(page, 'P1', 'Primeval Protector')).toHaveCount(1);
    },
    'primeval-protector-own-creatures-do-not-reduce': async (page) => {
      await expectStaysInHand(page, 'Primeval Protector');
    },
    'emerge-unscathed-protection-from-chosen-color': protectFlow('Emerge Unscathed', 'R', {
      p2: 38,
      goblin: 'battlefield',
    }),
    'emerge-unscathed-other-color-can-be-blocked': protectFlow('Emerge Unscathed', 'G', {
      p2: 40,
      goblin: 'graveyard',
    }),
    'gods-willing-protection-from-chosen-color': protectFlow(
      'Gods Willing',
      'R',
      { p2: 38, goblin: 'battlefield' },
      true,
    ),
    'gods-willing-other-color-can-be-blocked': protectFlow(
      'Gods Willing',
      'G',
      { p2: 40, goblin: 'graveyard' },
      true,
    ),
    'sejiri-steppe-protection-from-chosen-color': async (page) => {
      await playLand(page, 'Sejiri Steppe');
      await expect(permanent(page, 'P1', 'Sejiri Steppe').locator('.tap-badge')).toHaveCount(1);
      await press(page, 'Protection from R');
      await finishProtected(page, { p2: 38, goblin: 'battlefield' });
    },
    'sejiri-steppe-other-color-can-be-blocked': async (page) => {
      await playLand(page, 'Sejiri Steppe');
      await expect(permanent(page, 'P1', 'Sejiri Steppe').locator('.tap-badge')).toHaveCount(1);
      await press(page, 'Protection from G');
      await finishProtected(page, { p2: 40, goblin: 'graveyard' });
    },
  };
}
