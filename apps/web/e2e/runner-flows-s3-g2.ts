import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for PR #89's common blocking line scenarios (group s3-g2). */
export function s3g2Flows(h: Helpers): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

  const actionable = (page: Page): Locator => page.locator('.actionable');
  const confirmButton = (page: Page): Locator =>
    page.getByRole('button', { name: 'Confirm', exact: true });
  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
  const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone).getByRole('img', { name, exact: true });
  const tapBadge = (page: Page, seat: string, name: string): Locator =>
    permanent(page, seat, name).locator('.tap-badge');
  const gameOver = (page: Page): Promise<void> => passUntil(page, logLine(page, /game over/));

  /** Click the button named `name` once it is offered. */
  async function press(page: Page, name: string | RegExp): Promise<void> {
    const button = page.getByRole('button', { name, exact: typeof name === 'string' }).first();
    await passUntil(page, button);
    await button.click();
  }

  /** Click the card once it is castable, then confirm; targets are permanents as [seat, name]. */
  async function cast(
    page: Page,
    card: Locator,
    targets: Array<[string, string]> = [],
  ): Promise<void> {
    await passUntil(page, card.and(actionable(page)));
    await card.click();
    for (const [seat, name] of targets) {
      const target = permanent(page, seat, name).first();
      await expect(target).toHaveClass(/targetable|actionable/);
      await target.click();
    }
    await confirmButton(page).click();
  }

  /** Cast `name` from hand at the spell `spell` on the stack. */
  async function castAtSpell(page: Page, name: string, spell: string): Promise<void> {
    const onStack = page.locator('.stack li', { hasText: spell });
    const card = hand(page, name);
    await passUntil(page, onStack.and(page.locator('li')));
    await passUntil(page, card.and(actionable(page)));
    await card.click();
    await expect(onStack.first()).toHaveClass(/targetable/);
    await onStack.first().click();
    await confirmButton(page).click();
  }

  /** Activate the first ability of a permanent once it is offered. */
  async function activate(page: Page, source: Locator, ability?: RegExp): Promise<void> {
    await passUntil(page, source.and(actionable(page)));
    await source.click();
    const action = page.locator('.source-actions .source-action-row button');
    if (ability !== undefined && (await action.count()) > 0)
      await action.filter({ hasText: ability }).first().click();
    const confirm = confirmButton(page);
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
  }

  /** Answer the pending "Target 1 of 1" prompt by clicking a seat's header, then confirm. */
  async function targetSeat(page: Page, seat: string): Promise<void> {
    await expect(page.getByText(/Target 1 of 1/).first()).toBeVisible();
    const header =
      seat === 'P1'
        ? page.locator('.human-zone > header')
        : page.locator(`.opponent[data-seat="${seat}"] > header`);
    await header.click();
    await confirmButton(page).click();
  }

  /** P2 attacks: pass until the block prompt, then P1 blocks Scenario Bear with `blocker`. */
  async function blockBear(page: Page, blocker: string): Promise<void> {
    const declare = page.getByRole('button', { name: /Declare blockers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: blocker })
      .getByRole('button', { name: 'Scenario Bear' })
      .click();
    await page.getByRole('button', { name: 'Confirm blocks' }).click();
  }

  // ── Ancient Stone Idol: costs {1} less per attacking creature ────────────────────────────────
  const idol: Flow = async (page) => {
    await cast(page, hand(page, 'Ancient Stone Idol'));
    await passStackUntil(page, permanent(page, 'P1', 'Ancient Stone Idol'));
    await blockBear(page, 'Ancient Stone Idol');
    await gameOver(page);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    await expect(permanent(page, 'P1', 'Ancient Stone Idol')).toHaveCount(1);
  };

  // ── Arwen's Gift: scry 2, draw two ────────────────────────────────────────────────────────────
  const gift: Flow = async (page) => {
    await cast(page, hand(page, "Arwen's Gift"));
    await press(page, 'Keep Scenario Elk on top');
    await press(page, 'Keep Scenario Owl on top');
    await press(page, 'Keep current order');
    await passUntil(page, hand(page, 'Scenario Owl'));
    await expect(hand(page, 'Scenario Elk')).toHaveCount(1);
    await expect(inZone(page, 'P1', 'Graveyard', "Arwen's Gift")).toHaveCount(1);
  };

  // ── Locks on activated abilities: the source is never offered ────────────────────────────────
  const locked =
    (sources: Array<[string, string]>, lock: string): Flow =>
    async (page) => {
      for (const [seat, name] of sources) {
        await expect(permanent(page, seat, name)).toHaveCount(1);
      }
      await expect(permanent(page, 'P1', lock)).toHaveCount(1);
      // With nothing to activate, the engine asks P1 nothing and the scripted game ends at once.
      await gameOver(page);
      for (const [seat, name] of sources) {
        await expect(permanent(page, seat, name)).not.toHaveClass(/actionable/);
        await expect(tapBadge(page, seat, name)).toHaveCount(0);
      }
      await expect(life(page, 'P1')).toHaveText('40');
    };
  const allowed =
    (source: string): Flow =>
    async (page) => {
      await activate(page, permanent(page, 'P1', source));
      await passUntil(page, life(page, 'P1').filter({ hasText: '41' }));
      await expect(life(page, 'P1')).toHaveText('41');
    };

  // ── Opponents' permanents enter tapped (Frozen Aether, Loxodon Gatekeeper) ───────────────────
  const enterTapped =
    (lock: string): Flow =>
    async (page) => {
      await passUntil(page, permanent(page, 'P2', 'Scenario Rock'));
      for (const name of ['Forest', 'Scenario Bear', 'Scenario Rock'])
        await expect(tapBadge(page, 'P2', name)).toHaveCount(1);
      await expect(permanent(page, 'P1', lock)).toHaveCount(1);
    };
  const enterUntapped = (): Flow => async (page) => {
    await passUntil(page, hand(page, 'Forest').and(actionable(page)));
    await hand(page, 'Forest').click();
    const play = page.locator('.source-actions').getByRole('button', { name: /^Play/ }).first();
    if (await play.isVisible()) await play.click();
    await passUntil(page, permanent(page, 'P1', 'Forest'));
    await cast(page, hand(page, 'Scenario Bear'));
    await passStackUntil(page, permanent(page, 'P1', 'Scenario Bear'));
    await cast(page, hand(page, 'Scenario Rock'));
    await passStackUntil(page, permanent(page, 'P1', 'Scenario Rock'));
    for (const name of ['Forest', 'Scenario Bear', 'Scenario Rock'])
      await expect(tapBadge(page, 'P1', name)).toHaveCount(0);
  };

  // ── Counter spells that target your permanent (Keep Safe, Turn Aside) ────────────────────────
  const counterBolt =
    (name: string, drew: boolean): Flow =>
    async (page) => {
      await castAtSpell(page, name, 'Scenario Bolt');
      await passStackUntil(page, inZone(page, 'P1', 'Graveyard', name));
      await gameOver(page);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      await expect(life(page, 'P1')).toHaveText('40');
      await expect(hand(page, 'Scenario Elk')).toHaveCount(drew ? 1 : 0);
    };

  // ── Wizard's Retort ──────────────────────────────────────────────────────────────────────────
  const retort: Flow = async (page) => {
    await castAtSpell(page, "Wizard's Retort", 'Scenario Bear');
    await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Bear'));
    await gameOver(page);
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(inZone(page, 'P1', 'Graveyard', "Wizard's Retort")).toHaveCount(1);
  };

  // ── Shelter ───────────────────────────────────────────────────────────────────────────────────
  const shelter =
    (color: string, survives: boolean): Flow =>
    async (page) => {
      await passUntil(page, page.locator('.stack li', { hasText: 'Scenario Bolt' }));
      await cast(page, hand(page, 'Shelter'), [['P1', 'Scenario Bear']]);
      await press(page, `Protection from ${color}`);
      await gameOver(page);
      await expect(hand(page, 'Scenario Elk')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
      if (survives) await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      else {
        await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
        await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      }
    };

  return {
    'ancient-stone-idol-two-attackers': idol,
    'ancient-stone-idol-non-attackers-uncounted': idol,
    'arwens-gift-two-legends': gift,
    'arwens-gift-one-legend': gift,
    'clarion-conqueror-locks-artifact-creature-planeswalker': locked(
      [
        ['P1', 'Scenario Wand'],
        ['P1', 'Scenario Squire'],
        ['P1', 'Scenario Walker'],
      ],
      'Clarion Conqueror',
    ),
    'clarion-conqueror-enchantment-ability-allowed': allowed('Scenario Totem'),
    'null-rod-locks-artifact-ability': locked([['P1', 'Scenario Wand']], 'Null Rod'),
    'null-rod-creature-ability-allowed': allowed('Scenario Squire'),
    'stony-silence-locks-artifact-ability': locked([['P1', 'Scenario Wand']], 'Stony Silence'),
    'stony-silence-creature-ability-allowed': allowed('Scenario Squire'),
    'dissipate-exiles-countered-spell': async (page) => {
      await castAtSpell(page, 'Dissipate', 'Scenario Bear');
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
      await gameOver(page);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
      await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Dissipate')).toHaveCount(1);
    },
    'dissipate-uncounterable-resolves': async (page) => {
      await castAtSpell(page, 'Dissipate', 'Scenario Ward Bolt');
      await passStackUntil(page, inZone(page, 'P1', 'Graveyard', 'Dissipate'));
      await gameOver(page);
      await expect(life(page, 'P1')).toHaveText('37');
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Ward Bolt')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Ward Bolt')).toHaveCount(0);
    },
    'frozen-aether-opponent-permanents-tapped': enterTapped('Frozen Aether'),
    'frozen-aether-own-permanents-untapped': enterUntapped(),
    'loxodon-gatekeeper-opponent-permanents-tapped': enterTapped('Loxodon Gatekeeper'),
    'loxodon-gatekeeper-own-permanents-untapped': enterUntapped(),
    'hushwing-gryff-creature-entering-no-trigger': async (page) => {
      await cast(page, hand(page, 'Scenario Sprout'));
      await passStackUntil(page, permanent(page, 'P1', 'Scenario Sprout'));
      await gameOver(page);
      await expect(life(page, 'P1')).toHaveText('40');
      await expect(logLine(page, /Scenario Sprout[^]*gain/i)).toHaveCount(0);
    },
    'hushwing-gryff-noncreature-still-triggers': async (page) => {
      await cast(page, hand(page, 'Scenario Shrine'));
      await passUntil(page, life(page, 'P1').filter({ hasText: '43' }));
      await expect(permanent(page, 'P1', 'Scenario Shrine')).toHaveCount(1);
    },
    'keep-safe-counters-spell-targeting-your-permanent': counterBolt('Keep Safe', true),
    'keep-safe-spell-targeting-you-not-counterable': async (page) => {
      await passUntil(page, life(page, 'P1').filter({ hasText: '37' }));
      await expect(hand(page, 'Keep Safe')).toHaveCount(1);
      await expect(hand(page, 'Keep Safe')).not.toHaveClass(/actionable/);
      await expect(hand(page, 'Scenario Elk')).toHaveCount(0);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
    },
    'turn-aside-counters-spell-targeting-your-permanent': counterBolt('Turn Aside', false),
    'turn-aside-spell-targeting-opponents-permanent-not-counterable': async (page) => {
      await passUntil(page, inZone(page, 'P2', 'Graveyard', 'Scenario Wolf'));
      await expect(hand(page, 'Turn Aside')).toHaveCount(1);
      await expect(hand(page, 'Turn Aside')).not.toHaveClass(/actionable/);
      await expect(permanent(page, 'P2', 'Scenario Wolf')).toHaveCount(0);
    },
    'wizards-retort-with-wizard': retort,
    'wizards-retort-without-wizard': retort,
    'remorseful-cleric-exiles-target-graveyard': async (page) => {
      await activate(page, permanent(page, 'P1', 'Remorseful Cleric'));
      await targetSeat(page, 'P2');
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Bolt')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P3', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Remorseful Cleric')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Wolf')).toHaveCount(1);
    },
    'remorseful-cleric-can-exile-itself': async (page) => {
      await activate(page, permanent(page, 'P1', 'Remorseful Cleric'));
      await targetSeat(page, 'P1');
      await passStackUntil(page, inZone(page, 'P1', 'Exile', 'Remorseful Cleric'));
      await expect(inZone(page, 'P1', 'Exile', 'Scenario Wolf')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Remorseful Cleric')).toHaveCount(0);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
    },
    'shelter-protection-from-chosen-color': shelter('R', true),
    'shelter-protection-only-from-chosen-color': shelter('W', false),
  };
}
