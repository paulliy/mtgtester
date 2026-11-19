import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for PR #89's common blocking line scenarios (group s3-g4). */
export function s3g4Flows(h: Helpers): Record<string, Flow> {
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
  const tapBadge = (page: Page, seat: string, name: string): Locator =>
    permanent(page, seat, name).locator('.tap-badge');
  const keywordOn = (page: Page, seat: string, name: string, keyword: string): Locator =>
    permanent(page, seat, name).locator(`.keywords[title*="${keyword}" i]`);
  const gameOver = (page: Page): Promise<void> => passUntil(page, logLine(page, /game over/));

  /** Wait until the game waits on a pass (or has ended), so "not offered" is checked on a settled UI. */
  async function settled(page: Page): Promise<void> {
    await expect(
      page
        .getByRole('button', { name: 'Pass priority', exact: true })
        .or(logLine(page, /game over/)),
    ).toBeVisible();
  }

  /** A spell that cannot be cast stays in hand, shown but not actionable. */
  async function expectStaysInHand(page: Page, name: string): Promise<void> {
    await settled(page);
    const card = hand(page, name);
    await expect(card).toBeVisible();
    await expect(card).not.toHaveClass(/actionable/);
    await expect(card).toHaveCount(1);
  }

  /** Click a player's name bar, the way a player target is chosen. */
  async function clickSeat(page: Page, seat: string): Promise<void> {
    const zone =
      seat === 'P1' ? page.locator('.human-zone') : page.locator(`.opponent[data-seat="${seat}"]`);
    await expect(seat === 'P1' ? zone.locator('> header') : zone).toHaveClass(/targetable/);
    await zone.locator('> header').click();
  }

  /** Answer the pending trigger's "Target 1 of 1" prompt with a player seat. */
  async function targetPlayer(page: Page, seat: string): Promise<void> {
    await passStackUntil(page, page.getByText(/Target 1 of 1/).first());
    await clickSeat(page, seat);
    await confirmButton(page).click();
  }

  /** Cast a hand card, choose each [seat, name] permanent target, confirm, and wait for it to resolve. */
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

  /** Play a land from hand, through its own menu when the card offers more than one action. */
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
    await expect(hand(page, name)).toHaveCount(0);
  }

  /** Activate the ability of `source`: pick it from the source's list when it has several. */
  async function activate(page: Page, source: Locator, ability: RegExp): Promise<void> {
    await passUntil(page, source.and(actionable(page)));
    await source.click();
    const action = page
      .locator('.source-actions .source-action-row button')
      .filter({ hasText: ability })
      .first();
    const prompt = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(action.or(prompt)).toBeVisible();
    if (await action.isVisible()) await action.click();
  }

  /** Click the button named `name` once it is offered. */
  async function press(page: Page, name: string): Promise<void> {
    const button = page.getByRole('button', { name, exact: true }).first();
    await passStackUntil(page, button);
    await button.click();
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

  // ── Self cost reductions ("costs {N} less to cast if you control a <type>") ──────────────────
  const cheaper =
    (spell: string, targets: Array<[string, string]>, check: (page: Page) => Promise<void>): Flow =>
    async (page) => {
      await cast(page, spell, { targets, resolves: new RegExp(`${spell}[^]*resolves`) });
      await expect(inZone(page, 'P1', 'Graveyard', spell)).toHaveCount(1);
      await check(page);
    };

  const fullPrice =
    (spell: string, check: (page: Page) => Promise<void> = async () => undefined): Flow =>
    async (page) => {
      await expectStaysInHand(page, spell);
      await check(page);
    };

  const drewCards =
    (...names: string[]) =>
    async (page: Page): Promise<void> => {
      for (const name of names) await expect(hand(page, name)).toHaveCount(1);
    };
  const drewNothing =
    (...names: string[]) =>
    async (page: Page): Promise<void> => {
      for (const name of names) await expect(hand(page, name)).toHaveCount(0);
    };

  // ── Destroy your own creature with Scenario Smite; its dies trigger picks its only target ───
  async function smiteOwn(page: Page, creature: string): Promise<void> {
    await cast(page, 'Scenario Smite', {
      targets: [['P1', creature]],
      resolves: /Scenario Smite[^]*resolves/,
    });
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', creature));
  }

  // ── Protection from the chosen color, then an attack the red Goblin can or can't block ───────
  async function protectBear(page: Page, color: 'R' | 'G'): Promise<void> {
    await activate(page, permanent(page, 'P1', 'Benevolent Bodyguard'), /Sacrifice/);
    const target = permanent(page, 'P1', 'Scenario Bear').first();
    await expect(target).toHaveClass(/targetable|actionable/);
    await target.click();
    await confirmButton(page).click();
    await press(page, `Protection from ${color}`);
    await attack(page, 'Scenario Bear');
    await gameOver(page);
  }

  const pinger = (page: Page, source: string): Promise<void> =>
    activate(page, permanent(page, 'P1', source), /Target player loses 1 life/);

  async function pingP2(page: Page, source: string): Promise<void> {
    await pinger(page, source);
    await clickSeat(page, 'P2');
    await confirmButton(page).click();
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '39' }));
  }

  /** Play P2's turn through (its scripted seat plays its cards), then read what entered tapped. */
  const tappedAfter = async (page: Page, entered: string[], untapped: string[]) => {
    await gameOver(page);
    for (const name of entered) await expect(tapBadge(page, 'P2', name)).toHaveCount(1);
    for (const name of untapped) {
      await expect(permanent(page, 'P2', name)).toHaveCount(1);
      await expect(tapBadge(page, 'P2', name)).toHaveCount(0);
    }
  };

  const ownEntersUntapped =
    (cardNames: Array<[string, 'land' | 'spell']>): Flow =>
    async (page) => {
      for (const [name, kind] of cardNames) {
        if (kind === 'land') await playLand(page, name);
        else await cast(page, name, { resolves: new RegExp(`${name}[^]*resolves`) });
      }
      for (const [name] of cardNames) {
        await expect(permanent(page, 'P1', name)).toHaveCount(1);
        await expect(tapBadge(page, 'P1', name)).toHaveCount(0);
      }
    };

  return {
    // Arcane Epiphany
    'arcane-epiphany-cheaper-with-wizard': cheaper(
      'Arcane Epiphany',
      [],
      drewCards('Scenario Bear', 'Scenario Ogre', 'Scenario Elk'),
    ),
    'arcane-epiphany-full-price-without-wizard': fullPrice(
      'Arcane Epiphany',
      drewNothing('Scenario Ogre', 'Scenario Elk'),
    ),
    // Pearl of Wisdom
    'pearl-of-wisdom-cheaper-with-otter': cheaper(
      'Pearl of Wisdom',
      [],
      drewCards('Scenario Bear', 'Scenario Elk'),
    ),
    'pearl-of-wisdom-full-price-without-otter': fullPrice(
      'Pearl of Wisdom',
      drewNothing('Scenario Elk'),
    ),
    // Saved by the Shell
    'saved-by-the-shell-cheaper-with-turtle': cheaper(
      'Saved by the Shell',
      [['P1', 'Scenario Turtle']],
      async (page) => {
        await expect(permanent(page, 'P1', 'Scenario Turtle').locator('.counters')).toContainText(
          /\+1\/\+1/,
        );
        for (const keyword of ['trample', 'hexproof', 'indestructible'])
          await expect(keywordOn(page, 'P1', 'Scenario Turtle', keyword)).toHaveCount(1);
      },
    ),
    'saved-by-the-shell-full-price-without-turtle': fullPrice(
      'Saved by the Shell',
      async (page) => {
        await expect(permanent(page, 'P1', 'Scenario Bear').locator('.counters')).toHaveCount(0);
      },
    ),
    // Venom's Hunger
    'venoms-hunger-cheaper-with-villain': cheaper(
      "Venom's Hunger",
      [['P2', 'Scenario Bear']],
      async (page) => {
        await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
        await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
        await expect(life(page, 'P1')).toHaveText('42');
      },
    ),
    'venoms-hunger-full-price-without-villain': fullPrice("Venom's Hunger", async (page) => {
      await expect(life(page, 'P1')).toHaveText('40');
      await expect(permanent(page, 'P2', 'Scenario Ogre')).toHaveCount(1);
    }),
    // Benevolent Bodyguard
    'benevolent-bodyguard-protects-from-chosen-color': async (page) => {
      await protectBear(page, 'R');
      await expect(life(page, 'P2')).toHaveText('38');
      await expect(permanent(page, 'P2', 'Scenario Goblin')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Benevolent Bodyguard')).toHaveCount(1);
    },
    'benevolent-bodyguard-other-color-can-be-blocked': async (page) => {
      await protectBear(page, 'G');
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Goblin')).toHaveCount(1);
      await expect(permanent(page, 'P2', 'Scenario Goblin')).toHaveCount(0);
    },
    // Cursed Totem
    'cursed-totem-creature-ability-cannot-be-activated': async (page) => {
      await settled(page);
      await expect(permanent(page, 'P1', 'Scenario Pinger')).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Pinger')).not.toHaveClass(/actionable/);
      await expect(life(page, 'P2')).toHaveText('40');
    },
    'cursed-totem-artifact-ability-still-works': async (page) => {
      await pingP2(page, 'Scenario Relic');
      await expect(life(page, 'P2')).toHaveText('39');
    },
    'cursed-totem-no-totem-creature-ability-works': async (page) => {
      await pingP2(page, 'Scenario Pinger');
      await expect(life(page, 'P2')).toHaveText('39');
    },
    // Eidolon of Rhetoric
    'eidolon-of-rhetoric-second-spell-refused': async (page) => {
      await cast(page, 'Scenario Elk', { resolves: /Scenario Elk[^]*resolves/ });
      await expect(permanent(page, 'P1', 'Scenario Elk')).toHaveCount(1);
      await expectStaysInHand(page, 'Scenario Stag');
      await expect(permanent(page, 'P1', 'Scenario Stag')).toHaveCount(0);
    },
    'eidolon-of-rhetoric-two-spells-without-it': async (page) => {
      await cast(page, 'Scenario Elk', { resolves: /Scenario Elk[^]*resolves/ });
      await cast(page, 'Scenario Stag', { resolves: /Scenario Stag[^]*resolves/ });
      await expect(permanent(page, 'P1', 'Scenario Elk')).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Stag')).toHaveCount(1);
    },
    'eidolon-of-rhetoric-land-play-is-not-a-spell': async (page) => {
      await cast(page, 'Scenario Elk', { resolves: /Scenario Elk[^]*resolves/ });
      await playLand(page, 'Forest');
      await expect(permanent(page, 'P1', 'Scenario Elk')).toHaveCount(1);
    },
    // Gixian Puppeteer
    'gixian-puppeteer-returns-another-small-creature': async (page) => {
      await smiteOwn(page, 'Gixian Puppeteer');
      await passStackUntil(page, permanent(page, 'P1', 'Scenario Bear'));
      await expect(inZone(page, 'P1', 'Graveyard', 'Gixian Puppeteer')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
    },
    'gixian-puppeteer-cannot-return-itself': async (page) => {
      await smiteOwn(page, 'Gixian Puppeteer');
      await settled(page);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(permanent(page, 'P1', 'Gixian Puppeteer')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Gixian Puppeteer')).toHaveCount(1);
    },
    'gixian-puppeteer-mana-value-four-not-returned': async (page) => {
      await smiteOwn(page, 'Gixian Puppeteer');
      await settled(page);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(permanent(page, 'P1', 'Scenario Ogre')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Gixian Puppeteer')).toHaveCount(1);
    },
    // Morcant's Loyalist
    'morcants-loyalist-returns-another-elf': async (page) => {
      await smiteOwn(page, "Morcant's Loyalist");
      await passStackUntil(page, hand(page, 'Scenario Elf'));
      await expect(inZone(page, 'P1', 'Graveyard', "Morcant's Loyalist")).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Elf')).toHaveCount(0);
    },
    'morcants-loyalist-non-elf-and-itself-not-returned': async (page) => {
      await smiteOwn(page, "Morcant's Loyalist");
      await settled(page);
      await expect(page.locator('.stack li')).toHaveCount(0);
      await expect(hand(page, "Morcant's Loyalist")).toHaveCount(0);
      await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', "Morcant's Loyalist")).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    },
    // Jirina, Dauntless General
    'jirina-exiles-target-opponent-graveyard': async (page) => {
      await cast(page, 'Jirina, Dauntless General', { resolves: /Jirina[^]*resolves/ });
      await targetPlayer(page, 'P2');
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Elk')).toHaveCount(1);
      await expect(inZone(page, 'P3', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
    },
    'jirina-exiles-only-the-targeted-graveyard': async (page) => {
      await cast(page, 'Jirina, Dauntless General', { resolves: /Jirina[^]*resolves/ });
      await targetPlayer(page, 'P1');
      await passStackUntil(page, inZone(page, 'P1', 'Exile', 'Scenario Elk'));
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Elk')).toHaveCount(0);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P3', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
    },
    // Tormod's Crypt
    'tormods-crypt-exiles-target-graveyard': async (page) => {
      await activate(
        page,
        permanent(page, 'P1', "Tormod's Crypt"),
        /Exile target player's graveyard/,
      );
      await clickSeat(page, 'P2');
      await confirmButton(page).click();
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
      await expect(permanent(page, 'P1', "Tormod's Crypt")).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', "Tormod's Crypt")).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Elk')).toHaveCount(1);
    },
    'tormods-crypt-only-targeted-graveyard': async (page) => {
      await activate(
        page,
        permanent(page, 'P1', "Tormod's Crypt"),
        /Exile target player's graveyard/,
      );
      await clickSeat(page, 'P1');
      await confirmButton(page).click();
      await passStackUntil(page, inZone(page, 'P1', 'Exile', 'Scenario Elk'));
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Bear')).toHaveCount(0);
    },
    'tormods-crypt-tapped-cannot-activate': async (page) => {
      await settled(page);
      await expect(permanent(page, 'P1', "Tormod's Crypt")).toHaveCount(1);
      await expect(permanent(page, 'P1', "Tormod's Crypt")).not.toHaveClass(/actionable/);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
    },
    // Kismet
    'kismet-opponent-permanents-enter-tapped': async (page) => {
      await cast(page, 'Kismet', { resolves: /Kismet[^]*resolves/ });
      await tappedAfter(page, ['Mountain', 'Scenario Bear', 'Scenario Relic'], []);
    },
    'kismet-own-permanents-enter-untapped': ownEntersUntapped([
      ['Mountain', 'land'],
      ['Scenario Bear', 'spell'],
      ['Scenario Relic', 'spell'],
    ]),
    // Spider-Woman, Stunning Savior
    'spider-woman-opponent-creatures-and-artifacts-enter-tapped': async (page) => {
      await cast(page, 'Spider-Woman, Stunning Savior', { resolves: /Spider-Woman[^]*resolves/ });
      await tappedAfter(page, ['Scenario Bear', 'Scenario Relic'], []);
    },
    'spider-woman-opponent-land-enters-untapped': async (page) => {
      await cast(page, 'Spider-Woman, Stunning Savior', { resolves: /Spider-Woman[^]*resolves/ });
      await tappedAfter(page, [], ['Mountain']);
    },
    'spider-woman-own-permanents-enter-untapped': ownEntersUntapped([
      ['Scenario Bear', 'spell'],
      ['Scenario Relic', 'spell'],
    ]),
  };
}
