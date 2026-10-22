import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  hand,
  permanent as allPermanents,
  priorityHelpers,
  selectScenario,
  launchScenario,
} from './pr09-viewer-helpers';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR09_CHOICE_SCENARIOS } from '../../../packages/server/src/cards/pr09-choice-scenarios';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR09_CHOICE_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<
  Page,
  {
    requestId: string;
    stackSize: number;
    decidingPlayer: string;
    snapshotCount: number;
    publicZones: {
      targetExiled: boolean;
      targetOnBattlefield: boolean;
      sourceOnBattlefield: boolean;
    }[];
  }
>();

const { passUntil, passStackUntil, attack } = priorityHelpers(frontiers, 40_000, true);

function permanent(page: Page, seat: string, name: string): Locator {
  return allPermanents(page, seat, name).first();
}

async function start(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR09 choice scenario ${id}`);
  const frontier = {
    requestId: '',
    stackSize: 0,
    decidingPlayer: '',
    snapshotCount: 0,
    publicZones: [] as {
      targetExiled: boolean;
      targetOnBattlefield: boolean;
      sourceOnBattlefield: boolean;
    }[],
  };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired') {
          frontier.requestId = frame.payload.request.requestId;
          frontier.stackSize = frame.payload.request.state.stack.length;
          frontier.decidingPlayer = frame.payload.request.decidingPlayer;
        } else if (frame.type === 'playerStateSnapshot') {
          frontier.snapshotCount += 1;
          frontier.stackSize = frame.payload.state.stack.length;
          frontier.publicZones.push({
            targetExiled: frame.payload.state.exile.some(
              (card) => card.name === 'PR09 Celebrate Target',
            ),
            targetOnBattlefield: frame.payload.state.battlefield.some(
              (permanent) => permanent.name === 'PR09 Celebrate Target',
            ),
            sourceOnBattlefield: frame.payload.state.battlefield.some(
              (permanent) => permanent.name === 'Celebrate the Mountain-king',
            ),
          });
        }
      } catch {
        /* Ignore non-JSON websocket frames. */
      }
    }),
  );
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

async function cast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function castTarget(page: Page, name: string, target: Locator): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await target.click();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
}
async function passUntilStackCard(page: Page, name: string): Promise<Locator> {
  const target = page.locator('.stack li').filter({ hasText: name }).first();
  await passStackUntil(page, target);
  return target;
}
async function chooseCard(page: Page, name: string, action: RegExp): Promise<void> {
  const frontier = frontiers.get(page)!;
  const priorSnapshotCount = frontier.snapshotCount;
  const button = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: name })
    .getByRole('button', { name: action })
    .first();
  await passUntil(page, button);
  await button.click();
  await expect
    .poll(
      async () =>
        frontier.snapshotCount > priorSnapshotCount ||
        (await page
          .locator('.log')
          .getByText(/game over/i)
          .count()) > 0,
      { timeout: 5_000 },
    )
    .toBe(true);
}
async function chooseAction(page: Page, action: RegExp): Promise<void> {
  const frontier = frontiers.get(page)!;
  const priorSnapshotCount = frontier.snapshotCount;
  const button = page.getByRole('button', { name: action }).first();
  await passUntil(page, button);
  await button.click();
  await expect
    .poll(() => frontier.snapshotCount > priorSnapshotCount, { timeout: 5_000 })
    .toBe(true);
}
async function orderCelebrateTriggers(page: Page): Promise<void> {
  // Put the exile trigger on the stack first so Recruit resolves after its target choice.
  await chooseAction(page, /Celebrate the Mountain-king: For each opponent, exile/);
}

async function finishCapstoneChoices(page: Page): Promise<void> {
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden();
}
async function passUntilSourceLeaves(page: Page, sourceName: string): Promise<void> {
  const source = permanent(page, 'P1', sourceName);
  const pass = page
    .getByRole('button', { name: 'Pass priority', exact: true })
    .and(page.locator('button:enabled'));
  await expect
    .poll(
      async () => {
        if ((await source.count()) === 0) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 40_000 },
    )
    .toBe(true);
}

test.describe('PR09 choice-card Card Test Lab scenarios', () => {
  for (const { id, cardName } of PR09_CHOICE_SCENARIOS) {
    test(`${id}`, async ({ page }) => {
      await start(page, id);

      if (id.startsWith('pr09-path-of-discovery')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        const entering = id.endsWith('positive') ? 'PR09 Path Creature' : 'PR09 Path Artifact';
        await cast(page, entering);
        await passStackUntil(page, permanent(page, 'P1', entering));
        if (id.endsWith('positive')) {
          await expect(hand(page, 'Forest')).toBeVisible();
          await expect(page.locator('.log')).toContainText(/explores/i);
        } else {
          await expect(page.locator('.log')).not.toContainText(/reveals Forest/i);
          await expect(hand(page, 'Forest')).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-lurking-predators')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        if (id.endsWith('positive')) {
          await passUntil(page, permanent(page, 'P1', 'PR09 Predator Creature'));
          await expect(page.locator('.log')).toContainText(/reveals PR09 Predator Creature/i);
        } else {
          await cast(page, 'PR09 Own Instant');
          await passUntil(page, page.locator('.human-zone .life-badge').getByText('41'));
          await expect(permanent(page, 'P1', 'PR09 Predator Creature')).toHaveCount(0);
          await expect(page.locator('.log')).not.toContainText(/reveals PR09 Predator Creature/i);
        }
      } else if (id.startsWith('pr09-new-generation-s-technique')) {
        if (id.endsWith('sneak-positive')) {
          await attack(page, 'PR09 Sneak Attacker');
          await expect(hand(page, cardName)).toHaveClass(/actionable/);
          await hand(page, cardName).click();
          // Selecting the actionable card auto-selects its sole Sneak cast and advances.
          await expect(page.getByText(/Auto-pay/)).toBeVisible();
          await page.getByRole('button', { name: 'Confirm', exact: true }).click();
          await expect(hand(page, 'PR09 Sneak Attacker')).toBeVisible();
          await chooseCard(page, 'Forest', /Put onto the battlefield tapped/i);
          await chooseCard(page, 'Island', /Put onto the battlefield tapped/i);
          await expect(hand(page, 'PR09 Sneak Attacker')).toBeVisible();
          await expect(permanent(page, 'P1', 'Forest')).toBeVisible();
          await expect(permanent(page, 'P1', 'Island')).toBeVisible();
        } else if (id.endsWith('sneak-negative')) {
          await hand(page, cardName).click();
          await expect(page.getByRole('button', { name: /Sneak/i })).toHaveCount(0);
          await expect(hand(page, cardName)).toBeVisible();
        } else if (id.endsWith('negative')) {
          await expect(hand(page, cardName)).toBeVisible();
          await expect(hand(page, cardName)).not.toHaveClass(/actionable/);
          await expect(
            page
              .locator('.human-zone .object')
              .filter({ has: page.getByRole('img', { name: cardName, exact: true }) }),
          ).toHaveCount(0);
        } else {
          await cast(page, cardName);
          await passStackUntil(page, page.getByText(/choose.*basic land|basic land.*library/i));
          await chooseCard(page, 'Forest', /Put onto the battlefield tapped/i);
          await chooseCard(page, 'Island', /Put onto the battlefield tapped/i);
          await expect(permanent(page, 'P1', 'Forest')).toBeVisible();
          await expect(permanent(page, 'P1', 'Island')).toBeVisible();
        }
      } else if (id.startsWith('pr09-celebrate-the-mountain-king')) {
        await cast(page, cardName);
        await orderCelebrateTriggers(page);
        if (id.includes('-exile-')) {
          if (id.endsWith('exile-positive')) {
            await chooseAction(page, /Target PR09 Celebrate Target/);
            await expect(page.locator('.log')).toContainText(/PR09 Celebrate Target.*exil/i);
            await expect(permanent(page, 'P2', 'PR09 Celebrate Target')).toBeVisible();
            const history = frontiers.get(page)!.publicZones;
            expect(history.some((state) => state.targetExiled && state.sourceOnBattlefield)).toBe(
              true,
            );
            expect(
              history.some((state) => !state.sourceOnBattlefield && state.targetOnBattlefield),
            ).toBe(true);
          } else {
            await chooseAction(page, /Choose no more targets/);
            await passUntilSourceLeaves(page, cardName);
            await expect(permanent(page, 'P2', 'PR09 Celebrate Target')).toBeVisible();
            await expect(page.locator('.log')).not.toContainText(/PR09 Celebrate Target.*exil/i);
          }
        } else {
          const discard = id.endsWith('positive') ? 'PR09 Recruit Discard' : 'PR09 Recruit Land';
          await chooseCard(page, discard, /discard/i);
          if (id.endsWith('positive')) {
            const token = permanent(page, 'P1', 'Human Soldier');
            await expect(token).toBeVisible();
            await expect(token.locator('.pt')).toHaveText('1/1');
          } else {
            await expect(permanent(page, 'P1', 'Human Soldier')).toHaveCount(0);
          }
        }
      } else if (id.startsWith('pr09-rabble-rousing')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        await chooseCard(page, 'PR09 Rabble Hidden', /exile face down/i);
        await expect(page.locator('.human-zone')).toContainText(/1 in exile|Exile \(1\)/i);
        if (id.endsWith('positive')) {
          await attack(page, 'PR09 Rabble Attacker');
          const token = permanent(page, 'P1', 'Citizen');
          await expect(token).toBeVisible();
          await expect(token.locator('.pt')).toHaveText('1/1');
          await chooseCard(page, 'PR09 Rabble Hidden', /Play/i);
          await expect(permanent(page, 'P1', 'PR09 Rabble Hidden')).toBeVisible();
          await expect(page.locator('.log')).toContainText(/casts PR09 Rabble Hidden/i);
          await expect(page.locator('.log')).toContainText(/Citizen/i);
        } else {
          const declare = page.getByRole('button', { name: /Declare attackers/ });
          await passUntil(page, declare);
          await declare.click();
          await page.getByRole('button', { name: /Confirm attacks/ }).click();
          await expect(permanent(page, 'P1', 'Citizen')).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-tibalt-s-trickery')) {
        const opponentSpell = await passUntilStackCard(page, 'PR09 Opponent Instant');
        await castTarget(page, cardName, opponentSpell);
        if (id.endsWith('positive')) {
          await expect(page.locator('.log')).toContainText(/PR09 Opponent Instant is countered/i);
          await expect(page.locator('.log')).toContainText(/PR09 Trickery Reveal/);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('41');
        } else {
          await expect(page.locator('.log')).toContainText(/PR09 Opponent Instant is countered/i);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('40');
        }
      } else if (id.startsWith('pr09-grenzo-havoc-raiser')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        if (id.endsWith('goad')) {
          await attack(page, 'PR09 Path Creature');
          await chooseAction(page, /Goad target creature/i);
          const target = permanent(page, 'P2', 'PR09 Goad Target');
          await expect(page.locator('.log')).toContainText(/goad/i);
          await expect(target).toBeVisible();
        } else if (id.endsWith('positive')) {
          await attack(page, 'PR09 Path Creature');
          await expect(permanent(page, 'P2', 'PR09 Grenzo Reveal')).toHaveCount(0);
          await expect(page.locator('.opponent[data-seat="P2"]')).toContainText(/Exile \(1\)/i);
          await page.getByRole('button', { name: 'Cast PR09 Grenzo Reveal', exact: true }).click();
          await expect(page.getByText(/Auto-pay/)).toBeVisible();
          await page.getByRole('button', { name: 'Confirm', exact: true }).click();
          await expect(page.locator('.log')).toContainText(/Cast PR09 Grenzo Reveal/i);
        } else {
          await expect(page.getByRole('button', { name: /Declare attackers/ })).toHaveCount(0);
          await expect(page.locator('.log')).not.toContainText(/deals combat damage to P2/i);
          await expect(page.locator('.opponent[data-seat="P2"]')).not.toContainText(
            /PR09 Grenzo Reveal/,
          );
        }
      } else if (id.startsWith('pr09-power-pack')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        const powerPack = permanent(page, 'P1', cardName);
        for (const keyword of ['flying', 'vigilance', 'trample', 'haste'])
          await expect(powerPack.locator(`.keywords[title*="${keyword}"]`)).toHaveCount(1);
        if (id.endsWith('positive')) {
          await attack(page, cardName);
          await expect(powerPack.locator('.tap-badge')).toHaveCount(0);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
          const delayedCast = page.locator('.decision-panel').getByRole('button', {
            name: 'Cast',
            exact: true,
          });
          await passUntil(page, delayedCast);
          await delayedCast.click();
          await passUntil(page, page.locator('.human-zone .life-badge').getByText('41'));
          await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
          await expect(page.locator('.log')).toContainText(/PR09 Pack Spell/);
          await expect(
            page.locator('.zone-card-thumb').filter({
              has: page.getByRole('img', { name: 'PR09 Pack Spell', exact: true }),
            }),
          ).toHaveCount(1);
        } else {
          await attack(page, cardName);
          await expect(
            page.getByRole('button', { name: /Cast PR09 Pack Spell without paying/i }),
          ).toHaveCount(0);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
        }
      } else if (id.startsWith('pr09-improvisation-capstone')) {
        await cast(page, cardName);
        if (id.endsWith('positive')) {
          await chooseCard(page, 'PR09 Capstone One', /Cast for free/i);
          await chooseCard(page, 'PR09 Capstone Two', /Cast for free/i);
          // Casting the last eligible card completes these choices without a Stop decision.
          const resolutions = page.locator('.log .line .text').filter({
            hasText: /^Improvisation Capstone resolves$/,
          });
          await expect(resolutions).toHaveCount(1);
          await passUntil(page, page.locator('.human-zone .life-badge').getByText('42'));
          await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
          await expect(page.locator('.decision-panel')).toContainText(
            /Paradigm.*copy|copy.*Capstone/i,
          );
          const castCopy = page.locator('.decision-panel').getByRole('button', {
            name: 'Cast',
            exact: true,
          });
          await passUntil(page, castCopy);
          await castCopy.click();
          // Decline the copy's revealed spells, then observe that copy resolve.
          await finishCapstoneChoices(page);
          await passStackUntil(page, resolutions.nth(1));
          await expect(resolutions).toHaveCount(2);
          await expect(
            page.locator('.human-zone .zone-card-thumb').filter({
              has: page.getByRole('img', { name: cardName, exact: true }),
            }),
          ).toHaveCount(1);
          await expect(page.locator('.log')).toContainText(/copy.*Improvisation Capstone/i);
          await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
        } else {
          await finishCapstoneChoices(page);
          const declineCopy = page.getByRole('button', { name: /Decline casting the copy/i });
          await passUntil(page, declineCopy);
          const capstoneCopiesInExile = page.locator('.human-zone .zone-card-thumb').filter({
            has: page.getByRole('img', { name: 'Improvisation Capstone', exact: true }),
          });
          await expect(capstoneCopiesInExile).toHaveCount(2);
          await declineCopy.click();
          await expect(declineCopy).toBeHidden();
          await expect(capstoneCopiesInExile).toHaveCount(1);
          await expect(page.locator('.log')).toContainText(/copy.*Improvisation Capstone/i);
          await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
        }
      }
    });
  }

  test.afterAll(() => {
    expect([...exercised].sort()).toEqual(PR09_CHOICE_SCENARIOS.map(({ id }) => id).sort());
  });
});
