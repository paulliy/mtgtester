/** Tervigon (evasion-and-blocking batch): scenarios in ../../scenarios/tervigon.json. */
import { describe, expect, it } from 'vitest';
import {
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/tervigon.json', import.meta.url));

describe('Tervigon', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;

  it('ravenous: the X choice is offered, and X=5 and X=4 differ only by the draw', () => {
    const decision = firstDecisionOf(file, { ...scenario(`tervigon-x5`), script: [] }, 'P1');
    const descriptions = decision?.legalActions.map((action) => action.description) ?? [];
    expect(descriptions.some((text) => text.endsWith('with X=5'))).toBe(true);
    expect(descriptions.some((text) => text.endsWith('with X=6'))).toBe(false);
    const drawn = (id: string) =>
      runScenario(file, scenario(id))
        .engine.getState()
        .players.find((p) => p.id === 'P1')!.hand.length;
    expect(drawn('tervigon-x5')).toBe(1);
    expect(drawn('tervigon-x4')).toBe(0);
  });
});
