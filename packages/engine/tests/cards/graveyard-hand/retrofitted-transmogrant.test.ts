/** Retrofitted Transmogrant (graveyard and hand batch): scenarios in ../../scenarios/retrofitted-transmogrant.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/retrofitted-transmogrant.json', import.meta.url),
);

describe('Retrofitted Transmogrant', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('the return ability is not offered from the hand or the battlefield', () => {
    for (const seat of [
      { hand: ['Retrofitted Transmogrant'] },
      { battlefield: ['Retrofitted Transmogrant'] },
    ]) {
      const decision = firstDecisionOf(
        file,
        {
          ...scenario('retrofitted-transmogrant-return'),
          seats: {
            P1: {
              ...seat,
              battlefield: [...(seat.battlefield ?? []), ...['Swamp', 'Swamp', 'Swamp', 'Swamp']],
            },
          },
          script: [],
        },
        'P1',
      );
      const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
      expect(
        descriptions.some((text) => text.includes('Return this card from your graveyard')),
      ).toBe(false);
    }
  });
});
