import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Advance = (page: Page, target: Locator) => Promise<void>;

/**
 * Viewer flows for the graveyard and hand runner scenarios (transmute, graveyard self-return,
 * embalm, eternalize, the Colossus shuffle, Spirit Guides and the "you control a ..." lands). The
 * viewer plays P1's steps by hand; the other seats answer as the server's scripted seats.
 */
export function g5Flows(h: { passUntil: Advance; passStackUntil: Advance }): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

  const confirmButton = (page: Page): Locator =>
    page.getByRole('button', { name: 'Confirm', exact: true });
  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
  const thumb = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone)
      .locator('.zone-card-thumb')
      .filter({ has: page.getByRole('img', { name, exact: true }) });
  const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone).getByRole('img', { name, exact: true });
  const tapped = (page: Page, name: string): Locator =>
    permanent(page, 'P1', name).locator('.tap-badge');

  /** Open `source`'s action menu once it is offered, pick the row matching `ability`, and confirm. */
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

  /** The first decision-panel button in the option group about the card named `card`. */
  const choiceFor = (page: Page, card: string): Locator =>
    page
      .locator('.decision-panel .panel-group')
      .filter({ has: page.getByText(card, { exact: true }) })
      .getByRole('button')
      .first();

  /** Cast a hand card at each target (a seat header or a permanent) and wait for it to resolve. */
  async function cast(
    page: Page,
    name: string,
    options: { player?: string; resolves: RegExp; wait?: false },
  ): Promise<void> {
    const card = hand(page, name);
    await passUntil(page, card.and(page.locator('.actionable')));
    await card.click();
    const modes = page.locator('.source-actions .source-action-row button');
    if ((await modes.count()) > 1)
      await modes
        .filter({ has: page.locator('span', { hasText: /^Cast$/ }) })
        .first()
        .click();
    if (options.player !== undefined) {
      const header = page.locator(
        options.player === 'P1'
          ? '.human-zone > header'
          : `.opponent[data-seat="${options.player}"] > header`,
      );
      await expect(page.getByText(/Target 1 of 1/).first()).toBeVisible();
      await header.click();
    }
    await confirmButton(page).click();
    if (options.wait !== false) await passStackUntil(page, logLine(page, options.resolves));
  }

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

  /**
   * While P1 holds priority (Scenario Glimpse is castable), `source` is in view but offers no
   * action; then cast Scenario Glimpse, the scenario's only step.
   */
  async function notOffered(page: Page, source: Locator): Promise<void> {
    const glimpse = hand(page, 'Scenario Glimpse');
    await passUntil(page, glimpse.and(page.locator('.actionable')));
    await expect(source).toBeVisible();
    await expect(source).not.toHaveClass(/actionable/);
    await cast(page, 'Scenario Glimpse', { resolves: /Scenario Glimpse[^]*resolves/ });
  }

  // ── Transmute ────────────────────────────────────────────────────────────────────────────────
  const transmuteFinds =
    (card: string, match: string, other: string): Flow =>
    async (page) => {
      await activate(page, hand(page, card), /Transmute/);
      const take = choiceFor(page, match);
      await passStackUntil(page, take);
      await expect(choiceFor(page, other)).toHaveCount(0);
      await take.click();
      await passStackUntil(page, hand(page, match));
      await expect(inZone(page, 'P1', 'Graveyard', card)).toHaveCount(1);
      await expect(hand(page, other)).toHaveCount(0);
    };
  const transmuteMisses =
    (card: string, other: string): Flow =>
    async (page) => {
      await activate(page, hand(page, card), /Transmute/);
      await passStackUntil(page, logLine(page, /Transmute[^]*resolves/));
      await expect(inZone(page, 'P1', 'Graveyard', card)).toHaveCount(1);
      await expect(hand(page, other)).toHaveCount(0);
      await expect(hand(page, card)).toHaveCount(0);
    };

  // ── Graveyard self-return ────────────────────────────────────────────────────────────────────
  const returns =
    (card: string, counters?: string): Flow =>
    async (page) => {
      await activate(page, thumb(page, 'P1', 'Graveyard', card), /Return this card/);
      await passStackUntil(page, permanent(page, 'P1', card));
      await expect(tapped(page, card)).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', card)).toHaveCount(0);
      if (counters !== undefined)
        await expect(permanent(page, 'P1', card).locator('.counters')).toHaveText(counters);
    };
  const castFromHand =
    (card: string): Flow =>
    async (page) => {
      const source = hand(page, card);
      await passUntil(page, source.and(page.locator('.actionable')));
      await source.click();
      const rows = page.locator('.source-actions .source-action-row button');
      await expect(rows.filter({ hasText: /Return this card/ })).toHaveCount(0);
      if ((await rows.count()) > 0)
        await rows
          .filter({ hasText: /^(Cast|Play)/ })
          .first()
          .click();
      const confirm = confirmButton(page);
      if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
      await passStackUntil(page, permanent(page, 'P1', card));
      await expect(tapped(page, card)).toHaveCount(0);
    };

  // ── Embalm and eternalize ────────────────────────────────────────────────────────────────────
  const tokenCopy =
    (card: string, keyword: 'Embalm' | 'Eternalize', pt: string, after?: Flow): Flow =>
    async (page) => {
      await activate(page, thumb(page, 'P1', 'Graveyard', card), new RegExp(keyword));
      await passStackUntil(page, permanent(page, 'P1', card));
      await expect(inZone(page, 'P1', 'Exile', card)).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', card)).toHaveCount(0);
      if (after !== undefined) await after(page);
      await expect(permanent(page, 'P1', card).locator('.pt').first()).toContainText(pt);
    };
  const sorcerySpeedOnly =
    (card: string): Flow =>
    async (page) => {
      await notOffered(page, thumb(page, 'P1', 'Graveyard', card));
      await expect(permanent(page, 'P1', card)).toHaveCount(0);
    };

  // ── The Colossus shuffle ─────────────────────────────────────────────────────────────────────
  async function thoughtseizeSelf(page: Page, card: string): Promise<void> {
    await cast(page, 'Thoughtseize', { player: 'P1', resolves: /Thoughtseize/, wait: false });
    const discard = choiceFor(page, card);
    await passStackUntil(page, discard);
    await discard.click();
  }
  const shuffledIn =
    (card: string): Flow =>
    async (page) => {
      await thoughtseizeSelf(page, card);
      await passStackUntil(page, inZone(page, 'P1', 'Graveyard', 'Thoughtseize'));
      await expect(hand(page, card)).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', card)).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Exile', card)).toHaveCount(0);
      await expect(life(page, 'P1')).toHaveText('38');
    };
  const restInPeaceExiles =
    (card: string): Flow =>
    async (page) => {
      await thoughtseizeSelf(page, card);
      const exile = page.getByRole('button', { name: new RegExp(`^Exile ${card}`) });
      await passStackUntil(page, exile);
      await expect(page.getByRole('button', { name: new RegExp(`^Shuffle ${card}`) })).toHaveCount(
        1,
      );
      await exile.click();
      await passStackUntil(page, inZone(page, 'P1', 'Exile', card));
      await expect(hand(page, card)).toHaveCount(0);
    };

  // ── Spirit Guides ────────────────────────────────────────────────────────────────────────────
  const guidePays =
    (guide: string, spell: string, board: boolean, land: string): Flow =>
    async (page) => {
      const spark = spell === 'Scenario Spark';
      await cast(page, spell, {
        ...(spark ? { player: 'P2' } : {}),
        resolves: new RegExp(`${spell}[^]*resolves`),
      });
      if (spark) await expect(life(page, 'P2')).toHaveText('38');
      else await expect(permanent(page, 'P1', spell)).toHaveCount(1);
      if (board) {
        await expect(hand(page, guide)).toHaveCount(1);
        await expect(tapped(page, land)).toHaveCount(1);
      } else {
        await expect(hand(page, guide)).toHaveCount(0);
        await expect(inZone(page, 'P1', 'Exile', guide)).toHaveCount(1);
      }
    };

  return {
    'muddle-the-mixture-transmute': transmuteFinds(
      'Muddle the Mixture',
      'Scenario Bear',
      'Scenario Cub',
    ),
    'muddle-the-mixture-transmute-no-match': transmuteMisses('Muddle the Mixture', 'Scenario Cub'),
    'drift-of-phantasms-transmute': transmuteFinds(
      'Drift of Phantasms',
      'Scenario Cub',
      'Scenario Ogre',
    ),
    'drift-of-phantasms-transmute-no-match': transmuteMisses('Drift of Phantasms', 'Scenario Ogre'),
    'tolaria-west-transmute': transmuteFinds('Tolaria West', 'Scenario Trinket', 'Scenario Sprite'),
    'tolaria-west-transmute-finds-land': async (page) => {
      await activate(page, hand(page, 'Tolaria West'), /Transmute/);
      const forest = choiceFor(page, 'Forest');
      await passStackUntil(page, forest);
      await expect(choiceFor(page, 'Scenario Sprite')).toHaveCount(0);
      await forest.click();
      await passStackUntil(page, hand(page, 'Forest'));
      await expect(inZone(page, 'P1', 'Graveyard', 'Tolaria West')).toHaveCount(1);
    },
    'dimir-infiltrator-transmute': transmuteFinds(
      'Dimir Infiltrator',
      'Scenario Bear',
      'Scenario Cub',
    ),
    'dimir-infiltrator-transmute-no-match': transmuteMisses('Dimir Infiltrator', 'Scenario Cub'),
    'dizzy-spell-transmute': transmuteFinds('Dizzy Spell', 'Scenario Sprite', 'Scenario Bear'),
    'dizzy-spell-transmute-no-match': transmuteMisses('Dizzy Spell', 'Scenario Bear'),

    'reassembling-skeleton-return': returns('Reassembling Skeleton'),
    'reassembling-skeleton-from-hand': castFromHand('Reassembling Skeleton'),
    'drownyard-temple-return': returns('Drownyard Temple'),
    'drownyard-temple-from-hand': castFromHand('Drownyard Temple'),
    'teachers-pest-return': returns("Teacher's Pest"),
    'teachers-pest-from-hand': castFromHand("Teacher's Pest"),
    'persistent-specimen-return': returns('Persistent Specimen'),
    'persistent-specimen-from-hand': castFromHand('Persistent Specimen'),
    'retrofitted-transmogrant-return': returns('Retrofitted Transmogrant', '+1/+1×2'),
    'retrofitted-transmogrant-from-hand': castFromHand('Retrofitted Transmogrant'),
    'bloodsoaked-champion-raid-return': async (page) => {
      const champion = thumb(page, 'P1', 'Graveyard', 'Bloodsoaked Champion');
      await attack(page, 'Scenario Bear');
      await activate(page, champion, /Return this card/);
      await passStackUntil(page, permanent(page, 'P1', 'Bloodsoaked Champion'));
      await expect(tapped(page, 'Bloodsoaked Champion')).toHaveCount(0);
      await passUntil(page, logLine(page, /game over/));
      await expect(life(page, 'P2')).toHaveText('38');
    },
    'bloodsoaked-champion-no-raid': async (page) => {
      await notOffered(page, thumb(page, 'P1', 'Graveyard', 'Bloodsoaked Champion'));
    },
    'haunt-of-the-dead-marshes-return': async (page) => {
      await activate(
        page,
        thumb(page, 'P1', 'Graveyard', 'Haunt of the Dead Marshes'),
        /Return this card/,
      );
      const keep = page.getByRole('button', { name: /^Keep .+ on top$/ });
      await passStackUntil(page, keep);
      await keep.click();
      await passStackUntil(page, permanent(page, 'P1', 'Haunt of the Dead Marshes'));
      await expect(tapped(page, 'Haunt of the Dead Marshes')).toHaveCount(1);
    },
    'haunt-of-the-dead-marshes-no-legend': async (page) => {
      await notOffered(page, thumb(page, 'P1', 'Graveyard', 'Haunt of the Dead Marshes'));
    },

    'sacred-cat-embalm': tokenCopy('Sacred Cat', 'Embalm', '1/1'),
    'sacred-cat-embalm-sorcery-speed': sorcerySpeedOnly('Sacred Cat'),
    'angel-of-sanctions-embalm': tokenCopy('Angel of Sanctions', 'Embalm', '3/4', async (page) => {
      const yes = page.getByRole('button', { name: 'Yes', exact: true });
      await passStackUntil(page, yes);
      await yes.click();
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Rock'));
      await expect(permanent(page, 'P2', 'Scenario Rock')).toHaveCount(0);
    }),
    'angel-of-sanctions-embalm-sorcery-speed': sorcerySpeedOnly('Angel of Sanctions'),
    'aven-wind-guide-embalm': tokenCopy('Aven Wind Guide', 'Embalm', '2/3', async (page) => {
      for (const keyword of ['flying', 'vigilance'])
        await expect(
          permanent(page, 'P1', 'Aven Wind Guide').locator(`.keywords[title*="${keyword}" i]`),
        ).toHaveCount(1);
    }),
    'aven-wind-guide-embalm-sorcery-speed': sorcerySpeedOnly('Aven Wind Guide'),
    'anointer-priest-embalm': tokenCopy('Anointer Priest', 'Embalm', '1/3', async (page) => {
      await passStackUntil(page, life(page, 'P1').filter({ hasText: '41' }));
    }),
    'anointer-priest-embalm-sorcery-speed': sorcerySpeedOnly('Anointer Priest'),
    'fanatic-of-rhonas-eternalize': tokenCopy('Fanatic of Rhonas', 'Eternalize', '4/4'),
    'fanatic-of-rhonas-eternalize-sorcery-speed': sorcerySpeedOnly('Fanatic of Rhonas'),
    'timeless-witness-eternalize': tokenCopy(
      'Timeless Witness',
      'Eternalize',
      '4/4',
      async (page) => {
        await passStackUntil(page, hand(page, 'Scenario Bear'));
      },
    ),
    'timeless-witness-eternalize-sorcery-speed': sorcerySpeedOnly('Timeless Witness'),
    'adorned-pouncer-eternalize': tokenCopy('Adorned Pouncer', 'Eternalize', '4/4'),
    'adorned-pouncer-eternalize-sorcery-speed': sorcerySpeedOnly('Adorned Pouncer'),
    'timeless-dragon-eternalize': tokenCopy('Timeless Dragon', 'Eternalize', '4/4'),
    'timeless-dragon-eternalize-sorcery-speed': sorcerySpeedOnly('Timeless Dragon'),

    'blightsteel-colossus-discard-shuffles': shuffledIn('Blightsteel Colossus'),
    'blightsteel-colossus-rest-in-peace-exile': restInPeaceExiles('Blightsteel Colossus'),
    'darksteel-colossus-discard-shuffles': shuffledIn('Darksteel Colossus'),
    'darksteel-colossus-rest-in-peace-exile': restInPeaceExiles('Darksteel Colossus'),
    'nexus-of-fate-resolves-shuffles': async (page) => {
      await cast(page, 'Nexus of Fate', { resolves: /Nexus of Fate[^]*resolves/ });
      await expect(hand(page, 'Nexus of Fate')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Nexus of Fate')).toHaveCount(0);
    },
    'nexus-of-fate-countered-shuffles': async (page) => {
      await cast(page, 'Nexus of Fate', { resolves: /Nexus of Fate/, wait: false });
      await passStackUntil(page, inZone(page, 'P2', 'Graveyard', 'Counterspell'));
      await expect(hand(page, 'Nexus of Fate')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Nexus of Fate')).toHaveCount(0);
    },

    'simian-spirit-guide-pays-from-hand': guidePays(
      'Simian Spirit Guide',
      'Scenario Spark',
      false,
      'Mountain',
    ),
    'simian-spirit-guide-board-first': guidePays(
      'Simian Spirit Guide',
      'Scenario Spark',
      true,
      'Mountain',
    ),
    'elvish-spirit-guide-pays-from-hand': guidePays(
      'Elvish Spirit Guide',
      'Scenario Sapling',
      false,
      'Forest',
    ),
    'elvish-spirit-guide-board-first': guidePays(
      'Elvish Spirit Guide',
      'Scenario Sapling',
      true,
      'Forest',
    ),

    'bonders-enclave-draw': async (page) => {
      await activate(page, permanent(page, 'P1', "Bonders' Enclave"), /Draw a card/);
      await passStackUntil(page, hand(page, 'Scenario Bear'));
      await expect(tapped(page, "Bonders' Enclave")).toHaveCount(1);
    },
    'bonders-enclave-no-power-4': async (page) => {
      await notOffered(page, permanent(page, 'P1', "Bonders' Enclave"));
    },
    'sliver-hive-token': async (page) => {
      await activate(page, permanent(page, 'P1', 'Sliver Hive'), /Create/);
      await passStackUntil(page, permanent(page, 'P1', 'Sliver'));
      await expect(tapped(page, 'Sliver Hive')).toHaveCount(1);
    },
    'sliver-hive-no-sliver': async (page) => {
      await notOffered(page, permanent(page, 'P1', 'Sliver Hive'));
    },
  };
}
