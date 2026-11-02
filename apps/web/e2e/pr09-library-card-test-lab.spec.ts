import { expect, test, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import {
  hand,
  permanent,
  seatZone as zone,
  priorityHelpers,
  selectScenario,
  launchScenario,
  observePriority,
} from './pr09-viewer-helpers';
import { PR09_LIBRARY_SCENARIOS } from '../../../packages/server/src/cards/pr09-library-scenarios';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const titles = new Map(PR09_LIBRARY_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const stackSizes = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil, attack } = priorityHelpers(stackSizes, 30_000);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR09 library title ${id}`);
  stackSizes.set(page, observePriority(page));
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
  if (name === "Songbirds' Blessing") {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await permanent(page, 'P1', 'PR09 Library Host').click();
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function chooseGroup(page: Page, card: string, action: RegExp): Promise<void> {
  const choice = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: card })
    .getByRole('button', { name: action })
    .first();
  await passUntil(page, choice);
  await choice.click();
}
async function attackSongbirds(page: Page): Promise<void> {
  await cast(page, "Songbirds' Blessing");
  await passStackUntil(page, permanent(page, 'P1', "Songbirds' Blessing"));
  await attack(page, 'PR09 Library Host');
}

test.describe('PR09 library and reveal viewer scenarios', () => {
  for (const { id, cardName } of PR09_LIBRARY_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      if (id === 'pr09-mystic-forge-viewer-positive') {
        await cast(page, 'Mystic Forge');
        // The server names the card it offers (ADR 0032), not its object id.
        const topCardCast = page.getByRole('button', { name: /^Cast PR09 Forge Artifact\b/ });
        await passStackUntil(page, topCardCast);
        await topCardCast.click();
        await expect(page.getByText(/Auto-pay/)).toBeVisible();
        await page.getByRole('button', { name: 'Confirm', exact: true }).click();
        await passStackUntil(page, permanent(page, 'P1', 'PR09 Forge Artifact'));
        await expect(page.locator('.log')).toContainText('PR09 Forge Artifact');
      } else if (id === 'pr09-mystic-forge-viewer-negative') {
        await expect(page.getByRole('img', { name: 'Mystic Forge', exact: true })).toBeVisible();
        await expect(
          page.getByRole('img', { name: 'PR09 Forge Colored Spell', exact: true }),
        ).toBeVisible();
        await expect(permanent(page, 'P1', 'PR09 Forge Colored Spell')).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: /^Cast PR09 Forge Colored Spell\b/ }),
        ).toHaveCount(0);
      } else if (id === 'pr09-mystic-forge-viewer-activation') {
        const forge = permanent(page, 'P1', 'Mystic Forge');
        await forge.click();
        await page.getByRole('button', { name: 'Confirm', exact: true }).click();
        await passStackUntil(page, zone(page, 'P1', 'Exile'));
        await expect(forge).toContainText('TAP');
        await expect(
          zone(page, 'P1', 'Exile').getByRole('img', { name: 'PR09 Forge Artifact', exact: true }),
        ).toBeVisible();
        await expect(page.locator('.human-zone .life-badge')).toHaveText('39');
      } else if (id.startsWith('pr09-songbirds-blessing')) {
        await attackSongbirds(page);
        if (id.endsWith('positive')) {
          const putAura = page.getByRole('button', { name: 'Put onto battlefield', exact: true });
          await expect(putAura).toBeVisible();
          await putAura.click();
          await expect(permanent(page, 'P1', 'PR09 Library Aura')).toBeVisible();
          await expect(page.locator('.log')).toContainText(/reveals PR09 Library Aura/i);
        } else {
          await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 30_000 });
          await expect(permanent(page, 'P1', 'PR09 Library Aura')).toHaveCount(0);
        }
      } else if (id === 'pr09-etali-primal-conqueror-etali-primal-sickness-viewer-transform') {
        const etali = permanent(page, 'P1', 'Etali, Primal Conqueror');
        await etali.click();
        await expect(page.getByText(/Auto-pay/)).toBeVisible();
        await page.getByRole('button', { name: 'Confirm', exact: true }).click();
        await passStackUntil(page, permanent(page, 'P1', 'Etali, Primal Sickness'));
        await expect(permanent(page, 'P1', 'Etali, Primal Sickness')).toContainText(
          'indestructible',
        );
        await attack(page, 'Etali, Primal Sickness');
        await passUntil(
          page,
          page.locator('.opponent[data-seat="P2"] [aria-label="Global counters"]', {
            hasText: /POISON\s*11/,
          }),
        );
        await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('29');
      } else if (id.startsWith('pr09-etali')) {
        await cast(page, cardName);
        await expect(permanent(page, 'P1', 'Etali, Primal Conqueror')).toContainText('trample');
        if (id.endsWith('positive')) {
          const freeCasts = page.getByRole('button', { name: 'Cast for free', exact: true });
          await passStackUntil(page, freeCasts.first());
          await expect(freeCasts).toHaveCount(4);
          await freeCasts.first().click();
          await expect(page.locator('.log')).toContainText(/PR09 Library Spell/);
        } else {
          await expect(page.locator('.log')).toContainText(/Etali, Primal Conqueror resolves/);
          await expect(zone(page, 'P1', 'Exile')).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Cast for free', exact: true }),
          ).toHaveCount(0);
        }
      } else if (id.startsWith('pr09-sunbirds-invocation')) {
        await cast(page, cardName);
        await passStackUntil(page, permanent(page, 'P1', "Sunbird's Invocation"));
        await cast(page, 'PR09 Library Spell');
        if (id.endsWith('positive')) {
          const freeCast = page
            .locator('.decision-panel')
            .getByRole('button', { name: 'Cast', exact: true });
          await passUntil(page, freeCast);
          await freeCast.click();
          await passStackUntil(page, page.locator('.human-zone .life-badge', { hasText: '42' }));
        } else {
          await passStackUntil(page, page.locator('.human-zone .life-badge', { hasText: '41' }));
        }
      } else if (id.startsWith('pr09-minds-dilation')) {
        if (id.endsWith('positive')) {
          const freeCast = page
            .locator('.decision-panel')
            .getByRole('button', { name: 'Cast', exact: true });
          await passUntil(page, freeCast);
          await freeCast.click();
          await passStackUntil(page, page.locator('.human-zone .life-badge', { hasText: '41' }));
        } else {
          const p2LostNoLife = page.locator('.opponent[data-seat="P2"] .life-badge', {
            hasText: '41',
          });
          await passUntil(page, p2LostNoLife);
          await expect(page.locator('.human-zone .life-badge')).toHaveText('40');
        }
      } else if (id.startsWith('pr09-expressive-iteration')) {
        await cast(page, cardName);
        await passStackUntil(page, page.getByText(/choose a card to put into your hand/i));
        await chooseGroup(
          page,
          id.endsWith('positive') ? 'PR09 Library Spell' : 'PR09 Library Miss',
          /^Put into hand$/,
        );
        await chooseGroup(
          page,
          id.endsWith('positive') ? 'PR09 Library Aura' : 'PR09 Library Miss',
          /^Put on bottom$/,
        );
        await expect(
          hand(page, id.endsWith('positive') ? 'PR09 Library Spell' : 'PR09 Library Miss'),
        ).toBeVisible();
        await expect(
          zone(page, 'P1', 'Exile').getByRole('img', { name: 'PR09 Library Miss', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: /Cast PR09 Library Miss/ })).toHaveCount(0);
      } else if (id.startsWith('pr09-genesis-ultimatum')) {
        await cast(page, cardName);
        await passStackUntil(page, page.getByText(/choose any number of permanents/i));
        if (id.endsWith('positive')) {
          await chooseGroup(page, 'PR09 Genesis Creature', /^Choose$/);
          await chooseGroup(page, 'PR09 Genesis Artifact', /^Choose$/);
          await page.getByRole('button', { name: /^Done$/ }).click();
          await expect(permanent(page, 'P1', 'PR09 Genesis Creature')).toBeVisible();
          await expect(permanent(page, 'P1', 'PR09 Genesis Artifact')).toBeVisible();
          await expect(hand(page, 'PR09 Library Spell')).toBeVisible();
        } else {
          await page.getByRole('button', { name: 'Done', exact: true }).click();
          await expect(hand(page, 'PR09 Library Miss')).toHaveCount(5);
          await expect(permanent(page, 'P1', 'PR09 Genesis Creature')).toHaveCount(0);
        }
        await expect(
          zone(page, 'P1', 'Exile').getByRole('img', { name: 'Genesis Ultimatum', exact: true }),
        ).toBeVisible();
      } else if (id.startsWith('pr09-into-the-time-vortex')) {
        await cast(page, cardName);
        if (id.endsWith('positive')) {
          const cascadeCast = page.getByRole('button', {
            name: /Cast PR09 Library Spell without paying/i,
          });
          await passUntil(page, cascadeCast);
          await cascadeCast.click();
          await expect(page.locator('.log')).toContainText(/PR09 Library Spell/);
          const rebound = page.getByRole('button', {
            name: /Cast Into the Time Vortex without paying/i,
          });
          await passUntil(page, rebound);
          await rebound.click();
          await expect(page.locator('.log')).toContainText(/Rebound/);
        } else {
          await expect(page.locator('.log')).toContainText(/Into the Time Vortex/);
        }
      }
    });
  }
});

test.afterAll(() =>
  expectLabCoverage(
    exercised,
    PR09_LIBRARY_SCENARIOS.map(({ id }) => id),
  ),
);
