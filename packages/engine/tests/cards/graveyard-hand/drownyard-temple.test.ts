/** Drownyard Temple (graveyard and hand batch): scenarios in ../../scenarios/drownyard-temple.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/drownyard-temple.json', import.meta.url));

describe('Drownyard Temple', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('the return ability is not offered from the hand or the battlefield', () => {
    for (const seat of [{ hand: ['Drownyard Temple'] }, { battlefield: ['Drownyard Temple'] }]) {
      const decision = firstDecisionOf(
        file,
        {
          ...scenario('drownyard-temple-return'),
          seats: {
            P1: {
              ...seat,
              battlefield: [...(seat.battlefield ?? []), ...['Island', 'Island', 'Island']],
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
