import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import {
  hand,
  permanent,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { CASTING_STATICS_ALL_SCENARIOS } from '../../../packages/server/src/cards/casting-statics-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(120_000);

const titles = new Map(CASTING_STATICS_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil } = priorityHelpers(frontiers, 45_000, true);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing casting-statics title ${id}`);
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
const stackItem = (page: Page, name: string): Locator =>
  page.locator('.stack li').filter({ hasText: name });

/** Cast a hand card through the real payment panel, targeting the named opponent seats. */
async function cast(page: Page, name: string, seats: string[] = []): Promise<void> {
  const card = hand(page, name);
  await passUntil(page, card.and(page.locator('.actionable')));
  await card.click();
  await expect(confirmButton(page)).toBeVisible();
  for (const seat of seats) {
    const player = page.locator(`.opponent[data-seat="${seat}"]`);
    await expect(player).toHaveClass(/targetable/);
    await player.locator('header').click();
  }
  await confirmButton(page).click();
}

/** Answer the life-gain replacement order question by choosing which effect applies first. */
async function applyFirst(page: Page, source: string): Promise<void> {
  const panel = page.locator('.decision-panel');
  await expect(panel.getByText(/Choose which effect applies first to gaining 3 life/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel.locator('.panel-group')).toHaveCount(2);
  await panel
    .locator('.panel-group')
    .filter({ hasText: source })
    .getByRole('button', { name: 'Apply first', exact: true })
    .click();
}

test.describe('Casting statics and replacements viewer scenarios', () => {
  for (const { id } of CASTING_STATICS_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'casting-statics-vedalken-orrery-viewer-flash-response': async (page) => {
    // Pass with an empty stack until P2's Shock is on the stack, then answer it with a creature.
    await passUntil(page, stackItem(page, 'CS Lab Shock'));
    const bear = hand(page, 'CS Lab Bear');
    await expect(bear).toHaveClass(/actionable/);
    await bear.click();
    await confirmButton(page).click();
    await passStackUntil(page, permanent(page, 'P1', 'CS Lab Bear'));
    // The Bear resolved first; the Shock still resolves after it.
    await passStackUntil(page, life(page, 'P1').filter({ hasText: '38' }));
  },

  'casting-statics-thalia-guardian-of-thraben-viewer-noncreature-tax': async (page) => {
    await cast(page, 'CS Lab Shock', ['P2']);
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '38' }));
    // {1}{R}: both Mountains paid for the Shock.
    await expect(page.locator('.human-zone').getByText(/Lands \(2\) · 0 untapped/)).toBeVisible();
  },

  'casting-statics-torbran-thane-of-red-fell-viewer-plus-two': async (page) => {
    await cast(page, 'CS Lab Shock', ['P2']);
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '36' }));
  },

  'casting-statics-fiery-emancipation-viewer-triple': async (page) => {
    await cast(page, 'CS Lab Shock', ['P2']);
    await passStackUntil(page, life(page, 'P2').filter({ hasText: '34' }));
  },

  'casting-statics-knight-of-dawn-s-light-viewer-plus-first': async (page) => {
    await cast(page, 'CS Lab Salve');
    await passStackUntil(page, page.locator('.decision-panel'));
    await applyFirst(page, "Knight of Dawn's Light");
    await passUntil(page, life(page, 'P1').filter({ hasText: '48' }));
  },

  'casting-statics-rhox-faithmender-viewer-twice-first': async (page) => {
    await cast(page, 'CS Lab Salve');
    await passStackUntil(page, page.locator('.decision-panel'));
    await applyFirst(page, 'Rhox Faithmender');
    await passUntil(page, life(page, 'P1').filter({ hasText: '47' }));
  },

  'casting-statics-boon-reflection-viewer-payment-order': async (page) => {
    // At 1 life the Mending's 8 life is payable only through Pristine Talisman's 8-life gain,
    // which the payment applies itself: no order question reaches the viewer.
    await expect(life(page, 'P1')).toHaveText('1');
    const asked = page.locator('.decision-panel').getByText(/Choose which effect applies first/);
    await cast(page, 'CS Lab Mending');
    await passStackUntil(page, logLine(page, /CS Lab Mending resolves/));
    await expect(asked).toHaveCount(0);
    await expect(logLine(page, /gains 8 life/)).toBeVisible();
    await expect(logLine(page, /loses 8 life/)).toBeVisible();
    await expect(life(page, 'P1')).toHaveText('1');
    await expect(permanent(page, 'P1', 'Pristine Talisman').locator('.tile')).toHaveClass(/tapped/);
  },
};

test.afterAll(() =>
  expectLabCoverage(
    exercised,
    CASTING_STATICS_ALL_SCENARIOS.map(({ id }) => id),
  ),
);
