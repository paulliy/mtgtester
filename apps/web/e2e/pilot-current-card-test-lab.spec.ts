import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  hand,
  permanent,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { PILOT_CURRENT_ALL_SCENARIOS } from '../../../packages/server/src/cards/pilot-current-scenario-catalog';

/** Viewer evidence for the phase 6 pilot's current-workflow batch (`pilot-current`). */
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(PILOT_CURRENT_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();
const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing pilot-current title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

const life = (page: Page, seat: string): Locator =>
  page.locator(
    seat === 'P1' ? '.human-zone .life-badge' : `.opponent[data-seat="${seat}"] .life-badge`,
  );
const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

/** Cast a hand card that takes no target, confirm its payment, and wait for it to resolve. */
async function cast(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await confirmButton(page).click();
  await passStackUntil(page, logLine(page, new RegExp(`${name}[^]*resolves`)));
}

/** Play a land from hand and wait for it to leave the hand (the board groups same-name lands). */
async function playLand(page: Page, name: string): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  const play = page.getByRole('button', { name: /^Play/ });
  if ((await play.count()) > 0) await play.first().click();
  await expect(hand(page, name)).toHaveCount(0);
  await expect(permanent(page, 'P1', name).first()).toBeVisible();
}

const FLOWS: Record<string, (page: Page) => Promise<void>> = {
  'pilot-current-jet-medallion-viewer-reduced': async (page) => {
    await cast(page, 'Pilot Lab Black Sorcery');
    await expect(life(page, 'P1')).toHaveText('42');
    await expect(permanent(page, 'P1', 'Swamp').locator('.tap-badge')).toHaveCount(1);
  },
  'pilot-current-jet-medallion-viewer-not-red': async (page) => {
    // The free Trinket is castable, so P1 has priority; the red sorcery is not.
    await passUntil(page, hand(page, 'Pilot Lab Trinket').and(page.locator('.actionable')));
    await expect(hand(page, 'Pilot Lab Red Sorcery')).toBeVisible();
    await expect(hand(page, 'Pilot Lab Red Sorcery')).not.toHaveClass(/actionable/);
  },
  'pilot-current-great-henge-viewer-cast-reduced': async (page) => {
    await cast(page, 'The Great Henge');
    await expect(permanent(page, 'P1', 'The Great Henge')).toHaveCount(1);
  },
  'pilot-current-great-henge-viewer-enter-trigger': async (page) => {
    await cast(page, 'Pilot Lab Bear');
    await passStackUntil(page, permanent(page, 'P1', 'Pilot Lab Bear').filter({ hasText: '3/3' }));
    await expect(life(page, 'P1')).toHaveText('42');
    // The Trinket and the card drawn.
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(2);
  },
  'pilot-current-great-henge-viewer-token-ignored': async (page) => {
    await cast(page, 'Pilot Lab Saproling');
    await passStackUntil(page, permanent(page, 'P1', 'Saproling').filter({ hasText: '1/1' }));
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'pilot-current-great-henge-viewer-opponent-creature': async (page) => {
    // P2, a scripted seat, casts Pilot Lab Bear on its turn.
    await passStackUntil(page, permanent(page, 'P2', 'Pilot Lab Bear').filter({ hasText: '2/2' }));
    await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(1);
  },
  'pilot-current-explore-viewer-second-land': async (page) => {
    await playLand(page, 'Forest');
    await cast(page, 'Explore');
    await playLand(page, 'Plains');
    // Two lands played this turn: Island is not offered as a third.
    await expect(hand(page, 'Island')).toBeVisible();
    await expect(hand(page, 'Island')).not.toHaveClass(/actionable/);
  },
};

test.describe('pilot-current Card Test Lab scenarios', () => {
  for (const { id } of PILOT_CURRENT_ALL_SCENARIOS)
    test(id, async ({ page }) => {
      const flow = FLOWS[id];
      if (flow === undefined) throw new Error(`No viewer flow for ${id}`);
      await runScenario(page, id);
      await flow(page);
    });

  test.afterAll(() => {
    expect([...exercised].sort()).toEqual([...titles.keys()].sort());
  });
});
