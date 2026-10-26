import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  hand,
  permanent,
  seatZone,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { PR13_ALL_SCENARIOS } from '../../../packages/server/src/cards/pr13-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR13_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR13 title ${id}`);
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
const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();
const inZone = (page: Page, seat: string, zone: string, name: string): Locator =>
  seatZone(page, seat, zone).getByRole('img', { name, exact: true });

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

/** Cast a hand card through the real payment panel, choosing `targets` in order. */
async function cast(page: Page, name: string, targets: Target[] = []): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await expect(confirmButton(page)).toBeVisible();
  for (const target of targets) await pickTarget(page, target);
  await confirmButton(page).click();
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pass priority while the stack is non-empty until `source`'s spell or ability has resolved. */
async function resolveStack(page: Page, source: string): Promise<void> {
  await passStackUntil(page, logLine(page, new RegExp(`${escapeRegExp(source)}[^]*resolves`)));
}

const SECURITRON = 'Securitron Squadron';
const CHARM = 'Rakdos Charm';

/** Declare attackers, sending each named creature at P2. */
async function attackWith(page: Page, attackers: string[]): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  for (const attacker of attackers)
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: attacker })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
}

/** The decision panel asks whether to pay `amount` energy; take the Pay button. */
async function payEnergy(page: Page, amount: number): Promise<void> {
  const panel = page.locator('.decision-panel');
  await passUntil(page, panel.getByText(`Confiscation Coup: pay ${amount} energy?`).first());
  await panel.getByRole('button', { name: 'Pay', exact: true }).click();
}

const energy = (page: Page): Locator =>
  page.locator('[aria-label="Global counters"]').filter({ hasText: 'ENERGY' }).first();

const counters = (page: Page, seat: string): Locator =>
  page.locator(
    seat === 'P1'
      ? '.human-zone [aria-label="Global counters"]'
      : `.opponent[data-seat="${seat}"] [aria-label="Global counters"]`,
  );

test.describe('PR13 override-audit fix viewer scenarios', () => {
  for (const { id } of PR13_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'pr13-master-of-ceremonies-viewer-money': async (page) => {
    // P2 chose money at P1's upkeep, so each gets a Treasure; P1 has no lands.
    await passUntil(page, permanent(page, 'P1', 'Treasure'));
    await expect(permanent(page, 'P2', 'Treasure')).toHaveCount(1);
    await cast(page, 'PR13 Lab Gadget');
    await passUntil(page, permanent(page, 'P1', 'PR13 Lab Gadget'));
    // The Treasure paid for the Gadget and was sacrificed.
    await expect(permanent(page, 'P1', 'Treasure')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Treasure')).toHaveCount(1);
  },

  'pr13-securitron-squadron-viewer-squad-copy': async (page) => {
    const card = hand(page, SECURITRON);
    await passUntil(page, card.and(page.locator('.actionable')));
    await card.click();
    await page.getByRole('button', { name: /^Cast with squad 1\b/ }).click();
    await confirmButton(page).click();
    const squadrons = permanent(page, 'P1', SECURITRON);
    const copy = squadrons.locator('.pt').filter({ hasText: '4/4' });
    // Order the simultaneous counter triggers, passing priority until both have resolved.
    const order = page.getByRole('button', { name: /A creature token you control enters/ }).first();
    const pass = page
      .getByRole('button', { name: 'Pass priority', exact: true })
      .and(page.locator('button:enabled'));
    let submitted = '';
    await expect
      .poll(
        async () => {
          if (await copy.isVisible()) return true;
          if (await order.isVisible()) {
            await order.click({ timeout: 1_000 }).catch(() => undefined);
            return false;
          }
          const frontier = frontiers.get(page)!;
          if (
            frontier.stackSize > 0 &&
            frontier.requestId !== submitted &&
            (await pass.isVisible())
          ) {
            submitted = frontier.requestId;
            await pass.click({ timeout: 1_000 }).catch(() => undefined);
          }
          return false;
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    await expect(squadrons.locator('.pt')).toHaveText(['2/2', '4/4']);
  },
  'pr13-securitron-squadron-viewer-nontoken': async (page) => {
    await cast(page, 'PR13 Lab Bear');
    await passStackUntil(page, permanent(page, 'P1', 'PR13 Lab Bear'));
    await resolveStack(page, 'PR13 Lab Bear');
    await expect(permanent(page, 'P1', 'PR13 Lab Bear').locator('.pt')).toHaveText('2/2');
    await expect(permanent(page, 'P1', SECURITRON).locator('.pt')).toHaveText('2/2');
  },

  'pr13-confiscation-coup-viewer-zero-mana-value': async (page) => {
    await cast(page, 'Confiscation Coup', [['P2', 'PR13 Lab Ornament']]);
    await payEnergy(page, 0);
    await passUntil(page, permanent(page, 'P1', 'PR13 Lab Ornament'));
    await expect(permanent(page, 'P2', 'PR13 Lab Ornament')).toHaveCount(0);
    await expect(energy(page)).toContainText('ENERGY4');
  },
  'pr13-confiscation-coup-viewer-pay-mana-value': async (page) => {
    await cast(page, 'Confiscation Coup', [['P2', 'PR13 Lab Totem']]);
    await payEnergy(page, 2);
    await passUntil(page, permanent(page, 'P1', 'PR13 Lab Totem'));
    await expect(permanent(page, 'P2', 'PR13 Lab Totem')).toHaveCount(0);
    await expect(energy(page)).toContainText('ENERGY2');
  },

  'pr13-overwhelming-instinct-viewer-attacker-removed': async (page) => {
    await attackWith(page, ['PR13 Lab Bear', 'PR13 Lab Cub', 'PR13 Lab Whelp']);
    // The draw trigger is on the stack; respond by killing one of the three attackers.
    await expect.poll(() => frontiers.get(page)!.stackSize, { timeout: 15_000 }).toBeGreaterThan(0);
    await cast(page, 'PR13 Lab Shock', [['P1', 'PR13 Lab Bear']]);
    await passStackUntil(page, inZone(page, 'P1', 'Graveyard', 'PR13 Lab Bear'));
    await passStackUntil(page, hand(page, 'PR13 Lab Relic'));
    await expect(permanent(page, 'P1', 'PR13 Lab Bear')).toHaveCount(0);
    await passUntil(page, life(page, 'P2').filter({ hasText: '36' }));
  },
  'pr13-overwhelming-instinct-viewer-two-attackers': async (page) => {
    await attackWith(page, ['PR13 Lab Bear', 'PR13 Lab Cub']);
    await passUntil(page, life(page, 'P2').filter({ hasText: '36' }));
    await expect(hand(page, 'PR13 Lab Relic')).toHaveCount(0);
  },

  'pr13-rakdos-charm-viewer-creature-sources': async (page) => {
    const charm = hand(page, CHARM);
    await passUntil(page, charm.and(page.locator('.actionable')));
    await charm.click();
    await page.getByRole('button', { name: /Each creature deals 1 damage/i }).click();
    await confirmButton(page).click();
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await expect(counters(page, 'P2')).toContainText('POISON1');
    await expect(life(page, 'P1')).toHaveText('40');
  },
};

test.afterAll(() =>
  expect([...exercised].sort()).toEqual(PR13_ALL_SCENARIOS.map(({ id }) => id).sort()),
);
