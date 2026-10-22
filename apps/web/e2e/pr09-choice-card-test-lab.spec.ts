import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR09_CHOICE_SCENARIOS } from '../../../packages/server/src/cards/pr09-choice-scenarios';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PR09_CHOICE_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<
  Page,
  { requestId: string; stackSize: number; decidingPlayer: string }
>();

async function start(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR09 choice scenario ${id}`);
  const frontier = { requestId: '', stackSize: 0, decidingPlayer: '' };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired') {
          frontier.requestId = frame.payload.request.requestId;
          frontier.stackSize = frame.payload.request.state.stack.length;
          frontier.decidingPlayer = frame.payload.request.decidingPlayer;
        } else if (frame.type === 'playerStateSnapshot')
          frontier.stackSize = frame.payload.state.stack.length;
      } catch {
        /* Ignore non-JSON websocket frames. */
      }
    }),
  );
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await picker.selectOption({ label: title });
  expect(await picker.inputValue()).toBe(id);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function hand(page: Page, name: string): Locator {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}
function permanent(page: Page, seat: string, name: string): Locator {
  const zone = seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`;
  return page
    .locator(`${zone} .object:not(.board-card-leave-active)`)
    .filter({ has: page.getByRole('img', { name, exact: true }) })
    .first();
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
async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const reminder = page.getByRole('button', { name: 'Pass anyway', exact: true });
  await expect
    .poll(
      async () => {
        if (await reminder.isVisible()) await reminder.click();
        if (await target.isVisible()) return true;
        if ((await pass.isVisible()) && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 40_000 },
    )
    .toBe(true);
}
async function passStackUntil(page: Page, target: Locator): Promise<void> {
  const frontier = frontiers.get(page)!;
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  const reminder = page.getByRole('button', { name: 'Pass anyway', exact: true });
  let submitted = '';
  await expect
    .poll(
      async () => {
        if (await reminder.isVisible()) await reminder.click();
        if (await target.isVisible()) return true;
        if (
          frontier.stackSize > 0 &&
          frontier.requestId !== submitted &&
          (await pass.isVisible()) &&
          (await pass.isEnabled())
        ) {
          submitted = frontier.requestId;
          await pass.click();
        }
        return false;
      },
      { timeout: 40_000 },
    )
    .toBe(true);
}
async function passUntilStackCard(page: Page, name: string): Promise<Locator> {
  const target = page.locator('.stack li').filter({ hasText: name }).first();
  await passStackUntil(page, target);
  return target;
}
async function attack(page: Page, attacker: string): Promise<void> {
  const declare = page.getByRole('button', { name: /Declare attackers/ });
  await passUntil(page, declare);
  await declare.click();
  await page
    .locator('.combat-assignment-row')
    .filter({ hasText: attacker })
    .getByRole('button', { name: 'P2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
}
async function chooseCard(page: Page, name: string, action: RegExp): Promise<void> {
  const button = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: name })
    .getByRole('button', { name: action })
    .first();
  await passUntil(page, button);
  await button.click();
}
async function chooseAction(page: Page, action: RegExp): Promise<void> {
  const button = page.getByRole('button', { name: action }).first();
  await passUntil(page, button);
  await button.click();
}
async function orderCelebrateTriggers(page: Page): Promise<void> {
  // Put the exile trigger on the stack first so Recruit is on top and resolves first.
  await chooseAction(page, /Celebrate the Mountain-king: For each opponent, exile/);
  await chooseAction(page, /Celebrate the Mountain-king: Recruit:/);
}
async function castFree(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`Cast ${name} without paying`, 'i') });
  await passUntil(page, button);
  await button.click();
}
async function passUntilSourceLeaves(page: Page, sourceName: string): Promise<void> {
  const source = permanent(page, 'P1', sourceName);
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if ((await source.count()) === 0) return true;
        if ((await pass.isVisible()) && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
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
          await chooseCard(page, 'PR09 Sneak Attacker', /return.*hand/i);
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
            await chooseCard(page, 'PR09 Celebrate Target', /Exile/i);
            await expect(page.locator('.log')).toContainText(/PR09 Celebrate Target.*exil/i);
            await expect(permanent(page, 'P1', cardName)).toBeVisible();
            await expect(permanent(page, 'P2', 'PR09 Celebrate Target')).toHaveCount(0);
            await passUntilSourceLeaves(page, cardName);
            await expect(permanent(page, 'P2', 'PR09 Celebrate Target')).toBeVisible();
          } else {
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
          await expect(page.locator('.log')).toContainText(/Cast PR09 Rabble Hidden/);
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
          await expect(target).toHaveClass(/targetable/);
          await target.click();
          await expect(page.locator('.log')).toContainText(/goad/i);
          await expect(target).toBeVisible();
        } else if (id.endsWith('positive')) {
          await attack(page, 'PR09 Path Creature');
          await chooseAction(page, /Exile their top card/i);
          const revealed = page
            .locator('.zone-card-thumb.actionable')
            .filter({ has: page.getByRole('img', { name: 'PR09 Grenzo Reveal', exact: true }) });
          await expect(revealed).toBeVisible();
          await revealed.click();
          await expect(page.locator('.log')).toContainText(/Cast PR09 Grenzo Reveal/);
        } else {
          await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
          await page.getByRole('button', { name: /Declare attackers/ }).click();
          await page.getByRole('button', { name: /Confirm attacks/ }).click();
          await expect(
            page.getByRole('button', { name: /Cast PR09 Grenzo Reveal without paying/i }),
          ).toHaveCount(0);
          await expect(page.locator('.human-zone')).not.toContainText(/Exile \(1\)/i);
        }
      } else if (id.startsWith('pr09-power-pack')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        if (id.endsWith('positive')) {
          await attack(page, cardName);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
          const castSpell = page.getByRole('button', {
            name: /Cast PR09 Pack Spell without paying/i,
          });
          await passUntil(page, castSpell);
          await castSpell.click();
          await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
          await expect(page.locator('.log')).toContainText(/PR09 Pack Spell/);
          await expect(page.locator('.zone-card-thumb').filter({
            has: page.getByRole('img', { name: 'PR09 Pack Spell', exact: true }),
          })).toHaveCount(1);
        } else {
          await attack(page, cardName);
          await expect(
            page.getByRole('button', { name: /Cast PR09 Pack Spell without paying/i }),
          ).toHaveCount(0);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
        }
      } else if (id.startsWith('pr09-improvisation-capstone')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', cardName));
        if (id.endsWith('positive')) {
          await chooseCard(page, 'PR09 Capstone One', /Cast for free/i);
          await chooseCard(page, 'PR09 Capstone Two', /Cast for free/i);
          await expect(page.locator('.human-zone .life-badge')).toHaveText('42');
          await page.getByRole('button', { name: 'Stop', exact: true }).click();
          await passUntil(page, page.getByRole('button', { name: /Cast.*Improvisation Capstone.*copy/i }));
          await page.getByRole('button', { name: /Cast.*Improvisation Capstone.*copy/i }).click();
          await expect(page.locator('.log')).toContainText(/card copy|copy.*Improvisation Capstone/i);
          await expect(page.locator('.human-zone .life-badge')).toHaveText('43');
        } else {
          await page.getByRole('button', { name: 'Stop', exact: true }).click();
          const copy = page.getByRole('button', { name: /Cast.*Improvisation Capstone.*copy/i });
          await passUntil(page, copy);
          await copy.click();
          await expect(page.locator('.human-zone .life-badge')).toHaveText('41');
        }
      }
    });
  }
});
