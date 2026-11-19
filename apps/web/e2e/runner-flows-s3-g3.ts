import { expect, type Locator, type Page } from '@playwright/test';
import { hand, permanent, seatZone } from './pr09-viewer-helpers';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for PR #89's common blocking line scenarios (group s3-g3). */
export function s3g3Flows(h: Helpers): Record<string, Flow> {
  const { passUntil, passStackUntil } = h;

  const logLine = (page: Page, text: string | RegExp): Locator =>
    page.locator('.log').getByText(text).first();
  const confirmButton = (page: Page): Locator =>
    page.getByRole('button', { name: 'Confirm', exact: true });
  const actionable = (page: Page): Locator => page.locator('.actionable');
  const life = (page: Page, seat: string): Locator =>
    page.locator(`${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .life-badge`);
  const tapBadge = (page: Page, seat: string, name: string): Locator =>
    permanent(page, seat, name).locator('.tap-badge');
  const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
    seatZone(page, seat, zone).getByRole('img', { name, exact: true });
  const gameOver = (page: Page): Locator => logLine(page, /game over/);

  /** Click the hand card `name` once castable, pick each [seat, name] target, and confirm. */
  async function cast(
    page: Page,
    name: string,
    targets: Array<[string, string]> = [],
  ): Promise<void> {
    const card = hand(page, name);
    await passUntil(page, card.and(actionable(page)));
    await card.click();
    for (const [seat, target] of targets) {
      const object = permanent(page, seat, target).first();
      await expect(object).toHaveClass(/targetable|actionable/);
      await object.click();
    }
    await confirmButton(page).click();
  }

  /** Cast, then wait for the spell to resolve. */
  async function castAndResolve(
    page: Page,
    name: string,
    targets: Array<[string, string]> = [],
  ): Promise<void> {
    await cast(page, name, targets);
    await passStackUntil(page, logLine(page, new RegExp(`${name}[^]*resolves`)));
  }

  /** A card that cannot be cast stays in hand, un-actionable, once the game waits on a pass. */
  async function expectStaysInHand(page: Page, name: string): Promise<void> {
    await expect(
      page.getByRole('button', { name: 'Pass priority', exact: true }).or(gameOver(page)),
    ).toBeVisible();
    await expect(hand(page, name)).toHaveCount(1);
    await expect(hand(page, name)).not.toHaveClass(/actionable/);
  }

  /** Choose an opponent seat as the pending trigger's target and confirm. */
  async function targetPlayer(page: Page, seat: string): Promise<void> {
    await passStackUntil(page, page.getByText(/Target 1 of 1/).first());
    await page.locator(`.opponent[data-seat="${seat}"] > header`).click();
    await confirmButton(page).click();
  }

  /** P2 casts on its own turn: `name` ends up on P2's battlefield, tapped or not. */
  const p2Enters =
    (name: string, isTapped: boolean): Flow =>
    async (page) => {
      await passUntil(page, permanent(page, 'P2', name));
      await passUntil(page, gameOver(page));
      await expect(permanent(page, 'P2', name)).toHaveCount(1);
      await expect(tapBadge(page, 'P2', name)).toHaveCount(isTapped ? 1 : 0);
    };

  /** P1 casts `name` from hand: it ends up on P1's battlefield, untapped. */
  const ownEntersUntapped =
    (name: string): Flow =>
    async (page) => {
      await castAndResolve(page, name);
      await expect(permanent(page, 'P1', name)).toHaveCount(1);
      await expect(tapBadge(page, 'P1', name)).toHaveCount(0);
    };

  /** The spell is cast and resolves onto the battlefield. */
  const castsPermanent =
    (name: string): Flow =>
    async (page) => {
      await castAndResolve(page, name);
      await expect(permanent(page, 'P1', name)).toHaveCount(1);
    };

  /** The spell cannot be cast, so it stays in hand and `stays` is still on the battlefield. */
  const blocked =
    (name: string, stays?: [string, string]): Flow =>
    async (page) => {
      await expectStaysInHand(page, name);
      if (stays !== undefined) await expect(permanent(page, stays[0], stays[1])).toHaveCount(1);
    };

  /** Cast Angel of Finality and aim its enter trigger at P2. */
  async function angelAtP2(page: Page): Promise<void> {
    await cast(page, 'Angel of Finality');
    await targetPlayer(page, 'P2');
    await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
  }

  /** P2 casts Scenario Bear; wait until it is on the stack. */
  const bearOnStack = (page: Page): Locator =>
    page.locator('.stack li', { hasText: 'Scenario Bear' });

  /** Destroy P1's own Workshop Assistant with Scenario Snuff and let everything resolve. */
  async function snuffTheAssistant(page: Page): Promise<void> {
    await cast(page, 'Scenario Snuff', [['P1', 'Workshop Assistant']]);
  }

  /** Cast Spectral Denial with X=1 at P2's Scenario Bolt; P2 (scripted) pays {1}, so Bolt resolves. */
  async function denialAtBolt(page: Page): Promise<void> {
    const bolt = page.locator('.stack li', { hasText: 'Scenario Bolt' });
    const denial = hand(page, 'Spectral Denial');
    await passUntil(page, bolt);
    await passUntil(page, denial.and(actionable(page)));
    await denial.click();
    const row = page.locator('.source-actions .x-group');
    await row.getByRole('spinbutton').fill('1');
    await row.getByRole('button').click();
    await expect(bolt.first()).toHaveClass(/targetable/);
    await bolt.first().click();
    await confirmButton(page).click();
    await passUntil(page, gameOver(page));
    await expect(life(page, 'P1')).toHaveText('37');
    await expect(inZone(page, 'P1', 'Graveyard', 'Spectral Denial')).toHaveCount(1);
    await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bolt')).toHaveCount(1);
  }

  return {
    'imposing-sovereign-opponent-creature-enters-tapped': p2Enters('Scenario Bear', true),
    'imposing-sovereign-own-creature-enters-untapped': ownEntersUntapped('Scenario Bear'),
    'kinjallis-sunwing-opponent-creature-enters-tapped': p2Enters('Scenario Bear', true),
    'kinjallis-sunwing-opponent-noncreature-enters-untapped': p2Enters('Scenario Trinket', false),
    'manglehorn-opponent-artifact-enters-tapped': p2Enters('Scenario Trinket', true),
    'manglehorn-opponent-nonartifact-enters-untapped': p2Enters('Scenario Bear', false),
    'urabrask-opponent-creature-enters-tapped': p2Enters('Scenario Bear', true),
    'urabrask-own-creature-enters-untapped': ownEntersUntapped('Scenario Bear'),
    'thalia-opponent-creature-enters-tapped': p2Enters('Scenario Bear', true),
    'thalia-opponent-nonbasic-land-enters-tapped': p2Enters('Scenario Cavern', true),
    'thalia-opponent-basic-land-enters-untapped': p2Enters('Forest', false),

    'angel-of-finality-exiles-target-graveyard': async (page) => {
      await angelAtP2(page);
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
    },
    'angel-of-finality-leaves-other-graveyards': async (page) => {
      await angelAtP2(page);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Ogre')).toHaveCount(1);
      await expect(inZone(page, 'P3', 'Graveyard', 'Scenario Rock')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Exile', 'Scenario Ogre')).toHaveCount(0);
      await expect(inZone(page, 'P3', 'Exile', 'Scenario Rock')).toHaveCount(0);
    },

    'collector-ouphe-artifact-cannot-activate': async (page) => {
      await expect(
        page.getByRole('button', { name: 'Pass priority', exact: true }).or(gameOver(page)),
      ).toBeVisible();
      await expect(permanent(page, 'P1', 'Scenario Widget')).toHaveCount(1);
      await expect(permanent(page, 'P1', 'Scenario Widget')).not.toHaveClass(/actionable/);
      await expect(life(page, 'P1')).toHaveText('40');
      await expect(tapBadge(page, 'P1', 'Scenario Widget')).toHaveCount(0);
    },
    'collector-ouphe-opponent-artifact-cannot-activate': async (page) => {
      await passUntil(page, gameOver(page));
      await expect(permanent(page, 'P2', 'Scenario Widget')).toHaveCount(1);
      await expect(life(page, 'P2')).toHaveText('40');
      await expect(tapBadge(page, 'P2', 'Scenario Widget')).toHaveCount(0);
    },
    'collector-ouphe-nonartifact-still-activates': async (page) => {
      const healer = permanent(page, 'P1', 'Scenario Healer');
      await passUntil(page, healer.and(actionable(page)));
      await healer.click();
      const ability = page
        .locator('.source-actions .source-action-row button')
        .filter({ hasText: /life/i });
      if ((await ability.count()) > 0) await ability.first().click();
      const confirm = confirmButton(page);
      if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
      await passStackUntil(page, life(page, 'P1').filter({ hasText: '41' }));
      await expect(tapBadge(page, 'P1', 'Scenario Healer')).toHaveCount(1);
    },

    'draconic-lore-cheaper-with-dragon': async (page) => {
      await cast(page, 'Draconic Lore');
      for (const name of ['Scenario Ant', 'Scenario Bee', 'Scenario Cat'])
        await passStackUntil(page, hand(page, name));
      await passUntil(page, gameOver(page));
      await expect(inZone(page, 'P1', 'Graveyard', 'Draconic Lore')).toHaveCount(1);
    },
    'draconic-lore-opponents-dragon-no-discount': async (page) => {
      await expectStaysInHand(page, 'Draconic Lore');
      await expect(hand(page, 'Scenario Ant')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Draconic Lore')).toHaveCount(0);
    },
    'ghoultree-cheaper-per-creature-card-in-graveyard': castsPermanent('Ghoultree'),
    'ghoultree-only-own-creature-cards-count': blocked('Ghoultree'),
    'overwhelming-remorse-cheaper-per-creature-card': async (page) => {
      await castAndResolve(page, 'Overwhelming Remorse', [['P2', 'Scenario Ogre']]);
      await expect(permanent(page, 'P2', 'Scenario Ogre')).toHaveCount(0);
      await expect(inZone(page, 'P2', 'Exile', 'Scenario Ogre')).toHaveCount(1);
    },
    'overwhelming-remorse-discount-is-per-creature-card': blocked('Overwhelming Remorse', [
      'P2',
      'Scenario Ogre',
    ]),
    'rumbleweed-cheaper-per-land-card-in-graveyard': async (page) => {
      await castAndResolve(page, 'Rumbleweed');
      await expect(permanent(page, 'P1', 'Rumbleweed')).toHaveCount(1);
      await passStackUntil(
        page,
        permanent(page, 'P1', 'Scenario Bear').locator('.keywords[title*="trample" i]'),
      );
    },
    'rumbleweed-creature-cards-give-no-discount': blocked('Rumbleweed'),

    'assert-authority-counters-and-exiles': async (page) => {
      const bear = bearOnStack(page);
      await passUntil(page, bear);
      const authority = hand(page, 'Assert Authority');
      await passUntil(page, authority.and(actionable(page)));
      await authority.click();
      await expect(bear.first()).toHaveClass(/targetable/);
      await bear.first().click();
      await confirmButton(page).click();
      await passStackUntil(page, inZone(page, 'P2', 'Exile', 'Scenario Bear'));
      await passUntil(page, gameOver(page));
      await expect(inZone(page, 'P2', 'Graveyard', 'Scenario Bear')).toHaveCount(0);
      await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
      await expect(inZone(page, 'P1', 'Graveyard', 'Assert Authority')).toHaveCount(1);
    },
    'assert-authority-affinity-counts-only-your-artifacts': async (page) => {
      // P1 is never offered priority for the Bear: Assert Authority is not castable.
      await passUntil(page, permanent(page, 'P2', 'Scenario Bear'));
      await passUntil(page, gameOver(page));
      await expect(hand(page, 'Assert Authority')).not.toHaveClass(/actionable/);
      await expect(hand(page, 'Assert Authority')).toHaveCount(1);
    },

    'spectral-denial-cheaper-with-power-four-creature': async (page) => {
      await denialAtBolt(page);
      await expect(tapBadge(page, 'P1', 'Island')).toHaveCount(1);
    },
    'spectral-denial-power-three-creature-no-discount': async (page) => {
      await denialAtBolt(page);
      await expect(tapBadge(page, 'P1', 'Island')).toHaveCount(1);
      await expect(tapBadge(page, 'P1', 'Scenario Isle')).toHaveCount(1);
    },

    'workshop-assistant-returns-another-artifact': async (page) => {
      await snuffTheAssistant(page);
      await passUntil(page, hand(page, 'Scenario Trinket'));
      await passUntil(page, gameOver(page));
      await expect(inZone(page, 'P1', 'Graveyard', 'Workshop Assistant')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Trinket')).toHaveCount(0);
    },
    'workshop-assistant-cannot-return-itself': async (page) => {
      await snuffTheAssistant(page);
      await passUntil(page, gameOver(page));
      await expect(inZone(page, 'P1', 'Graveyard', 'Workshop Assistant')).toHaveCount(1);
      await expect(inZone(page, 'P1', 'Graveyard', 'Scenario Bear')).toHaveCount(1);
      await expect(hand(page, 'Workshop Assistant')).toHaveCount(0);
      await expect(hand(page, 'Scenario Bear')).toHaveCount(0);
    },
  };
}
