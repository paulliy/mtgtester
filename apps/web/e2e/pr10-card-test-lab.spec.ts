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
import { PR10_ALL_SCENARIOS } from '../../../packages/server/src/cards/pr10-scenario-catalog';

test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const titles = new Map(PR10_ALL_SCENARIOS.map(({ id, title }) => [id, title]));
const exercised = new Set<string>();
const frontiers = new WeakMap<Page, { requestId: string; stackSize: number }>();

const { passUntil, passStackUntil } = priorityHelpers(frontiers, 30_000);

async function runScenario(page: Page, id: string): Promise<void> {
  const title = titles.get(id);
  if (!title) throw new Error(`Missing PR10 title ${id}`);
  frontiers.set(page, observePriority(page));
  await selectScenario(page, id, title);
  expect(exercised.has(id), `${id} ran more than once`).toBe(false);
  exercised.add(id);
  await launchScenario(page, title);
}

const stackItem = (page: Page, name: string): Locator =>
  page.locator('.stack li').filter({ hasText: name }).first();
const life = (page: Page, seat: string): Locator =>
  page.locator(
    seat === 'P1' ? '.human-zone .life-badge' : `.opponent[data-seat="${seat}"] .life-badge`,
  );
const decisionButton = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('button', { name, exact: typeof name === 'string' });

/** Hand card is offered as an action on the real priority menu. */
async function expectCastable(page: Page, name: string, castable: boolean): Promise<void> {
  const card = hand(page, name);
  await expect(card).toBeVisible();
  if (castable) await expect(card).toHaveClass(/actionable/);
  else await expect(card).not.toHaveClass(/actionable/);
}

/** Start casting `name`, choosing `targets` (stack spells by name, or player seats) in order. */
async function startCast(page: Page, name: string, targets: string[] = []): Promise<void> {
  const card = hand(page, name);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  await expect(page.getByText(/Auto-pay|Pay with|Alternative/i).first()).toBeVisible();
  for (const target of targets) {
    if (/^P\d$/.test(target)) {
      const player = page.locator(`.opponent[data-seat="${target}"]`);
      await expect(player).toHaveClass(/targetable/);
      await player.locator('header').click();
    } else {
      await stackItem(page, target).click();
    }
  }
}
const confirm = (page: Page): Promise<void> =>
  page.getByRole('button', { name: 'Confirm', exact: true }).click();

async function cast(page: Page, name: string, targets: string[] = []): Promise<void> {
  await startCast(page, name, targets);
  await confirm(page);
}

/** P1 passes once so the scripted P2 casts Lab Shock at P3, then waits for it on the stack. */
async function waitForOpponentSpell(page: Page, name = 'PR10 Lab Shock'): Promise<Locator> {
  const spell = stackItem(page, name);
  await passUntil(page, spell);
  return spell;
}

/** Activate `ability` of `source` (a permanent), choosing `targets` (stack objects or seats). */
async function activate(
  page: Page,
  source: Locator,
  ability: RegExp,
  targets: string[] = [],
): Promise<void> {
  await expect(source).toBeVisible();
  await source.click();
  const action = page.getByRole('button').filter({ hasText: ability }).last();
  if (await action.isVisible()) await action.click();
  for (const target of targets) {
    if (/^P\d$/.test(target)) {
      const player = page.locator(`.opponent[data-seat="${target}"]`);
      await expect(player).toHaveClass(/targetable/);
      await player.locator('header').click();
    } else {
      await stackItem(page, target).click();
    }
  }
  await confirm(page);
}
/** Play a land from hand, then choose `seat` for the landfall trigger that asks for a target. */
async function playLandAndTarget(page: Page, land: string, seat: string): Promise<void> {
  const card = hand(page, land);
  await expect(card).toHaveClass(/actionable/);
  await card.click();
  const player = page.locator(`.opponent[data-seat="${seat}"]`);
  await expect(player).toHaveClass(/targetable/);
  await player.locator('header').click();
  await confirm(page);
}
/** Two identical triggers ask for an order; either choice is the same. */
async function orderTriggersIfAsked(page: Page, source: string): Promise<void> {
  const first = page.getByRole('button', { name: new RegExp(source) }).first();
  await passUntil(page, first);
  await first.click();
}
const logLine = (page: Page, text: string | RegExp): Locator =>
  page.locator('.log').getByText(text).first();

test.describe('PR10 stack, retarget and copy viewer scenarios', () => {
  for (const { id } of PR10_ALL_SCENARIOS) {
    test(id, async ({ page }) => {
      await runScenario(page, id);
      await scenarioFlows[id]!(page);
    });
  }
});

const scenarioFlows: Record<string, (page: Page) => Promise<void>> = {
  'pr10-deflecting-swat-viewer-positive': async (page) => {
    const shock = await waitForOpponentSpell(page);
    await cast(page, 'Deflecting Swat', ['PR10 Lab Shock']);
    await expect(decisionButton(page, 'Keep P3 as the target')).toBeVisible();
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('40');
    await expect(shock).toHaveCount(0);
  },
  'pr10-deflecting-swat-viewer-negative': async (page) => {
    await waitForOpponentSpell(page);
    await cast(page, 'Deflecting Swat', ['PR10 Lab Shock']);
    await decisionButton(page, 'Keep P3 as the target').click();
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(life(page, 'P4')).toHaveText('40');
  },
  'pr10-deflecting-swat-viewer-commander': async (page) => {
    await waitForOpponentSpell(page);
    const card = hand(page, 'Deflecting Swat');
    await expect(card).toHaveClass(/actionable/);
    await card.click();
    await expect(page.getByText('free', { exact: true })).toBeVisible();
    await stackItem(page, 'PR10 Lab Shock').click();
    await confirm(page);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('40');
  },
  'pr10-deflecting-swat-viewer-no-commander': async (page) => {
    await waitForOpponentSpell(page);
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Deflecting Swat', false);
  },

  'pr10-bolt-bend-viewer-positive': async (page) => {
    await waitForOpponentSpell(page);
    await cast(page, 'Bolt Bend', ['PR10 Lab Shock']);
    // The target must change: the current target is not offered.
    await expect(decisionButton(page, 'Target P3')).toHaveCount(0);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('40');
  },
  'pr10-bolt-bend-viewer-negative': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Twin Spell');
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Bolt Bend', false);
  },
  'pr10-bolt-bend-viewer-reduction': async (page) => {
    await waitForOpponentSpell(page);
    await startCast(page, 'Bolt Bend', ['PR10 Lab Shock']);
    await expect(page.getByText(/Auto-pay: Mountain(?! ×)/)).toBeVisible();
    await confirm(page);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
  },
  'pr10-bolt-bend-viewer-no-reduction': async (page) => {
    await waitForOpponentSpell(page);
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Bolt Bend', false);
  },

  'pr10-reverberate-viewer-positive': async (page) => {
    await waitForOpponentSpell(page);
    await cast(page, 'Reverberate', ['PR10 Lab Shock']);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('38');
  },
  'pr10-reverberate-viewer-negative': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Bear');
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Reverberate', false);
  },

  'pr10-flare-of-duplication-viewer-positive': async (page) => {
    await waitForOpponentSpell(page);
    await cast(page, 'Flare of Duplication', ['PR10 Lab Shock']);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('38');
  },
  'pr10-flare-of-duplication-viewer-negative': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Bear');
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Flare of Duplication', false);
  },
  'pr10-flare-of-duplication-viewer-sacrifice': async (page) => {
    await waitForOpponentSpell(page);
    const card = hand(page, 'Flare of Duplication');
    await expect(card).toHaveClass(/actionable/);
    await card.click();
    await expect(page.getByText('free', { exact: true })).toBeVisible();
    await stackItem(page, 'PR10 Lab Shock').click();
    await confirm(page);
    await expect(page.locator('.log')).toContainText(/sacrifices PR10 Lab Red Bear/);
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '38' }));
    await expect(life(page, 'P3')).toHaveText('38');
    await expect(page.locator('.log')).toContainText(/PR10 Lab Red Bear/);
  },
  'pr10-flare-of-duplication-viewer-no-sacrifice': async (page) => {
    await waitForOpponentSpell(page);
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expectCastable(page, 'Flare of Duplication', false);
    await expect(page.getByText('Cast for alternative cost')).toHaveCount(0);
  },

  'pr10-display-of-power-viewer-positive': async (page) => {
    await waitForOpponentSpell(page);
    await cast(page, 'PR10 Lab Zap', ['P2']);
    await cast(page, 'Display of Power');
    // Counted targets are chosen one at a time, earliest spell first.
    await decisionButton(page, 'Target PR10 Lab Shock (on the stack)').click();
    await decisionButton(page, 'Target PR10 Lab Zap (on the stack)').click();
    await decisionButton(page, 'Target P4').click();
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '37' }));
    await expect(life(page, 'P3')).toHaveText('38');
    await expect(life(page, 'P2')).toHaveText('39');
  },
  'pr10-display-of-power-viewer-negative': async (page) => {
    await cast(page, 'Display of Power');
    // No spell is on the stack, so there is nothing to target and the spell resolves alone.
    await passUntil(
      page,
      page
        .locator('.log')
        .getByText(/Display of Power resolves/i)
        .first(),
    );
    await expect(page.locator('.log')).not.toContainText(/Copy of/);
  },
  'pr10-display-of-power-viewer-cant-be-copied': async (page) => {
    await cast(page, 'Display of Power');
    await expect(stackItem(page, 'Display of Power')).toBeVisible();
    await cast(page, 'Reverberate', ['Display of Power']);
    await passUntil(
      page,
      page
        .locator('.log')
        .getByText(/Display of Power resolves/i)
        .first(),
    );
    await expect(page.locator('.log')).toContainText(/Reverberate resolves/);
    await expect(page.locator('.log')).not.toContainText(/Copy of Display of Power/);
  },

  'pr10-galvanic-iteration-viewer-positive': async (page) => {
    await cast(page, 'Galvanic Iteration');
    await passStackUntil(
      page,
      page
        .locator('.log')
        .getByText(/Galvanic Iteration resolves/i)
        .first(),
    );
    await cast(page, 'PR10 Lab Shock', ['P2']);
    await decisionButton(page, 'Target P3').click();
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(life(page, 'P2')).toHaveText('38');
  },
  'pr10-galvanic-iteration-viewer-negative': async (page) => {
    await cast(page, 'Galvanic Iteration');
    await passStackUntil(
      page,
      page
        .locator('.log')
        .getByText(/Galvanic Iteration resolves/i)
        .first(),
    );
    await cast(page, 'PR10 Lab Bear');
    await passStackUntil(
      page,
      page
        .locator('.log')
        .getByText(/PR10 Lab Bear resolves/i)
        .first(),
    );
    await expect(page.locator('.log')).not.toContainText(/Copy of/);
  },
  'pr10-galvanic-iteration-viewer-flashback': async (page) => {
    await decisionButton(page, 'Cast Galvanic Iteration').click();
    await expect(page.getByText('{1}{U}{R}').first()).toBeVisible();
    await confirm(page);
    await passStackUntil(
      page,
      page
        .locator('.log')
        .getByText(/Galvanic Iteration resolves/i)
        .first(),
    );
    await expect(
      seatZone(page, 'P1', 'Exile').getByRole('img', { name: 'Galvanic Iteration', exact: true }),
    ).toBeVisible();
  },

  'pr10-cosmic-crucible-viewer-mana': async (page) => {
    const split = decisionButton(page, /^Distribute 4 mana \(allowed: \{R\}/);
    await passUntil(page, split);
    await split.click();
    await expect(page.getByText('Floating 4R')).toBeVisible();
    await expect(page.getByText(/Mana ready 4/)).toBeVisible();
  },
  'pr10-cosmic-crucible-viewer-copy': async (page) => {
    await cast(page, 'PR10 Lab Shock', ['P2']);
    await passUntil(page, decisionButton(page, 'Copy PR10 Lab Shock'));
    await decisionButton(page, 'Copy PR10 Lab Shock').click();
    await decisionButton(page, 'Target P3').click();
    await passUntil(page, life(page, 'P3').filter({ hasText: '38' }));
    await expect(life(page, 'P2')).toHaveText('38');
  },
  'pr10-cosmic-crucible-viewer-once-each-turn': async (page) => {
    await cast(page, 'PR10 Lab Shock', ['P2']);
    await passUntil(page, decisionButton(page, 'Copy PR10 Lab Shock'));
    await decisionButton(page, 'Copy PR10 Lab Shock').click();
    await decisionButton(page, 'Target P3').click();
    await cast(page, 'PR10 Lab Zap', ['P2']);
    // The second trigger is offered no copy: only Lab Shock was ever copied this turn.
    await passUntil(page, life(page, 'P2').filter({ hasText: '37' }));
    await expect(life(page, 'P3')).toHaveText('38');
    await expect(page.locator('.log')).not.toContainText(/Copy of PR10 Lab Zap/);
    await expect(decisionButton(page, 'Copy PR10 Lab Zap')).toHaveCount(0);
  },
  'pr10-cosmic-crucible-viewer-negative': async (page) => {
    await cast(page, 'PR10 Lab Red Bear');
    await passStackUntil(
      page,
      page
        .locator('.log')
        .getByText(/PR10 Lab Red Bear resolves/i)
        .first(),
    );
    await expect(page.locator('.log')).not.toContainText(/Cosmic Crucible/);
  },

  'pr10-siren-stormtamer-viewer-counter-spell': async (page) => {
    await waitForOpponentSpell(page);
    await activate(
      page,
      permanent(page, 'P1', 'Siren Stormtamer'),
      /Counter target spell or ability/,
      ['PR10 Lab Shock'],
    );
    await passUntil(page, logLine(page, /countered/i));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(
      seatZone(page, 'P1', 'Graveyard').getByRole('img', { name: 'Siren Stormtamer', exact: true }),
    ).toBeVisible();
  },
  'pr10-siren-stormtamer-viewer-counter-ability': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Pinger');
    await activate(
      page,
      permanent(page, 'P1', 'Siren Stormtamer'),
      /Counter target spell or ability/,
      ['PR10 Lab Pinger'],
    );
    await passUntil(page, logLine(page, /countered/i));
    await expect(life(page, 'P1')).toHaveText('40');
    await expect(permanent(page, 'P1', 'PR10 Lab Bear')).toBeVisible();
    await expect(
      seatZone(page, 'P1', 'Graveyard').getByRole('img', { name: 'Siren Stormtamer', exact: true }),
    ).toBeVisible();
  },
  'pr10-siren-stormtamer-viewer-not-your-target': async (page) => {
    await waitForOpponentSpell(page);
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expect(permanent(page, 'P1', 'Siren Stormtamer')).not.toHaveClass(/actionable/);
  },

  'pr10-mana-sculpt-viewer-wizard': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Cinder');
    await cast(page, 'Mana Sculpt', ['PR10 Lab Cinder']);
    await passUntil(page, logLine(page, /countered/i));
    // The mana spent on Lab Cinder ({1}{R}) arrives at the beginning of the next main phase.
    await passUntil(page, page.getByText(/Floating/));
    await expect(page.getByText(/Mana ready 2/)).toBeVisible();
  },
  'pr10-mana-sculpt-viewer-no-wizard': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Cinder');
    await cast(page, 'Mana Sculpt', ['PR10 Lab Cinder']);
    await passUntil(page, logLine(page, /countered/i));
    // Nothing is added at the next main phase: the turn runs out with no mana in the pool.
    await passUntil(page, logLine(page, /game over/i));
    await expect(page.getByText(/Main phase 2/)).toBeVisible();
    await expect(page.getByText(/Floating/)).toHaveCount(0);
  },

  'pr10-mister-fantastic-viewer-copy-twice': async (page) => {
    await playLandAndTarget(page, 'Swamp', 'P2');
    await activate(
      page,
      permanent(page, 'P1', 'Mister Fantastic'),
      /Copy target triggered ability you control twice/,
      ['PR10 Lab Landfall Sparker'],
    );
    await decisionButton(page, 'Target P3').click();
    await decisionButton(page, 'Target P4').click();
    await passUntil(page, life(page, 'P4').filter({ hasText: '39' }));
    await expect(life(page, 'P2')).toHaveText('39');
    await expect(life(page, 'P3')).toHaveText('39');
  },
  'pr10-mister-fantastic-viewer-opponent-trigger': async (page) => {
    await waitForOpponentSpell(page, 'PR10 Lab Flash Sparker');
    await passUntil(page, stackItem(page, 'PR10 Lab Flash Sparker — When this creature enters'));
    await expectCastable(page, 'PR10 Lab Zap', true);
    await expect(permanent(page, 'P1', 'Mister Fantastic')).not.toHaveClass(/actionable/);
  },
  'pr10-mister-fantastic-viewer-combat-draw': async (page) => {
    await cast(page, 'PR10 Lab Zap', ['P2']);
    await passUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await passUntil(page, logLine(page, /Mister Fantastic.*draw/i));
    await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  },
  'pr10-mister-fantastic-viewer-combat-no-draw': async (page) => {
    await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
    await expect(page.locator('.log')).not.toContainText(/Mister Fantastic/);
  },

  'pr10-verrak-warped-sengir-viewer-pay-again': async (page) => {
    await activate(page, permanent(page, 'P1', 'PR10 Lab Bloodletter'), /Pay 2 life: Draw a card/);
    await passUntil(page, decisionButton(page, 'Pay 2 life'));
    await decisionButton(page, 'Pay 2 life').click();
    await passUntil(page, life(page, 'P1').filter({ hasText: '36' }));
    await passUntil(page, logLine(page, /Copy of PR10 Lab Bloodletter.*resolves/i));
  },
  'pr10-verrak-warped-sengir-viewer-decline': async (page) => {
    await activate(page, permanent(page, 'P1', 'PR10 Lab Bloodletter'), /Pay 2 life: Draw a card/);
    await passUntil(page, decisionButton(page, 'Decline'));
    await decisionButton(page, 'Decline').click();
    await passUntil(page, logLine(page, /PR10 Lab Bloodletter.*resolves/i));
    await expect(life(page, 'P1')).toHaveText('38');
    await expect(page.locator('.log')).not.toContainText(/Copy of/);
  },
  'pr10-verrak-warped-sengir-viewer-new-target': async (page) => {
    await activate(page, permanent(page, 'P1', 'PR10 Lab Blood Pinger'), /Pay 1 life: .* deals 1/, [
      'P2',
    ]);
    await passUntil(page, decisionButton(page, 'Pay 1 life'));
    await decisionButton(page, 'Pay 1 life').click();
    await decisionButton(page, 'Target P3').click();
    await passUntil(page, life(page, 'P3').filter({ hasText: '39' }));
    await passUntil(page, life(page, 'P2').filter({ hasText: '39' }));
    await expect(life(page, 'P1')).toHaveText('38');
  },
  'pr10-roaming-throne-viewer-chosen-type-doubles': async (page) => {
    await cast(page, 'Roaming Throne');
    await decisionButton(page, 'Elf').click();
    await cast(page, 'PR10 Lab Elf Healer');
    await orderTriggersIfAsked(page, 'PR10 Lab Elf Healer');
    await passUntil(page, life(page, 'P1').filter({ hasText: '46' }));
  },
  'pr10-roaming-throne-viewer-other-type': async (page) => {
    await cast(page, 'Roaming Throne');
    await decisionButton(page, 'Elf').click();
    await cast(page, 'PR10 Lab Bear Healer');
    await passUntil(page, life(page, 'P1').filter({ hasText: '43' }));
    await expect(page.locator('.log')).not.toContainText(/gain 3 life.*\n.*gain 3 life/s);
  },
  'pr10-annie-joins-up-viewer-enter-damage': async (page) => {
    await cast(page, 'Annie Joins Up');
    await passUntil(page, logLine(page, /PR10 Lab Brute dies|PR10 Lab Brute.*destroyed|dies/i));
    await expect(permanent(page, 'P3', 'PR10 Lab Brute')).toHaveCount(0);
    await expect(permanent(page, 'P1', 'PR10 Lab Bear')).toBeVisible();
  },
  'pr10-annie-joins-up-viewer-doubles-legendary': async (page) => {
    await cast(page, 'PR10 Lab Legend Healer');
    await orderTriggersIfAsked(page, 'PR10 Lab Legend Healer');
    await passUntil(page, life(page, 'P1').filter({ hasText: '46' }));
  },
  'pr10-annie-joins-up-viewer-nonlegendary': async (page) => {
    await cast(page, 'PR10 Lab Commoner Healer');
    await passUntil(page, life(page, 'P1').filter({ hasText: '43' }));
  },
  'pr10-verrak-warped-sengir-viewer-no-life': async (page) => {
    await activate(page, permanent(page, 'P1', 'PR10 Lab Scholar'), /Draw a card/);
    await passUntil(page, logLine(page, /PR10 Lab Scholar.*resolves/i));
    await expect(decisionButton(page, /^Pay \d+ life/)).toHaveCount(0);
    await expect(life(page, 'P1')).toHaveText('40');
  },
};

test.afterAll(() =>
  expect([...exercised].sort()).toEqual(PR10_ALL_SCENARIOS.map(({ id }) => id).sort()),
);
