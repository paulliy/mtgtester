import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Advance = (page: Page, target: Locator) => Promise<void>;

/**
 * Viewer flows for the offspring, ravenous, dash and sneak runner scenarios. The viewer plays
 * P1's steps by hand; the other seats answer as the server's scripted seats.
 */
export function g4Flows(h: { passUntil: Advance; passStackUntil: Advance }): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

  const confirmButton = (page: Page): Locator =>
    page.getByRole('button', { name: 'Confirm', exact: true });
  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);

  /** Cast a hand card, picking the cast mode whose button matches `mode`, and wait for it to resolve. */
  async function castWith(
    page: Page,
    source: Locator,
    options: { mode?: RegExp; resolves: RegExp },
  ): Promise<void> {
    await passUntil(page, source.and(page.locator('.actionable')));
    await source.click();
    const modes = page.locator('.source-actions .source-action-row button');
    if (options.mode !== undefined) await modes.filter({ hasText: options.mode }).first().click();
    else if ((await modes.count()) > 1)
      await modes
        .filter({ has: page.locator('span', { hasText: /^Cast$/ }) })
        .first()
        .click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, options.resolves));
  }

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

  /** How many copies of `name` P1 controls, counting a stacked tile's badge. */
  async function copies(page: Page, name: string): Promise<number> {
    const tiles = permanent(page, 'P1', name);
    let total = 0;
    for (let i = 0; i < (await tiles.count()); i++) {
      const badge = await tiles.nth(i).locator('.stack-count-badge').allInnerTexts();
      total += badge.length > 0 ? Number(badge[0]!.replace(/\D/g, '')) : 1;
    }
    return total;
  }

  /** Cast a creature with its offspring cost paid: two of it end up on the battlefield. */
  const offspringPaid =
    (name: string, afterEnter?: (page: Page) => Promise<void>): Flow =>
    async (page) => {
      await castWith(page, hand(page, name), {
        mode: /Cast with offspring/,
        resolves: new RegExp(`${name}[^]*resolves`),
      });
      await passUntil(page, logLine(page, /Offspring[^]*resolves/));
      // The original and its token copy: two tiles, or one tile stacked "x2".
      await expect.poll(() => copies(page, name)).toBe(2);
      await afterEnter?.(page);
    };

  /** Cast a creature for its plain cost with spare mana: no offspring token appears. */
  const offspringDeclined =
    (name: string, afterEnter?: (page: Page) => Promise<void>): Flow =>
    async (page) => {
      await castWith(page, hand(page, name), {
        mode: /^Cast\s*\{/,
        resolves: new RegExp(`${name}[^]*resolves`),
      });
      await passUntil(page, permanent(page, 'P1', name));
      await passUntil(page, logLine(page, /game over/));
      await expect.poll(() => copies(page, name)).toBe(1);
      await afterEnter?.(page);
    };

  /** Cast a ravenous creature with the X spinbutton set to `x`; counters and the draw follow. */
  const ravenous =
    (name: string, x: number): Flow =>
    async (page) => {
      const card = hand(page, name);
      await passUntil(page, card.and(page.locator('.actionable')));
      await card.click();
      const row = page.locator('.source-actions .x-group');
      await row.getByRole('spinbutton').fill(String(x));
      await row.getByRole('button').click();
      const confirm = confirmButton(page);
      if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
      await passStackUntil(page, logLine(page, new RegExp(`${name}[^]*resolves`)));
      const tile = permanent(page, 'P1', name);
      await expect(tile).toHaveCount(1);
      await expect(tile).toContainText(`${x}/${x}`.length > 0 ? new RegExp(`\\b${x}\\b`) : '');
      if (x >= 5) {
        await passUntil(page, hand(page, 'Scenario Bear'));
        await expect(hand(page, 'Scenario Bear')).toHaveCount(1);
      } else {
        await passUntil(page, logLine(page, /game over/));
        await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
      }
    };

  /** Cast for the dash cost, attack with only `attacker`, and watch it return to hand at the end step. */
  const dash =
    (name: string, attackers: string[], expectedLife: string): Flow =>
    async (page) => {
      await castWith(page, hand(page, name), {
        mode: /Cast with dash/,
        resolves: new RegExp(`${name}[^]*resolves`),
      });
      await expect(keywordOn(page, name, 'haste')).toHaveCount(1);
      await attack(
        page,
        attackers.map((creature) => [creature, 'P2']),
      );
      await passUntil(page, hand(page, name));
      await passUntil(page, logLine(page, /game over/));
      await expect(life(page, 'P2')).toHaveText(expectedLife);
      await expect(permanent(page, 'P1', name)).toHaveCount(0);
    };

  const keywordOn = (page: Page, name: string, keyword: string): Locator =>
    permanent(page, 'P1', name).locator(`.keywords[title*="${keyword}" i]`);

  const sneak =
    (name: string, search?: string): Flow =>
    async (page) => {
      await attack(page, [['Scenario Bear', 'P2']]);
      const card = hand(page, name);
      await passUntil(page, card.and(page.locator('.actionable')));
      await card.click();
      // In the declare blockers step the sneak cost is the card's only cast, so it may have no menu.
      const alternate = page
        .locator('.source-actions .source-action-row button')
        .filter({ hasText: /alternate cost|sneak/i });
      if ((await alternate.count()) > 0) await alternate.first().click();
      await confirmButton(page).click();
      if (search !== undefined) {
        const pick = page
          .locator('.panel-group')
          .filter({ has: page.getByRole('img', { name: search, exact: true }) })
          .getByRole('button', { name: 'Put into your hand' })
          .first();
        await passStackUntil(page, pick);
        await pick.click();
      }
      await passUntil(page, logLine(page, /game over/));
      await expect(hand(page, 'Scenario Bear')).not.toHaveCount(0);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(0);
      await expect(life(page, 'P2')).toHaveText('40');
    };

  const sneakBlocked =
    (name: string): Flow =>
    async (page) => {
      await attack(page, [['Scenario Bear', 'P2']]);
      await passUntil(page, logLine(page, /game over/));
      await expect(hand(page, name)).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      await expect(life(page, 'P2')).toHaveText('40');
    };

  const sneakMainPhase =
    (name: string): Flow =>
    async (page) => {
      // The scenario has no steps: the game ends in the main phase with nothing cast.
      await passUntil(page, logLine(page, /game over/));
      await expect(hand(page, name)).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Bear')).toHaveCount(1);
      await expect(logLine(page, new RegExp(`Cast ${name}`))).toHaveCount(0);
      await expect(life(page, 'P2')).toHaveText('40');
    };

  return {
    'coruscation-mage-offspring-paid': offspringPaid('Coruscation Mage'),
    'coruscation-mage-offspring-declined': offspringDeclined('Coruscation Mage'),
    'agate-instigator-offspring-paid': offspringPaid('Agate Instigator'),
    'agate-instigator-offspring-declined': offspringDeclined('Agate Instigator'),
    'prosperous-bandit-offspring-paid': offspringPaid('Prosperous Bandit'),
    'prosperous-bandit-offspring-declined': offspringDeclined('Prosperous Bandit'),
    'steelburr-champion-offspring-paid': offspringPaid('Steelburr Champion'),
    'steelburr-champion-offspring-declined': offspringDeclined('Steelburr Champion'),
    'aberrant-x5': ravenous('Aberrant', 5),
    'aberrant-x4': ravenous('Aberrant', 4),
    'tervigon-x5': ravenous('Tervigon', 5),
    'tervigon-x4': ravenous('Tervigon', 4),
    'termagant-swarm-x5': ravenous('Termagant Swarm', 5),
    'termagant-swarm-x4': ravenous('Termagant Swarm', 4),
    'riders-of-rohan-dash': dash('Riders of Rohan', ['Riders of Rohan'], '36'),
    'riders-of-rohan-cast-normally': async (page) => {
      await castWith(page, hand(page, 'Riders of Rohan'), {
        mode: /^Cast\s*\{/,
        resolves: /Riders of Rohan[^]*resolves/,
      });
      await expect(keywordOn(page, 'Riders of Rohan', 'haste')).toHaveCount(0);
      const declare = page.getByRole('button', { name: /Declare attackers/ });
      await passUntil(page, declare);
      await declare.click();
      await expect(
        page.locator('.combat-assignment-row').filter({ hasText: 'Riders of Rohan' }),
      ).toHaveCount(0);
      await attack(page, []);
      await passUntil(page, logLine(page, /game over/));
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P1', 'Riders of Rohan')).toHaveCount(1);
      await expect(hand(page, 'Riders of Rohan')).toHaveCount(0);
    },
    'kolaghan-the-storms-fury-dash': dash(
      "Kolaghan, the Storm's Fury",
      ["Kolaghan, the Storm's Fury"],
      '35',
    ),
    'kolaghan-the-storms-fury-cast-normally': async (page) => {
      const name = "Kolaghan, the Storm's Fury";
      await castWith(page, hand(page, name), {
        mode: /^Cast\s*\{/,
        resolves: /Kolaghan[^]*resolves/,
      });
      await expect(keywordOn(page, name, 'haste')).toHaveCount(0);
      await passUntil(page, logLine(page, /game over/));
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(permanent(page, 'P1', name)).toHaveCount(1);
      await expect(hand(page, name)).toHaveCount(0);
    },
    'splinters-technique-sneak': sneak("Splinter's Technique", 'Island'),
    'splinters-technique-sneak-blocked': sneakBlocked("Splinter's Technique"),
    'splinters-technique-sneak-main-phase': sneakMainPhase("Splinter's Technique"),
    'donatellos-technique-sneak': sneak("Donatello's Technique"),
    'donatellos-technique-sneak-blocked': sneakBlocked("Donatello's Technique"),
    'donatellos-technique-sneak-main-phase': sneakMainPhase("Donatello's Technique"),
  };
}
