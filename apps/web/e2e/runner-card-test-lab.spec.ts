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
import { RUNNER_ALL_SCENARIOS } from '../../../packages/server/src/cards/runner-scenario-catalog';

/**
 * Viewer evidence for the scenarios the engine-test runner also drives (ADR 0034 decision 10).
 * The scenario files script every seat; here the viewer plays P1's steps by hand, and the other
 * seats answer their own steps as the server's scripted seats.
 */
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(RUNNER_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();
const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing runner scenario title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

const confirmButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Confirm', exact: true });
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'path-to-exile-search': async (page) => {
    const path = hand(page, 'Path to Exile');
    await passUntil(page, path.and(page.locator('.actionable')));
    await path.click();
    await expect(confirmButton(page)).toBeVisible();
    const bear = permanent(page, 'P2', 'Scenario Bear').first();
    await expect(bear).toHaveClass(/targetable|actionable/);
    await bear.click();
    await confirmButton(page).click();
    await passStackUntil(page, logLine(page, /Path to Exile[^]*resolves/));
    // P2 found a Plains, tapped, and Scenario Bear is in exile.
    await expect(permanent(page, 'P2', 'Scenario Bear')).toHaveCount(0);
    await expect(permanent(page, 'P2', 'Plains')).toHaveCount(1);
    await expect(
      seatZone(page, 'P2', 'Exile').getByRole('img', { name: 'Scenario Bear' }),
    ).toHaveCount(1);
  },
};

test.describe('Runner scenarios in the Card Test Lab', () => {
  for (const { id } of RUNNER_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      const flow = scenarioFlows[id];
      if (flow === undefined) throw new Error(`No viewer flow for runner scenario ${id}`);
      await runScenario(page, id);
      await flow(page);
    });
  }

  test.afterAll(() => {
    expect([...exercised].sort()).toEqual([...titles.keys()].sort());
  });
});
