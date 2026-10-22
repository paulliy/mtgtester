import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';
import { PR09_PERMANENT_SCENARIOS } from '../../../packages/server/src/cards/pr09-permanent-scenarios';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const titles = new Map(PR09_PERMANENT_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

async function start(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR09 permanent scenario ${id}`);
  const frontier = { requestId: '', stackSize: 0 };
  frontiers.set(page, frontier);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired') {
          frontier.requestId = frame.payload.request.requestId;
          frontier.stackSize = frame.payload.request.state.stack.length;
        } else if (frame.type === 'playerStateSnapshot')
          frontier.stackSize = frame.payload.state.stack.length;
      } catch {
        /* Ignore unrelated frames. */
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
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
function seatZone(page: Page, seat: string, name: string): Locator {
  const area = seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`;
  return page
    .locator(`${area} .zone`)
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^${name} \\(`) }) });
}
async function cast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target \d+ of \d+/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function castFromExile(page: Page, name: string): Promise<void> {
  const seat = page.locator('.human-zone');
  const toggle = seat.getByRole('button', { name: /zones/i });
  if (await toggle.isVisible()) await toggle.click();
  const exiled = seatZone(page, 'P1', 'Exile')
    .locator('.zone-card-thumb.actionable')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
  await expect(exiled).toBeVisible();
  await exiled.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function castTargetingStack(page: Page, name: string, targetName: string): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const target = page.locator('.stack li').filter({ hasText: targetName });
  await expect(target).toHaveClass(/targetable/);
  await target.click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function castTargetingPermanent(
  page: Page,
  name: string,
  seat: string,
  targetName: string,
): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  const target = permanent(page, seat, targetName);
  await expect(target).toHaveClass(/targetable|actionable/);
  await target.click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function activate(page: Page, source: Locator, ability: RegExp): Promise<void> {
  await expect(source).toBeVisible();
  await source.click();
  const action = page.getByRole('button').filter({ hasText: ability }).last();
  await expect(action).toBeVisible();
  await action.click();
  if ((await page.getByText(/Target \d+ of \d+/).count()) === 0) {
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    if ((await confirm.isVisible()) && (await confirm.isEnabled())) await confirm.click();
  }
}
async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if ((await pass.isVisible()) && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}
async function passUntilText(locator: Locator, expected: string): Promise<void> {
  const page = locator.page();
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if ((await locator.textContent())?.replace(/\s/g, '') === expected) return true;
        if ((await pass.isVisible()) && (await pass.isEnabled()))
          await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}
async function passStackUntil(page: Page, target: Locator): Promise<void> {
  const frontier = frontiers.get(page)!;
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  let submitted = '';
  await expect
    .poll(
      async () => {
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
      { timeout: 30_000 },
    )
    .toBe(true);
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
async function castFree(page: Page, name: string): Promise<void> {
  const action = page.getByRole('button', { name: new RegExp(`Cast ${name} without paying`, 'i') });
  if (await action.isVisible()) {
    await passUntil(page, action);
    await action.click();
  } else {
    const lookedCard = page
      .locator('.decision-panel .panel-group')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Cast', exact: true });
    await passUntil(page, lookedCard);
    await lookedCard.click();
  }
}

test.describe('PR09 permanent Card Test Lab scenarios', () => {
  for (const { id, cardName } of PR09_PERMANENT_SCENARIOS) {
    test(id, async ({ page }) => {
      await start(page, id);
      if (id.startsWith('pr09-dark-confidant')) {
        if (id.endsWith('positive')) {
          await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
          await expect(hand(page, 'PR09 Viewer Spell')).toBeVisible();
          await expect(page.locator('.log')).toContainText(/reveals PR09 Viewer Spell/i);
        } else {
          await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
        }
      } else if (id.startsWith('pr09-dream-pillager')) {
        if (id.endsWith('positive')) {
          await expect(permanent(page, 'P1', cardName)).toContainText(/flying/i);
          await attack(page, cardName);
          await castFromExile(page, 'PR09 Viewer Spell');
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
          await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
        } else {
          await expect(permanent(page, 'P1', cardName)).toBeVisible();
          await attack(page, cardName);
          await expect(
            page.getByRole('button', { name: /Cast PR09 Viewer Spell without paying/i }),
          ).toHaveCount(0);
          await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('36');
        }
      } else if (id.startsWith('pr09-aetherworks-marvel')) {
        const marvel = permanent(page, 'P1', cardName);
        if (id.endsWith('negative')) {
          await expect(marvel).toBeVisible();
          await marvel.click();
          await expect(
            page.locator('.source-actions button').filter({ hasText: /top six cards/i }),
          ).toHaveCount(0);
        } else if (id.endsWith('activation') || id.endsWith('positive')) {
          if (id.endsWith('positive')) {
            await castTargetingPermanent(
              page,
              'PR09 Viewer Artifact Removal',
              'P1',
              'PR09 Viewer Sacrifice Artifact',
            );
            await passUntilText(
              page.locator('.human-zone [aria-label="Global counters"]'),
              'ENERGY6',
            );
            await expect(
              seatZone(page, 'P1', 'Graveyard').getByRole('img', {
                name: 'PR09 Viewer Sacrifice Artifact',
                exact: true,
              }),
            ).toBeVisible();
          }
          if (id.endsWith('activation')) {
            await activate(page, marvel, /top six cards/i);
            await castFree(page, 'PR09 Viewer Spell');
            await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
          }
        } else {
          await expect(marvel).toBeVisible();
        }
      } else if (id.startsWith('pr09-herald-of-amity')) {
        if (id.endsWith('attack')) {
          await attack(page, cardName);
          await expect(permanent(page, 'P1', cardName).locator('.pt')).toHaveText(/3\/3/);
        } else {
          await cast(page, cardName);
          await passStackUntil(page, permanent(page, 'P1', cardName));
          await expect(permanent(page, 'P1', cardName)).toContainText(/flying/i);
          if (id.endsWith('positive')) {
            await castFree(page, 'PR09 Viewer Aura');
            await expect(
              page.getByRole('button', { name: 'Cast PR09 Viewer Aura', exact: true }).first(),
            ).toBeVisible();
            await page
              .getByRole('button', { name: 'Cast PR09 Viewer Aura', exact: true })
              .first()
              .click();
            await passStackUntil(page, permanent(page, 'P1', 'PR09 Viewer Aura'));
            await expect(page.locator('.log')).toContainText(/PR09 Viewer Aura/);
          } else {
            await expect(
              page.getByRole('button', { name: /Cast PR09 Aura Creature without paying/i }),
            ).toHaveCount(0);
            await expect(permanent(page, 'P1', 'PR09 Aura Creature')).toHaveCount(0);
          }
        }
      } else if (id.startsWith('pr09-cosmic-cube')) {
        await expect(permanent(page, 'P1', cardName)).toBeVisible();
        if (id.endsWith('positive')) {
          await attack(page, 'PR09 Viewer Creature');
          await castFree(page, 'PR09 Viewer Spell');
          await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
        } else {
          await attack(page, 'PR09 Viewer Creature');
          await expect(
            page.getByRole('button', { name: /Cast PR09 Viewer Spell without paying/i }),
          ).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-franklin-richards')) {
        await cast(page, 'PR09 Viewer Spell');
        if (id.endsWith('positive')) {
          await castFree(page, 'PR09 Viewer Discover Hit');
          await expect(page.locator('.log')).toContainText(/PR09 Viewer Discover Hit/);
        } else {
          await expect(
            page.getByRole('button', { name: /Cast PR09 Viewer Discover Hit without paying/i }),
          ).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-monstrous-vortex')) {
        await cast(page, 'PR09 Viewer Creature');
        if (id.endsWith('positive')) {
          await castFree(page, 'PR09 Viewer Spell');
          await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
        } else {
          await expect(
            page.getByRole('button', { name: /Cast PR09 Viewer Spell without paying/i }),
          ).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-chimil-the-inner-sun')) {
        await expect(permanent(page, 'P1', cardName)).toBeVisible();
        await cast(page, 'PR09 Viewer Instant');
        await castTargetingStack(page, 'PR09 Viewer Counter', 'PR09 Viewer Instant');
        await passUntilText(page.locator('.human-zone .life-badge'), '42');
        await expect(page.locator('.log')).toContainText(/PR09 Viewer Instant resolves/i);
        if (id.endsWith('positive')) {
          await castFree(page, 'PR09 Viewer Spell');
          await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
        } else {
          await expect(
            page.getByRole('button', { name: /Cast PR09 Viewer Spell without paying/i }),
          ).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-trumpeting-carnosaur')) {
        if (id.endsWith('discard')) {
          const carnosaur = hand(page, cardName);
          await activate(page, carnosaur, /discard a card/i);
          const target = permanent(page, 'P2', 'PR09 Viewer Creature');
          await expect(target).toHaveClass(/targetable/);
          await target.click();
          await page.getByRole('button', { name: 'Confirm', exact: true }).click();
          await expect(
            seatZone(page, 'P2', 'Graveyard').getByRole('img', {
              name: 'PR09 Viewer Creature',
              exact: true,
            }),
          ).toBeVisible();
        } else {
          await cast(page, cardName);
          await passStackUntil(page, permanent(page, 'P1', cardName));
          await expect(permanent(page, 'P1', cardName)).toContainText(/trample/i);
          if (id.endsWith('positive')) {
            await castFree(page, 'PR09 Viewer Spell');
            await expect(page.locator('.log')).toContainText(/PR09 Viewer Spell/);
          } else {
            await expect(
              page.getByRole('button', { name: /Cast PR09 Viewer Spell without paying/i }),
            ).toHaveCount(0);
          }
        }
      } else {
        throw new Error(`Uncovered PR09 permanent scenario ${id}`);
      }
    });
  }
});
