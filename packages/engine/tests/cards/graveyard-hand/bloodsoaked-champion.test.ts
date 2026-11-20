/** Bloodsoaked Champion (graveyard and hand batch): scenarios in ../../scenarios/bloodsoaked-champion.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(
  new URL('../../scenarios/bloodsoaked-champion.json', import.meta.url),
);

describe('Bloodsoaked Champion', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('raid: the ability is offered only after an attack', () => {
    const offered = (id: string) =>
      (firstDecisionOf(file, { ...scenario(id), script: [] }, 'P1')?.legalActions ?? []).some(
        (action) => action.description.startsWith('Bloodsoaked Champion (graveyard)'),
      );
    expect(offered('bloodsoaked-champion-no-raid')).toBe(false);
  });
});
