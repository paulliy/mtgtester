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
